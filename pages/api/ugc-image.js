import { createImagePrediction } from '../../lib/replicate';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { getEntitlement, reserveCredits, refundCredits } from '../../lib/entitlement';
import { sendCapiEvent } from '../../lib/meta';
import { nsEventId } from '../../lib/metaKeys';
import { screenText, ModerationError, moderationErrorResponse } from '../../lib/moderation';

const COST = 1;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  let entitlement;
  try {
    entitlement = await getEntitlement({ supabase: session.supabase, userId: session.user.id, email: session.user.email });
  } catch (err) {
    return res.status(500).json({ error: `Entitlement check failed: ${err.message}` });
  }

  const { prompt } = req.body || {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'prompt is required.' });
  }

  // Pre-filter prompt before charging credits.
  try {
    await screenText(prompt);
  } catch (err) {
    if (err instanceof ModerationError) return moderationErrorResponse(res, err);
    console.error('[ugc-image] moderation threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }

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

  try {
    const prediction = await createImagePrediction({ prompt });
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-${prediction.id}`),
      value: COST,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: 'ugc-image',
        credits: COST,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});
    return res.status(200).json({
      predictionId: prediction.id,
      status: prediction.status,
    });
  } catch (err) {
    console.error('[ugc-image] failed; refunding credit', err);
    try { await refundCredits(entitlement, COST); } catch {}
    return res.status(500).json({ error: err.message || 'Image generation failed.' });
  }
}
