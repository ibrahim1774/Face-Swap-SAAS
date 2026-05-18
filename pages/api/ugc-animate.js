import {
  createKlingSinglePrediction,
  createKlingStoryboardPrediction,
} from '../../lib/kie';
import { createSeedancePrediction } from '../../lib/seedance';
import { getUserFromRequest } from '../../lib/supabaseServer';
import { getEntitlement, reserveCredits, refundCredits, trackPendingJob } from '../../lib/entitlement';
import { sendCapiEvent } from '../../lib/meta';
import { nsEventId } from '../../lib/metaKeys';
import { costForGeneration, MODELS, RESOLUTIONS } from '../../lib/cost';
import { screenText, screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

function isHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function clampDuration(d) {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return 5;
  return Math.max(3, Math.min(15, n));
}

function clampSceneDuration(d) {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(12, n));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const {
    imageUrl,
    script,
    duration,
    audio,
    scenes,
    model: modelRaw,
    resolution: resolutionRaw,
  } = req.body || {};
  if (!isHttpUrl(imageUrl)) {
    return res.status(400).json({ error: 'imageUrl is required (http/https URL).' });
  }

  const model = MODELS.includes(modelRaw) ? modelRaw : 'standard';
  const resolution = RESOLUTIONS.includes(resolutionRaw) ? resolutionRaw : '480p';
  const wantAudio = Boolean(audio);

  const isStoryboard = Array.isArray(scenes) && scenes.length > 0;
  // Storyboard mode is Kling-only (Seedance doesn't support multi_shots).
  // If a user sends scenes with model='standard', auto-promote to Studio Pro.
  const effectiveModel = isStoryboard && model === 'standard' ? 'studio-pro' : model;

  let totalSeconds;
  let normalizedScenes = null;
  if (isStoryboard) {
    if (scenes.length > 5) {
      return res.status(400).json({ error: 'Storyboard supports up to 5 scenes.' });
    }
    normalizedScenes = scenes.map((s) => ({
      prompt: typeof s?.prompt === 'string' ? s.prompt : '',
      duration: clampSceneDuration(s?.duration),
    }));
    totalSeconds = normalizedScenes.reduce((a, s) => a + s.duration, 0);
  } else {
    totalSeconds = clampDuration(duration);
  }

  // Content moderation: pre-filter prompts + image BEFORE charging.
  // Fail-closed for any thrown ModerationError; fail-open for transient
  // classifier errors (logged in lib/moderation.js).
  try {
    const textsToScreen = [
      script || '',
      ...(normalizedScenes ? normalizedScenes.map((s) => s.prompt) : []),
    ];
    await screenText(textsToScreen);
    await screenImage(imageUrl);
  } catch (err) {
    if (err instanceof ModerationError) return moderationErrorResponse(res, err);
    console.error('[ugc-animate] moderation threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }

  const cost = costForGeneration({
    seconds: totalSeconds,
    model: effectiveModel,
    resolution,
    audio: wantAudio,
  });

  let entitlement;
  try {
    entitlement = await getEntitlement({ supabase: session.supabase, userId: session.user.id, email: session.user.email });
  } catch (err) {
    return res.status(500).json({ error: `Entitlement check failed: ${err.message}` });
  }

  try {
    await reserveCredits(entitlement, cost);
  } catch (err) {
    if (err.code === 'INSUFFICIENT' || err.code === 'NO_PLAN') {
      return res.status(402).json({
        error: 'paywall',
        tier: entitlement.tier,
        creditsRemaining: err.remaining ?? entitlement.creditsRemaining ?? 0,
        cost,
      });
    }
    return res.status(500).json({ error: err.message });
  }

  try {
    let prediction;
    if (effectiveModel === 'studio-pro') {
      // Kling 3.0 path. Maps `audio: true/false` and keeps the existing
      // mode='pro' (resolution-equivalent 1080p) when the user picked
      // 1080p, else 'std'. Storyboard support preserved.
      const klingMode = resolution === '1080p' ? 'pro' : 'std';
      if (isStoryboard) {
        prediction = await createKlingStoryboardPrediction({
          imageUrl,
          scenes: normalizedScenes,
          mode: klingMode,
          audio: wantAudio,
        });
      } else {
        prediction = await createKlingSinglePrediction({
          imageUrl,
          prompt: script || '',
          duration: totalSeconds,
          mode: klingMode,
          audio: wantAudio,
        });
      }
    } else {
      // Seedance 1.5 Pro path. Single-scene only.
      prediction = await createSeedancePrediction({
        imageUrl,
        prompt: script || '',
        duration: totalSeconds,
        resolution,
        audio: wantAudio,
      });
    }

    trackPendingJob(entitlement, prediction.id, cost).catch(() => {});
    sendCapiEvent({
      eventName: 'Generate',
      eventId: nsEventId(`gen-${prediction.id}`),
      value: cost,
      currency: 'USD',
      email: session.user.email,
      req,
      customData: {
        feature: isStoryboard ? 'ugc-storyboard' : 'ugc-animate',
        credits: cost,
        duration: totalSeconds,
        scenes: isStoryboard ? normalizedScenes.length : 1,
        model: effectiveModel,
        resolution,
        audio: wantAudio,
        supabase_user_id: session.user.id,
      },
    }).catch(() => {});
    return res.status(200).json({
      predictionId: prediction.id,
      vendor: effectiveModel === 'studio-pro' ? 'kie-kling' : 'kie-seedance',
      status: 'queued',
      cost,
      model: effectiveModel,
      resolution,
      audio: wantAudio,
    });
  } catch (err) {
    console.error('[ugc-animate] failed; refunding credits', err);
    try { await refundCredits(entitlement, cost); } catch {}
    return res.status(500).json({ error: err.message || 'UGC animation failed.' });
  }
}
