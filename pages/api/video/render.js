import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer';
import {
  costForEditorJob,
  reserveVideoEditorCredits,
  refundVideoEditorCredits,
  resolveVideoEditorEntitlement,
} from '../../../lib/videoEditorCredits';
import { stripe } from '../../../lib/stripe';
import { isAdminEmail } from '../../../lib/entitlement';

export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
  },
};

/*
 * Long-form video editor — render enqueue shim.
 *
 * Replaces the prior in-Vercel FFmpeg execution. The actual render
 * happens on a Fly.io worker (see /worker) that polls the render_jobs
 * table. This endpoint:
 *
 *   1. Validates the editPlan + source duration.
 *   2. Charges the video-editor credit pool (30 cr/min source).
 *   3. Inserts a row into render_jobs as `pending`.
 *   4. Returns `{ renderId }`. Caller polls /api/video/render-status.
 *
 * Body:
 *   {
 *     editPlan: {
 *       sourceUrl: string,           // public Vercel Blob URL
 *       sourceDurationSec: number,   // for cost calc + watchdog
 *       keepIntervals: [{ start, end }],  // worker's render input
 *       userPrompt?: string,
 *       width?, height?, duration?
 *     }
 *   }
 *
 * 402s on no-plan / insufficient credit (response carries `remaining`
 * + `cost` so the UI can prompt a topup or paywall).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const userEmail = session.user.email || '';
  const isAdmin = isAdminEmail(userEmail);

  const { editPlan } = req.body || {};
  if (!editPlan || typeof editPlan !== 'object') {
    return res.status(400).json({ error: 'editPlan is required.' });
  }
  const sourceUrl = typeof editPlan.sourceUrl === 'string' ? editPlan.sourceUrl : '';
  if (!sourceUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'editPlan.sourceUrl must be an https URL.' });
  }
  const sourceDurationSec = Number(editPlan.sourceDurationSec);
  if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
    return res.status(400).json({ error: 'editPlan.sourceDurationSec is required.' });
  }
  const keepIntervals = Array.isArray(editPlan.keepIntervals) ? editPlan.keepIntervals : [];
  if (keepIntervals.length === 0) {
    return res.status(400).json({ error: 'editPlan.keepIntervals must include at least one segment.' });
  }
  // Cap at 30 min source for paid users — matches the long-form editor's
  // product promise. Admins bypass this so we can test long videos.
  if (!isAdmin && sourceDurationSec > 30 * 60 + 30) {
    return res.status(400).json({ error: 'Source video exceeds the 30-minute cap.' });
  }

  // Admin shortcut: skip the Stripe customer lookup, credit reservation,
  // and refund-on-failure plumbing entirely. Render row carries
  // stripe_customer_id=null + cost_credits=0 so the worker's failure path
  // skips its refund attempt cleanly (markFailed already guards on those).
  let customerId = null;
  let cost = 0;
  const admin = getSupabaseAdmin();

  if (!isAdmin) {
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', session.user.id)
      .maybeSingle();
    customerId = profile?.stripe_customer_id || null;
    if (!customerId) {
      return res.status(402).json({
        error: 'No Stripe customer linked. Subscribe first.',
        code: 'NO_PLAN',
      });
    }

    // Pull plan name from customer metadata. resolveVideoEditorEntitlement
    // applies the period rollover lazily — same pattern as /api/glow-up.
    let plan = null;
    try {
      const customer = await stripe().customers.retrieve(customerId);
      if (customer && !customer.deleted) {
        plan = customer.metadata?.plan || null;
      }
    } catch (err) {
      console.warn('[video/render] customer fetch failed', err.message);
    }
    await resolveVideoEditorEntitlement({ customerId, plan });

    // Compute cost from source duration (NOT output duration). Mirrors
    // every other tool that bills users — predictable cost, shown
    // upfront on the preview screen.
    cost = costForEditorJob({ sourceSeconds: sourceDurationSec });

    // Reserve credits BEFORE inserting the row so a failure here never
    // leaves an orphan pending job.
    try {
      await reserveVideoEditorCredits({ customerId, plan, cost });
    } catch (err) {
      if (err.code === 'INSUFFICIENT') {
        return res.status(402).json({
          error: 'Out of video-editor credits. Top up to render.',
          code: 'INSUFFICIENT',
          remaining: err.remaining || 0,
          cost,
        });
      }
      if (err.code === 'NO_CUSTOMER') {
        return res.status(402).json({
          error: 'No Stripe customer linked. Subscribe first.',
          code: 'NO_PLAN',
        });
      }
      console.error('[video/render] reservation failed', err.message);
      return res.status(500).json({ error: 'Could not reserve credits.' });
    }
  }

  // Enqueue the render job.
  // Optional subtitle inputs — only kept when both style + words are
  // present so the worker can fall back to caption-less render.
  const ALLOWED_STYLES = new Set(['none', 'clean', 'bold', 'block']);
  const subtitleStyle = ALLOWED_STYLES.has(editPlan.subtitleStyle)
    ? editPlan.subtitleStyle
    : 'none';
  const rawWords = Array.isArray(editPlan.transcriptWords) ? editPlan.transcriptWords : [];
  // Trim word objects to {text,start,end} only — keeps the render_jobs
  // row payload bounded for long transcripts.
  const transcriptWords = subtitleStyle !== 'none'
    ? rawWords
        .map((w) => ({
          text: typeof w.text === 'string' ? w.text.slice(0, 80) : '',
          start: Number(w.start) || 0,
          end: Number(w.end) || 0,
        }))
        .filter((w) => w.text && w.end > w.start)
    : [];

  const sanitizedPlan = {
    sourceUrl,
    sourceDurationSec,
    keepIntervals: keepIntervals
      .map((iv) => ({
        start: Math.max(0, Number(iv.start) || 0),
        end: Math.max(0, Number(iv.end) || 0),
      }))
      .filter((iv) => iv.end > iv.start),
    userPrompt: typeof editPlan.userPrompt === 'string' ? editPlan.userPrompt.slice(0, 600) : '',
    width: Number(editPlan.width) || null,
    height: Number(editPlan.height) || null,
    subtitleStyle,
    transcriptWords,
  };
  if (sanitizedPlan.keepIntervals.length === 0) {
    if (!isAdmin) await refundVideoEditorCredits({ customerId, amount: cost });
    return res.status(400).json({ error: 'Edit plan contains no playable segments after sanitation.' });
  }

  let inserted;
  try {
    const { data, error } = await admin
      .from('render_jobs')
      .insert({
        user_id: session.user.id,
        stripe_customer_id: customerId,
        source_url: sourceUrl,
        source_seconds: sourceDurationSec,
        edit_plan: sanitizedPlan,
        cost_credits: cost,
        status: 'pending',
      })
      .select('id')
      .single();
    if (error) throw error;
    inserted = data;
  } catch (err) {
    console.error('[video/render] enqueue failed', err.message);
    if (!isAdmin) await refundVideoEditorCredits({ customerId, amount: cost });
    return res.status(500).json({ error: 'Could not enqueue render.' });
  }

  return res.status(200).json({
    renderId: inserted.id,
    cost,
    queued: true,
  });
}
