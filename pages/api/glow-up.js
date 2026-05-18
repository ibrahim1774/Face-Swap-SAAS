import { put } from '@vercel/blob';

import { getUserFromRequest, getSupabaseAdmin } from '../../lib/supabaseServer';
import { stripe } from '../../lib/stripe';
import { sendCapiEvent } from '../../lib/meta';
import { KEY, nsEventId } from '../../lib/metaKeys';
import { screenText, screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

/*
 * Glow-Up generation endpoint.
 *
 * Architecture choices:
 *   - Auth: Supabase via getUserFromRequest (matches every other API
 *     route in the project; no NextAuth dependency).
 *   - Entitlement: read directly from Stripe customer metadata. We do
 *     NOT modify lib/entitlement.js. This route maintains its own
 *     IMAGE credit pool (`imageCreditsRemaining` + `imagePeriodStart`)
 *     on the same Stripe customer object — kept strictly separate
 *     from the existing video credit pool (`creditsRemaining`) used
 *     by face-swap / UGC / image-to-video. The two pools never mix.
 *     If image credits run out, the user must wait for refill (or
 *     top up — separate image top-up packs are not yet wired in).
 *   - Pool refill: 30 image credits every 30 days for any active sub
 *     (monthly OR yearly). Yearly users effectively get 30 fresh
 *     image credits each rolling month.
 *   - Image gen: kie.ai's GPT-4o image endpoint
 *     (POST /api/v1/gpt4o-image/generate, polled via record-info).
 *     filesUrl accepts up to 5 reference URLs, so all 1–4 user photos
 *     are passed in unchanged — no multipart upload needed since the
 *     photos already live on Vercel Blob.
 *   - Output: kie.ai returns a CDN URL; we download it and re-upload
 *     to Vercel Blob via put() so the user gets a stable URL on our
 *     infra (and the download button keeps working long-term).
 *
 * GET returns the user's current glow-up credit status (used by the
 * page UI to show the remaining counter).
 * POST runs the full generation flow.
 */

const PERIOD_DAYS = 30;
const CREDITS_PER_PERIOD = 30;
const PERIOD_MS = PERIOD_DAYS * 24 * 60 * 60 * 1000;

const KIE_BASE = 'https://api.kie.ai/api/v1';
const KIE_GENERATE_PATH = '/gpt4o-image/generate';
const KIE_RECORD_PATH = '/gpt4o-image/record-info';

// Max time we'll block the request waiting for kie.ai to finish.
// 4o-image jobs typically resolve in 15–45s; cap at 120s so we don't
// approach Vercel's 300s function ceiling.
const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120 * 1000;

// Prompt the model receives in 'edit' mode. The first imageUrl in
// filesUrl is the previously-generated portrait — kie.ai/4o treats
// earlier files as the primary edit subject — and the rest are the
// user's original reference photos for identity anchoring.
const EDIT_PROMPT_PREFIX =
  "You are given the most recent AI-generated portrait of a person, followed by reference photos of the same person. CRITICAL: Keep the person's face, facial structure, skin tone, eye color, and identity absolutely identical to the references — do NOT alter the face. Apply the following user-requested edit while preserving the realism, lighting quality, and overall premium portrait look:";

// Sanitize and truncate user-provided text before injecting it into a
// prompt sent to the model. Strips control chars, collapses whitespace,
// and caps length so a hostile or runaway input can't blow out the
// total prompt size.
function safePromptFragment(s, max = 400) {
  if (typeof s !== 'string') return '';
  // Filter ASCII control chars (0-31, 127) by codepoint instead of a
  // regex literal to keep the source ASCII-clean. Collapses whitespace
  // and caps length so user input can't bloat the kie.ai prompt.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 32 || c === 127 ? ' ' : s[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

const PROMPTS = {
  professional:
    "You are given reference photos of a person. Generate an ultra-realistic 4K professional corporate headshot. CRITICAL: Keep the person's face, facial structure, skin tone, eye color, and identity absolutely identical. Apply: soft studio lighting with a 45-degree key light and subtle fill, clean neutral background slightly blurred, professional business attire, ultra-sharp focus on eyes, 85mm portrait lens perspective, eye-level shot. Must look like it was shot by a professional photographer for a Fortune 500 LinkedIn profile.",
  casual:
    "You are given reference photos of a person. Generate an ultra-realistic lifestyle portrait. CRITICAL: Keep the person's face, facial structure, skin tone, eye color, and identity absolutely identical. Apply: warm natural light or golden hour lighting, smart-casual clothing, clean blurred lifestyle background, genuine relaxed expression. Should feel authentic and approachable — perfect for social media.",
  'glow-up':
    "You are given reference photos of a person. Generate an ultra-realistic beauty portrait glow-up. CRITICAL: Keep the person's face shape, features, skin tone, eye color, and identity absolutely identical — do NOT alter the face. Apply: professional makeup artistry, radiant healthy skin (not plastic), soft butterfly beauty lighting with subtle rim light, perfectly styled hair. The person should look like the most polished and confident version of themselves.",
  soar:
    "You are given reference photos of a person. Generate an ultra-realistic cinematic editorial portrait. CRITICAL: Keep the person's face, features, skin tone, eye color, and identity absolutely identical. Apply: dramatic Rembrandt lighting with deep shadows and highlights, commanding confident expression, editorial magazine cover aesthetic, desaturated filmic color grade, 50mm lens from a slight upward angle. Should look like a Forbes or luxury brand cover shoot.",
};

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'ibrahim3709@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isPaidPlan(plan) {
  return plan === 'monthly' || plan === 'pro' || plan === 'yearly';
}

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'POST, GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Sign in first.' });

  const userEmail = (session.user.email || '').toLowerCase();
  const isAdmin = ADMIN_EMAILS.includes(userEmail);

  const admin = getSupabaseAdmin();
  const { data: profile } = await admin
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', session.user.id)
    .maybeSingle();
  const customerId = profile?.stripe_customer_id || null;

  let entitlement;
  if (isAdmin) {
    entitlement = {
      tier: 'admin',
      status: 'admin',
      imageCreditsRemaining: 9999,
      nextPeriodStart: Date.now(),
      md: null,
      activeSub: { id: 'admin' },
    };
  } else {
    entitlement = await resolveEntitlement(customerId);
  }

  if (req.method === 'GET') {
    return res.status(200).json({
      tier: entitlement.tier,
      status: entitlement.status,
      imageCreditsRemaining: entitlement.imageCreditsRemaining,
      imagePeriodStart: entitlement.nextPeriodStart,
      periodCap: CREDITS_PER_PERIOD,
    });
  }

  // POST — validate body up front. Two modes:
  //   - default ('generate'): style + 1–4 reference photos + optional extraPrompt
  //   - 'edit': editPrompt + 1–5 imageUrls (first = previously-generated, rest = originals)
  const body = req.body || {};
  const mode = body.mode === 'edit' ? 'edit' : 'generate';
  const imageUrls = Array.isArray(body.imageUrls) ? body.imageUrls : [];
  const maxRefs = mode === 'edit' ? 5 : 4;
  if (imageUrls.length === 0 || imageUrls.length > maxRefs) {
    return res.status(400).json({ error: `Provide 1–${maxRefs} imageUrls.` });
  }
  for (const u of imageUrls) {
    if (typeof u !== 'string' || !u.startsWith('https://')) {
      return res.status(400).json({ error: 'Invalid image URL.' });
    }
  }

  let kiePrompt;
  if (mode === 'edit') {
    const editFragment = safePromptFragment(body.editPrompt, 400);
    if (!editFragment) {
      return res.status(400).json({ error: 'editPrompt is required for edit mode.' });
    }
    kiePrompt = `${EDIT_PROMPT_PREFIX} ${editFragment}`;
  } else {
    if (!PROMPTS[body.style]) {
      return res.status(400).json({ error: 'Invalid style.' });
    }
    const extra = safePromptFragment(body.extraPrompt, 400);
    kiePrompt = extra
      ? `${PROMPTS[body.style]} Additional user direction (incorporate without breaking the CRITICAL identity rules above): ${extra}`
      : PROMPTS[body.style];
  }

  // Content moderation BEFORE credit gate. Screen the user-supplied
  // prompt fragment (editPrompt or extraPrompt) and every reference
  // image they uploaded. screenImage is cached so re-using the same
  // image across edit iterations short-circuits.
  try {
    const userText = mode === 'edit' ? body.editPrompt : body.extraPrompt;
    if (userText) await screenText(userText);
    for (const u of imageUrls) {
      await screenImage(u);
    }
  } catch (err) {
    if (err instanceof ModerationError) return moderationErrorResponse(res, err);
    console.error('[glow-up] moderation threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }

  if (!isAdmin && (entitlement.tier === 'none' || !entitlement.activeSub)) {
    return res.status(402).json({ error: 'paywall' });
  }

  // Image credits only — no fallback to the video credit pool.
  let { imageCreditsRemaining: imageCredits } = entitlement;
  if (!isAdmin) {
    if (imageCredits > 0) {
      imageCredits -= 1;
    } else {
      return res.status(402).json({ error: 'paywall', reason: 'image-credits-exhausted' });
    }
  }

  // Reserve the credit BEFORE calling kie.ai so concurrent calls can't
  // double-spend. Refund on any failure path below. Mirrors the
  // pattern used by /api/ugc-image (reserveCredits/refundCredits).
  let creditReserved = false;
  if (!isAdmin && customerId && entitlement.md) {
    const reservedMd = { ...entitlement.md };
    reservedMd[KEY.imageCredits] = String(imageCredits);
    reservedMd[KEY.imagePeriodStart] = String(entitlement.nextPeriodStart);
    try {
      await stripe().customers.update(customerId, { metadata: reservedMd });
      creditReserved = true;
    } catch (mdErr) {
      console.warn('[glow-up] credit reserve failed', mdErr.message);
      return res.status(500).json({ error: 'Could not reserve credit.' });
    }
  }

  const kieKey = process.env.KIE_API_KEY;
  if (!kieKey) {
    if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
    return res.status(500).json({ error: 'KIE_API_KEY is not configured.' });
  }

  try {
    // 1. Create the kie.ai 4o-image task.
    const createRes = await fetch(`${KIE_BASE}${KIE_GENERATE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kieKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt: kiePrompt,
        filesUrl: imageUrls.slice(0, 5),
        size: '1:1',
      }),
    });
    const createText = await createRes.text();
    let createData;
    try {
      createData = JSON.parse(createText);
    } catch {
      createData = { code: createRes.status, msg: createText };
    }
    if (!createRes.ok || createData.code !== 200 || !createData.data?.taskId) {
      console.error('[glow-up] kie.ai create failed', createRes.status, createText.slice(0, 500));
      if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
      return res.status(502).json({ error: createData?.msg || 'Image generation failed.' });
    }
    const taskId = createData.data.taskId;

    // 2. Poll record-info until SUCCESS, GENERATE_FAILED, or timeout.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let resultUrl = null;
    let lastErr = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const recRes = await fetch(
        `${KIE_BASE}${KIE_RECORD_PATH}?taskId=${encodeURIComponent(taskId)}`,
        { headers: { Authorization: `Bearer ${kieKey}` } }
      );
      const recText = await recRes.text();
      let rec;
      try {
        rec = JSON.parse(recText);
      } catch {
        continue; // transient parse error — keep polling
      }
      if (rec.code !== 200) continue;
      const status = String(rec.data?.status || '').toUpperCase();
      if (status === 'SUCCESS') {
        const urls = rec.data?.response?.resultUrls;
        resultUrl = Array.isArray(urls) && urls.length > 0 ? urls[0] : null;
        break;
      }
      if (status === 'GENERATE_FAILED' || status === 'CREATE_TASK_FAILED') {
        lastErr = rec.data?.errorMessage || 'Image generation failed.';
        break;
      }
      // status is GENERATING / unknown — keep polling.
    }

    if (!resultUrl) {
      if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
      return res.status(502).json({ error: lastErr || 'Image generation timed out.' });
    }

    // 3. Re-upload kie.ai's CDN result to our own Blob store so the
    // download URL is stable and on our infra.
    let storedUrl;
    try {
      const dlRes = await fetch(resultUrl);
      if (!dlRes.ok) throw new Error(`Could not fetch generated image (${dlRes.status}).`);
      const ab = await dlRes.arrayBuffer();
      const ct = dlRes.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'png';
      const stored = await put(`glow-up/${Date.now()}.${ext}`, Buffer.from(ab), {
        access: 'public',
        contentType: ct,
        addRandomSuffix: true,
      });
      storedUrl = stored.url;
    } catch (mirrorErr) {
      // If mirroring fails we still have a usable kie.ai URL; serve
      // that rather than refunding the user. Log it for visibility.
      console.warn('[glow-up] mirror upload failed; serving kie.ai URL', mirrorErr.message);
      storedUrl = resultUrl;
    }

    // Server-side CAPI Generate event — same shape as
    // /api/ugc-image and /api/ugc-animate so Meta's reporting groups
    // all generation events together. Best-effort: a CAPI failure
    // never blocks returning the result.
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-glow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      value: 1,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: mode === 'edit' ? 'glow-up-edit' : 'glow-up',
        credits: 1,
        style: mode === 'edit' ? undefined : body.style,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});

    return res.status(200).json({
      imageUrl: storedUrl,
      imageCreditsRemaining: isAdmin ? 9999 : imageCredits,
    });
  } catch (err) {
    console.error('[glow-up] failed', err);
    if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
    return res.status(500).json({ error: err.message || 'Generation failed.' });
  }
}

async function refundCredit({ customerId, isAdmin, md, nextPeriodStart }) {
  if (isAdmin || !customerId || !md) return;
  // Re-read current metadata before refund to avoid stomping a parallel
  // write. The window between reserve and refund is small but real.
  try {
    const fresh = await stripe().customers.retrieve(customerId);
    const freshMd = fresh && !fresh.deleted ? fresh.metadata || {} : {};
    const next = { ...freshMd };
    const cur = parseInt(freshMd[KEY.imageCredits] || '0', 10) || 0;
    next[KEY.imageCredits] = String(cur + 1);
    // Preserve whatever periodStart we wrote during reserve.
    if (next[KEY.imagePeriodStart] == null) {
      next[KEY.imagePeriodStart] = String(nextPeriodStart);
    }
    await stripe().customers.update(customerId, { metadata: next });
  } catch (refundErr) {
    console.warn('[glow-up] refund failed', refundErr.message);
  }
}

async function resolveEntitlement(customerId) {
  const empty = {
    tier: 'none',
    status: 'none',
    imageCreditsRemaining: 0,
    nextPeriodStart: Date.now(),
    md: null,
    activeSub: null,
  };
  if (!customerId) return empty;

  const customer = await stripe().customers.retrieve(customerId);
  if (!customer || customer.deleted) return empty;
  const md = customer.metadata || {};
  const plan = md[KEY.plan] || null;

  const subs = await stripe().subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 5,
  });
  const activeSub = subs.data.find(
    (s) => s.status === 'active' || s.status === 'trialing'
  );
  const status = activeSub?.status || 'none';

  if (!isPaidPlan(plan) || !activeSub) {
    return {
      ...empty,
      tier: plan || 'none',
      status,
      md,
    };
  }

  const now = Date.now();
  const periodStart = parseInt(md[KEY.imagePeriodStart] || '0', 10) || 0;
  let imageCredits = parseInt(md[KEY.imageCredits] || '0', 10) || 0;
  let nextPeriodStart = periodStart;
  if (!periodStart || now - periodStart >= PERIOD_MS) {
    imageCredits = CREDITS_PER_PERIOD;
    nextPeriodStart = now;
  }

  return {
    tier: plan,
    status,
    imageCreditsRemaining: imageCredits,
    nextPeriodStart,
    md,
    activeSub,
  };
}
