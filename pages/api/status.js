import { getPrediction, normalizeStatus } from '../../lib/replicate';
import { getKiePrediction, normalizeKieStatus } from '../../lib/kie';
import { getUserFromRequest, getSupabaseAdmin } from '../../lib/supabaseServer';
import { getEntitlement, settlePendingJob } from '../../lib/entitlement';

/*
 * Polling endpoint. Dispatches to either Replicate (default — used for
 * nano-banana image predictions and the face-swap motion-transfer path)
 * or kie.ai (Kling 3.0 video generation). The client tells us which
 * vendor via the `vendor` query param, and that choice is persisted
 * alongside the predictionId in localStorage so resume-after-close
 * routes to the right backend.
 *
 * On the first poll that detects a completed prediction with a
 * resultUrl, we also insert into the `videos` table so the result
 * shows up in /history. Idempotent on prediction_id.
 */

const ALLOWED_KINDS = ['face-swap', 'image-to-video', 'ugc'];
const HISTORY_TTL_HOURS = 23;

async function recordHistory({ session, predictionId, resultUrl, historyKind }) {
  if (!session || !resultUrl || !ALLOWED_KINDS.includes(historyKind)) return;
  try {
    const admin = getSupabaseAdmin();
    const expiresAt = new Date(Date.now() + HISTORY_TTL_HOURS * 60 * 60 * 1000).toISOString();
    await admin
      .from('videos')
      .upsert(
        {
          user_id: session.user.id,
          prediction_id: predictionId,
          kind: historyKind,
          result_url: resultUrl,
          is_blob_owned: false,
          expires_at: expiresAt,
        },
        { onConflict: 'prediction_id', ignoreDuplicates: true }
      );
  } catch (err) {
    // Never break the poll on history-write failure.
    console.warn('[status] history insert failed', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { predictionId, vendor, historyKind } = req.query;
  if (!predictionId || typeof predictionId !== 'string') {
    return res.status(400).json({ error: 'predictionId is required.' });
  }

  // Accept legacy 'kie' and the new namespaced 'kie-kling' / 'kie-seedance'
  // vendor strings (the ported ugc-animate uses the namespaced shape so
  // future model dispatches can be distinguished in logs).
  const isKie = typeof vendor === 'string' && vendor.startsWith('kie');
  const session = await getUserFromRequest(req, res); // /api/status is gated by middleware so this is non-null

  // Idempotently settle the credit reservation we made when the job
  // was queued. Refund on vendor failure, drop tracking on success.
  // Only kie.ai jobs (image-to-video, ugc) are tracked today.
  async function settleIfTerminal(status) {
    if (!isKie || !session) return;
    if (status !== 'complete' && status !== 'error') return;
    try {
      const entitlement = await getEntitlement({
        supabase: session.supabase,
        userId: session.user.id,
        email: session.user.email,
      });
      await settlePendingJob(entitlement, predictionId, { refund: status === 'error' });
    } catch (err) {
      console.warn('[status] settle failed', err.message);
    }
  }

  try {
    if (isKie) {
      const record = await getKiePrediction(predictionId);
      const normalized = normalizeKieStatus(record);
      if (normalized.status === 'complete' && normalized.resultUrl) {
        await recordHistory({
          session,
          predictionId,
          resultUrl: normalized.resultUrl,
          historyKind,
        });
      }
      await settleIfTerminal(normalized.status);
      return res.status(200).json({
        predictionId,
        status: normalized.status,
        resultUrl: normalized.resultUrl || null,
        error: normalized.status === 'error' ? normalized.error || 'Prediction failed' : null,
      });
    }
    const prediction = await getPrediction(predictionId);
    const normalized = normalizeStatus(prediction);
    if (normalized.status === 'complete' && normalized.resultUrl) {
      await recordHistory({
        session,
        predictionId,
        resultUrl: normalized.resultUrl,
        historyKind,
      });
    }
    return res.status(200).json({
      predictionId,
      status: normalized.status,
      resultUrl: normalized.resultUrl || null,
      error: normalized.status === 'error' ? normalized.error || 'Prediction failed' : null,
    });
  } catch (err) {
    return res.status(502).json({
      predictionId,
      status: 'processing',
      error: err.message || 'Failed to reach provider.',
    });
  }
}
