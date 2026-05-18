import { put } from '@vercel/blob';

import { getUserFromRequest, getSupabaseAdmin } from '../../lib/supabaseServer';
import { stripe } from '../../lib/stripe';
import { sendCapiEvent } from '../../lib/meta';
import { KEY, nsEventId } from '../../lib/metaKeys';
import { screenText, screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

/*
 * AI Interior Design generation endpoint.
 *
 * Same architecture as /api/glow-up:
 *   - Auth: Supabase via getUserFromRequest
 *   - Entitlement: imageCreditsRemaining pool on Stripe customer
 *     metadata (30 / 30 days, plus image-pack top-ups). NEVER falls
 *     back to the video credit pool.
 *   - Charge: inline reserve-then-refund (no call to a non-existent
 *     recordUsage()).
 *   - Compute: kie.ai's unified jobs API with model = 'flux_kontext',
 *     image-to-image with one reference photo. Result mirrored to
 *     Vercel Blob via put().
 */

const PERIOD_DAYS = 30;
const CREDITS_PER_PERIOD = 30;
const PERIOD_MS = PERIOD_DAYS * 24 * 60 * 60 * 1000;

const KIE_BASE = 'https://api.kie.ai/api/v1';
// Dedicated Flux Kontext endpoints (NOT the unified /jobs/createTask).
//   POST /flux/kontext/generate  — body: { model, prompt, inputImage, aspectRatio }
//   GET  /flux/kontext/record-info?taskId=…
// Status field uses numeric values: 0=GENERATING, 1=SUCCESS,
// 2=CREATE_TASK_FAILED, 3=GENERATE_FAILED. Result URL lives at
// data.response.resultImageUrl.
const KIE_GENERATE_PATH = '/flux/kontext/generate';
const KIE_RECORD_PATH = '/flux/kontext/record-info';
const KIE_FLUX_MODEL = 'flux-kontext-pro';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 120 * 1000;

// Style prompts are written as "redecorate / restyle" instructions —
// NOT "transform into" — so the model swaps furniture and decor while
// leaving the room's architecture and camera angle intact. The
// architecture-preservation clauses live in PRESERVE_SUFFIX below.
const STYLE_PROMPTS = {
  'modern-minimalist':
    'Restyle this room in a modern minimalist aesthetic. Use clean-lined furniture, a neutral white-and-grey palette, uncluttered surfaces, hidden storage, and a single statement light fixture.',
  scandinavian:
    'Restyle this room in a Scandinavian hygge aesthetic. Use light-wood furniture, soft white textiles, cozy throws and cushions, natural materials, and warm ambient lighting.',
  'industrial-loft':
    'Restyle this room in an industrial loft aesthetic. Use leather and dark-metal furniture, Edison-bulb pendant lamps, rugged textile rugs, and a few raw-finish accent pieces. Keep the existing wall surfaces — do not add fake brick or beams that were not in the original room.',
  bohemian:
    'Restyle this room in a bohemian eclectic aesthetic. Use rattan furniture, layered jewel-toned textiles, macrame and woven decor, indoor plants, and globally-inspired accent pieces.',
  'mid-century-modern':
    'Restyle this room in a mid-century modern aesthetic. Use walnut-wood furniture with tapered legs, organic curved silhouettes, mustard and teal accents, and retro lighting fixtures.',
  japandi:
    'Restyle this room in a Japandi aesthetic. Use low-profile wood furniture, warm neutral textiles, linen and stone accents, ceramics, and a few minimal decor pieces. Keep the room\'s architecture (walls, windows, doors, ceiling, floor) exactly as it appears in the photo — do not add new doorways, beams, shoji screens, or wall surfaces that were not already there.',
  coastal:
    'Restyle this room in a coastal beach-house aesthetic. Use whitewashed wood furniture, natural rattan, soft blue and white linen textiles, jute rugs, and breezy decor accents.',
  'dark-moody':
    'Restyle this room in a dark moody aesthetic. Use velvet and dark-wood furniture, brass accents, layered textiles in deep tones, and a few dramatic decor pieces. Keep the original wall colors as-is unless they read as already dark — do not repaint or re-clad the walls.',
};

// Appended to every prompt. Hard-locks architecture and camera so the
// model can ONLY swap furniture and decor — not demolish, rotate, or
// rebuild the room.
const PRESERVE_SUFFIX =
  'CRITICAL CONSTRAINTS: Keep the exact same room architecture — walls, windows, doorways, ceiling, floor, and overall layout must remain identical to the input photo. Do NOT add or remove doorways, walls, windows, or structural elements. Keep the same camera angle, perspective, framing, and orientation as the input — do not rotate or re-frame the view. Only swap and rearrange furniture and decor. Photorealistic architectural interior photography, natural lighting matching the original, high detail, 4K quality.';

// Server-side source of truth for the shoppable product grid. The
// page imports an identical map for instant rendering, but the API
// response's `products` is what the UI ultimately renders so a
// tampered client can't inject arbitrary names.
const STYLE_PRODUCTS = {
  'modern-minimalist': [
    'platform bed frame',
    'linen sofa',
    'arc floor lamp',
    'floating wall shelf',
    'concrete planter',
    'glass dining table',
    'bar stool set',
    'abstract wall art',
  ],
  scandinavian: [
    'light oak coffee table',
    'sheepskin throw',
    'pendant rattan lamp',
    'linen curtains',
    'storage bench',
    'ceramic vase set',
    'wool area rug',
    'wooden wall clock',
  ],
  'industrial-loft': [
    'metal bookshelf',
    'leather sofa',
    'Edison pendant light',
    'pipe clothing rack',
    'metal bar stool',
    'distressed wood dining table',
    'concrete lamp',
    'vintage wall map',
  ],
  bohemian: [
    'macrame wall hanging',
    'rattan chair',
    'floor pouf ottoman',
    'indoor hanging planter',
    'kilim rug',
    'velvet throw pillow set',
    'moroccan lantern',
    'cane side table',
  ],
  'mid-century-modern': [
    'walnut credenza',
    'tulip dining table',
    'egg chair',
    'sunburst mirror',
    'tapered leg sofa',
    'retro floor lamp',
    'teak side table',
    'geometric area rug',
  ],
  japandi: [
    'low platform bed',
    'bamboo floor lamp',
    'linen storage basket',
    'ceramic tea set',
    'neutral wool rug',
    'shoji screen divider',
    'solid wood bench',
    'simple white duvet',
  ],
  coastal: [
    'rattan pendant light',
    'blue stripe throw pillow',
    'whitewashed dresser',
    'jute area rug',
    'sea glass candle set',
    'rope mirror',
    'linen sofa slipcover',
    'driftwood wall art',
  ],
  'dark-moody': [
    'velvet sofa',
    'brass floor lamp',
    'dark linen curtains',
    'antique mirror',
    'forest green accent chair',
    'marble side table',
    'gallery wall frame set',
    'emerald throw blanket',
  ],
};

const KEEP_FURNITURE_PROMPTS = {
  blend:
    'Keep most of the existing furniture in place and add a few accent pieces in the chosen style. Restyle and recolor textiles, cushions, and decor to match.',
  redesign:
    'Replace the existing furniture with new pieces in the chosen style, but keep them arranged in the same general positions as the original room. Do NOT change the room itself.',
};

const BUDGET_PROMPTS = {
  luxury: 'Luxury high-end finishes and materials.',
  'mid-range': 'Mid-range tasteful finishes and materials.',
  'budget-friendly': 'Budget-friendly approachable materials and finishes.',
};

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || 'ibrahim3709@gmail.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function isPaidPlan(plan) {
  return plan === 'monthly' || plan === 'pro' || plan === 'yearly';
}

