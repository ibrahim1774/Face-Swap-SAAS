import { createCharacterFramePrediction } from '../../lib/replicate';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { getEntitlement, reserveCredits, refundCredits } from '../../lib/entitlement';
import { sendCapiEvent } from '../../lib/meta';
import { FACE_SWAP_COST } from '../../lib/cost';

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

// Face-swap is a two-stage pipeline: this is the character frame
// generation (Replicate nano-banana-pro). Total face-swap cost is
// charged here in one shot; /api/swap (stage 2 motion-transfer) skips
// the credit gate because stage 1 already reserved.
const COST = FACE_SWAP_COST;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  let entitlement;
  try {
    entitlement = await getEntitlement({
      supabase: session.supabase,
      userId: session.user.id,
      email: session.user.email,
    });
  } catch (err) {
    return res.status(500).json({ error: `Entitlement check failed: ${err.message}` });
  }

  const { firstFrameUrl, referenceImageUrl, swapMode } = req.body || {};
  if (!isHttpUrl(firstFrameUrl) || !isHttpUrl(referenceImageUrl)) {
    return res.status(400).json({
      error: 'firstFrameUrl and referenceImageUrl are required (http/https URLs).',
    });
  }
  const mode = swapMode === 'body' ? 'body' : swapMode === 'face' ? 'face' : null;
  if (!mode) {
    return res.status(400).json({ error: "swapMode must be 'face' or 'body'." });
  }

  // Reserve the credit BEFORE creating the prediction. If Replicate
  // refuses to accept the job we refund. After acceptance we hand back
  // the predictionId and let the client poll /api/status — survives
  // tab close because Replicate keeps running on its own.
  try {
    await reserveCredits(entitlement, COST);
  } catch (err) {
    if (err.code === 'INSUFFICIENT' || err.code === 'NO_PLAN') {
      return res.status(402).json({
        error: 'paywall',
        tier: entitlement.tier,
        creditsRemaining: err.remaining ?? entitlement.creditsRemaining ?? 0,
        cost: COST,
      });
    }
    return res.status(500).json({ error: err.message });
  }

  console.log('[character-frame] creating prediction', { userId: session.user.id, mode });

  try {
    const prediction = await createCharacterFramePrediction({
      firstFrameUrl,
      referenceImageUrl,
      swapMode: mode,
    });
    console.log('[character-frame] prediction created', { id: prediction.id });
    sendCapiEvent({
      eventName: 'Generate',
      eventId: `gen-${prediction.id}`,
      value: COST,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: 'face-swap-stage-1',
        credits: COST,
        swap_mode: mode,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});
    return res.status(200).json({
      predictionId: prediction.id,
      status: prediction.status,
    });
  } catch (err) {
    console.error('[character-frame] failed; refunding credit', err);
    try {
      await refundCredits(entitlement, COST);
    } catch (e) {
      console.warn('[character-frame] refund failed', e?.message);
    }
    return res.status(500).json({ error: err.message || 'Image generation failed.' });
  }
}
