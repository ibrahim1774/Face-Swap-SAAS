import { v4 as uuidv4 } from 'uuid';

import { createJob, updateJob } from '../../lib/jobs';
import { createMotionTransferPrediction, normalizeStatus } from '../../lib/replicate';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const jobId = uuidv4();

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  // No credit gate here: stage 1 (/api/character-frame) already
  // reserved the credit. Re-gating here would 402 mid-flow when the
  // user spent their last credit on stage 1 and never get a result.

  try {
    const {
      imageUrl,
      videoUrl,
      mode,
      videoFileName,
      faceFileName,
    } = req.body || {};

    if (!isHttpUrl(imageUrl) || !isHttpUrl(videoUrl)) {
      return res.status(400).json({
        error: 'imageUrl (character image) and videoUrl (motion video) are required.',
      });
    }

    // Moderate the face image. videoUrl is a motion clip — we trust
    // those (face-swap doesn't surface the source video to the output).
    try {
      await screenImage(imageUrl);
    } catch (err) {
      if (err instanceof ModerationError) return moderationErrorResponse(res, err);
      console.error('[swap] moderation threw', err);
      return res.status(500).json({ error: 'Moderation check failed.' });
    }

    const safeMode = mode === 'pro' ? 'pro' : 'std';

    createJob({
      jobId,
      status: 'queued',
      videoFileName: videoFileName || 'motion.mp4',
      faceFileName: faceFileName || 'character.jpg',
      mode: safeMode,
    });

    updateJob(jobId, { status: 'processing' });

    console.log('[swap] creating prediction', {
      jobId,
      userId: session.user.id,
      mode: safeMode,
    });

    const prediction = await createMotionTransferPrediction({
      imageUrl,
      videoUrl,
      mode: safeMode,
      characterOrientation: 'video',
    });
    const normalized = normalizeStatus(prediction);

    console.log('[swap] prediction created', {
      jobId,
      predictionId: prediction.id,
      status: prediction.status,
    });

    updateJob(jobId, {
      predictionId: prediction.id,
      status: normalized.status === 'queued' ? 'processing' : normalized.status,
    });

    return res.status(200).json({
      jobId,
      predictionId: prediction.id,
      status: 'processing',
    });
  } catch (err) {
    updateJob(jobId, {
      status: 'error',
      error: err.message || 'Unknown error',
    });
    return res.status(500).json({
      jobId,
      error: err.message || 'Generation failed to start.',
    });
  }
}
