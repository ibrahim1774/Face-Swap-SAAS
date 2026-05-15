/*
 * Credit cost for a video generation. Single source of truth — used
 * by /api/ugc-animate, /api/image-to-video, and the client-side cost
 * preview in DurationSlider / PricingBanner.
 *
 * Inflated credit baseline:
 *   480p without audio = 10 credits per second (Seedance 1.5 Pro)
 *
 * Cost scales by resolution + audio, and roughly 4× on Studio Pro
 * (Kling 3.0) since Kling costs more per second on kie.ai. Ibrahim's
 * USD cost target: ~$1 on the $5 plan if a customer burns the full
 * 760-credit allowance at 480p no-audio.
 */

const RATE_TABLE = {
  // Seedance 1.5 Pro — the default "Standard" model.
  standard: {
    '480p':  { silent: 10, audio: 15 },
    '720p':  { silent: 20, audio: 30 },
    '1080p': { silent: 40, audio: 50 },
  },
  // Kling 3.0 — the alternative "Studio Pro" model. ~4× the Standard
  // base because Kling is the pricier kie.ai option per second.
  'studio-pro': {
    '480p':  { silent: 40, audio: 50 },
    '720p':  { silent: 60, audio: 75 },
    '1080p': { silent: 80, audio: 100 },
  },
};

export const MODELS = ['standard', 'studio-pro'];
export const RESOLUTIONS = ['480p', '720p', '1080p'];

export function costForGeneration({
  seconds,
  model = 'standard',
  resolution = '480p',
  audio = false,
} = {}) {
  const s = Math.max(1, Math.round(Number(seconds) || 0));
  const m = MODELS.includes(model) ? model : 'standard';
  const r = RESOLUTIONS.includes(resolution) ? resolution : '480p';
  const a = audio ? 'audio' : 'silent';
  const rate = RATE_TABLE[m]?.[r]?.[a] ?? 10;
  return Math.max(1, Math.ceil(s * rate));
}

export function ratePerSecond({ model = 'standard', resolution = '480p', audio = false } = {}) {
  const m = MODELS.includes(model) ? model : 'standard';
  const r = RESOLUTIONS.includes(resolution) ? resolution : '480p';
  const a = audio ? 'audio' : 'silent';
  return RATE_TABLE[m]?.[r]?.[a] ?? 10;
}

export function rateTable() {
  return RATE_TABLE;
}

// Fixed credit cost for a face swap. Face swap uses the Replicate
// Kling v3 motion-control pipeline (NOT this model dispatch). 100
// credits ≈ 10 sec of Standard 480p no-audio, which matches the
// underlying Replicate cost (~$0.13 per swap at the new credit rate).
export const FACE_SWAP_COST = 100;