function safePromptFragment(s, max = 400) {
  if (typeof s !== 'string') return '';
  // Filter ASCII control chars (0-31, 127) by codepoint, collapse
  // whitespace, cap length.
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c < 32 || c === 127 ? ' ' : s[i];
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, max);
}

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
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

  // Validate body.
  const body = req.body || {};
  const { imageUrl, style, userPrompt, keepFurniture, budgetFeel, aspectRatio } = body;
  if (typeof imageUrl !== 'string' || !imageUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'Valid imageUrl is required.' });
  }
  if (!STYLE_PROMPTS[style]) {
    return res.status(400).json({ error: 'Invalid style.' });
  }
  const keep = keepFurniture === 'blend' || keepFurniture === 'redesign'
    ? keepFurniture
    : 'blend'; // conservative default: keep architecture, only restyle
  const budget =
    budgetFeel === 'luxury' || budgetFeel === 'mid-range' || budgetFeel === 'budget-friendly'
      ? budgetFeel
      : 'mid-range';

  // Content moderation BEFORE credit gate. Even though interior-design
  // is room-only (no people), users can still upload a person's photo
  // and try to bypass — screen here so we don't pass NSFW upstream.
  try {
    if (userPrompt) await screenText(userPrompt);
    await screenImage(imageUrl);
  } catch (err) {
    if (err instanceof ModerationError) return moderationErrorResponse(res, err);
    console.error('[interior-design] moderation threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }

  if (!isAdmin && (entitlement.tier === 'none' || !entitlement.activeSub)) {
    return res.status(402).json({ error: 'paywall' });
  }

  let { imageCreditsRemaining: imageCredits } = entitlement;
  if (!isAdmin) {
    if (imageCredits > 0) {
      imageCredits -= 1;
    } else {
      return res
        .status(402)
        .json({ error: 'paywall', reason: 'image-credits-exhausted' });
    }
  }

  // Reserve credit BEFORE calling kie.ai. Refund on every failure path
  // below.
  let creditReserved = false;
  if (!isAdmin && customerId && entitlement.md) {
    const reservedMd = { ...entitlement.md };
    reservedMd[KEY.imageCredits] = String(imageCredits);
    reservedMd[KEY.imagePeriodStart] = String(entitlement.nextPeriodStart);
    try {
      await stripe().customers.update(customerId, { metadata: reservedMd });
      creditReserved = true;
    } catch (mdErr) {
      console.warn('[interior-design] credit reserve failed', mdErr.message);
      return res.status(500).json({ error: 'Could not reserve credit.' });
    }
  }

  const kieKey = process.env.KIE_API_KEY;
  if (!kieKey) {
    if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
    return res.status(500).json({ error: 'KIE_API_KEY is not configured.' });
  }

  // Validate aspect ratio against kie.ai's supported set. The page now
  // detects the input photo's natural orientation and passes it here
  // so phone-shot vertical rooms aren't squashed into 4:3 landscape
  // (which is what was rotating the result). Default to 4:3 if absent.
  const ALLOWED_RATIOS = new Set(['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']);
  const ratio = ALLOWED_RATIOS.has(aspectRatio) ? aspectRatio : '4:3';

  // Build the kie.ai prompt. Order matters — preservation suffix is
  // last so the model reads architecture/orientation rules right
  // before generating.
  const userFragment = safePromptFragment(userPrompt, 400);
  const promptParts = [
    STYLE_PROMPTS[style],
    KEEP_FURNITURE_PROMPTS[keep],
    BUDGET_PROMPTS[budget],
    userFragment ? `Additional user direction: ${userFragment}` : '',
    PRESERVE_SUFFIX,
  ].filter(Boolean);
  const kiePrompt = promptParts.join(' ');

  try {
    // 1. Create the kie.ai flux_kontext task via the unified jobs API.
    const createRes = await fetch(`${KIE_BASE}${KIE_GENERATE_PATH}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kieKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: KIE_FLUX_MODEL,
        prompt: kiePrompt,
        inputImage: imageUrl,
        aspectRatio: ratio,
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
      console.error(
        '[interior-design] kie.ai create failed',
        createRes.status,
        createText.slice(0, 500)
      );
      if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
      return res.status(502).json({ error: createData?.msg || 'Generation failed.' });
    }
    const taskId = createData.data.taskId;

    // 2. Poll recordInfo until success / fail / timeout. Defensive
    // result-URL parsing matches lib/kie.js normalizeKieStatus.
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
        continue;
      }
      if (rec.code !== 200) continue;
      // Flux Kontext uses a numeric status field:
      //   0 = GENERATING, 1 = SUCCESS, 2 = CREATE_TASK_FAILED, 3 = GENERATE_FAILED
      // We read both `successFlag` (the canonical Flux field) and `status`
      // (in case it's serialized either way) and coerce to a number.
      const rawStatus =
        rec.data?.successFlag != null ? rec.data.successFlag : rec.data?.status;
      const num = typeof rawStatus === 'number' ? rawStatus : parseInt(rawStatus, 10);
      if (num === 1) {
        // resultImageUrl is the canonical field; fall through to the
        // legacy resultJson path defensively in case kie.ai changes it.
        resultUrl =
          rec.data?.response?.resultImageUrl ||
          rec.data?.response?.imageUrl ||
          (Array.isArray(rec.data?.response?.resultUrls)
            ? rec.data.response.resultUrls[0]
            : null) ||
          null;
        if (!resultUrl && rec.data?.resultJson) {
          try {
            const parsed =
              typeof rec.data.resultJson === 'string'
                ? JSON.parse(rec.data.resultJson)
                : rec.data.resultJson;
            resultUrl =
              parsed?.imageUrl ||
              parsed?.image_url ||
              (Array.isArray(parsed?.imageUrls) ? parsed.imageUrls[0] : null) ||
              (Array.isArray(parsed?.resultUrls) ? parsed.resultUrls[0] : null) ||
              parsed?.url ||
              null;
          } catch {
            // ignore
          }
        }
        break;
      }
      if (num === 2 || num === 3) {
        lastErr =
          rec.data?.errorMessage ||
          rec.data?.failMsg ||
          rec.data?.failCode ||
          'Generation failed.';
        break;
      }
      // num === 0 (GENERATING) or unknown — keep polling.
    }

    if (!resultUrl) {
      if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
      return res.status(502).json({ error: lastErr || 'Generation timed out.' });
    }

    // 3. Mirror to Vercel Blob so the resulting URL is on our infra
    // (stable + same-origin-safe for canvas readback in the share flow).
    let storedUrl;
    try {
      const dlRes = await fetch(resultUrl);
      if (!dlRes.ok) throw new Error(`Could not fetch generated image (${dlRes.status}).`);
      const ab = await dlRes.arrayBuffer();
      const ct = dlRes.headers.get('content-type') || 'image/png';
      const ext = ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : 'png';
      const stored = await put(`interior-design/${Date.now()}.${ext}`, Buffer.from(ab), {
        access: 'public',
        contentType: ct,
        addRandomSuffix: true,
      });
      storedUrl = stored.url;
    } catch (mirrorErr) {
      console.warn('[interior-design] mirror upload failed; serving kie.ai URL', mirrorErr.message);
      storedUrl = resultUrl;
    }

    // Server-side CAPI Generate event — same shape as /api/ugc-image,
    // /api/ugc-animate, /api/glow-up. Best-effort: a CAPI failure
    // never blocks returning the result.
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-int-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
      value: 1,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: 'interior-design',
        credits: 1,
        style,
        keepFurniture: keep,
        budgetFeel: budget,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});

    return res.status(200).json({
      renderedImageUrl: storedUrl,
      products: STYLE_PRODUCTS[style] || [],
      imageCreditsRemaining: isAdmin ? 9999 : imageCredits,
    });
  } catch (err) {
    console.error('[interior-design] failed', err);
    if (creditReserved) await refundCredit({ customerId, isAdmin, md: entitlement.md, nextPeriodStart: entitlement.nextPeriodStart });
    return res.status(500).json({ error: err.message || 'Generation failed.' });
  }
}

async function refundCredit({ customerId, isAdmin, md, nextPeriodStart }) {
  if (isAdmin || !customerId || !md) return;
  try {
    const fresh = await stripe().customers.retrieve(customerId);
    const freshMd = fresh && !fresh.deleted ? fresh.metadata || {} : {};
    const next = { ...freshMd };
    const cur = parseInt(freshMd[KEY.imageCredits] || '0', 10) || 0;
    next[KEY.imageCredits] = String(cur + 1);
    if (next[KEY.imagePeriodStart] == null) {
      next[KEY.imagePeriodStart] = String(nextPeriodStart);
    }
    await stripe().customers.update(customerId, { metadata: next });
  } catch (refundErr) {
    console.warn('[interior-design] refund failed', refundErr.message);
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
    return { ...empty, tier: plan || 'none', status, md };
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
