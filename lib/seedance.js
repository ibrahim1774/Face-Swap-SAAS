/*
 * kie.ai API client for Seedance 1.5 Pro video generation.
 *
 * Mirrors lib/kie.js (Kling 3.0 client). Uses the same unified jobs API
 * with model 'bytedance/seedance-1.5-pro'. Input fields per the kie.ai
 * docs (https://docs.kie.ai/market/bytedance/seedance-1.5-pro):
 *   - prompt (required text)
 *   - input_urls (array): 0–2 image URLs for image-to-video. When
 *     omitted, the model is text-to-video. When two URLs are passed
 *     they're treated as first + last frame.
 *   - aspect_ratio
 *   - resolution: '480p' | '720p' | '1080p'
 *   - duration: integer seconds (string-encoded)
 *   - generate_audio: boolean
 *
 * If the response/error shape differs from Kling's, normalizeKieStatus
 * in lib/kie.js handles the polymorphic resultJson shapes; we reuse it.
 */

const KIE_BASE = 'https://api.kie.ai/api/v1';
const SEEDANCE_MODEL = 'bytedance/seedance-1.5-pro';

function apiKey() {
  const k = process.env.KIE_API_KEY;
  if (!k) throw new Error('KIE_API_KEY is not set. Add it to .env.local.');
  return k;
}

async function kiePost(path, body) {
  const res = await fetch(`${KIE_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { code: res.status, msg: text }; }
  if (!res.ok || data.code !== 200) {
    const msg = data?.msg || `kie.ai request failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status;
    err.kieCode = data?.code;
    throw err;
  }
  return data.data;
}

function clampSeedanceDuration(d, min = 3, max = 15) {
  const n = Math.round(Number(d));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/**
 * Kick off a Seedance 1.5 Pro generation.
 * Returns { id } matching the shape /api/status expects (and lib/kie.js
 * createKlingSinglePrediction returns).
 *
 * Pass `imageUrl` for image-to-video; omit for text-to-video.
 */
export async function createSeedancePrediction({
  imageUrl,
  prompt = '',
  duration = 5,
  resolution = '480p',
  audio = false,
  aspectRatio = '9:16',
}) {
  const dur = clampSeedanceDuration(duration);
  const input = {
    prompt: (prompt || '').trim() || 'natural motion',
    aspect_ratio: aspectRatio,
    resolution,
    duration: String(dur),
    generate_audio: Boolean(audio),
  };
  if (imageUrl) {
    // kie.ai's Seedance 1.5 Pro reads the reference frame from
    // `input_urls` (an array of 0–2 image URLs). The previous code
    // sent `image_url` / `image_urls` which Seedance silently
    // ignores, causing the model to fall back to text-only
    // generation and produce a random character instead of motion
    // from the uploaded image.
    input.input_urls = [imageUrl];
  }
  const data = await kiePost('/jobs/createTask', {
    model: SEEDANCE_MODEL,
    input,
  });
  return { id: data.taskId, raw: data };
}
