/*
 * AssemblyAI client. Server-only — uses ASSEMBLYAI_API_KEY.
 *
 * Submits an audio/video URL for transcription and returns the
 * transcript record. We enable the full set of features the long-form
 * editor needs in one call:
 *   - word-level timestamps (default)
 *   - disfluencies: preserve "um" / "uh" / "like" etc. in the word
 *     list so we can offer to cut them
 *   - auto_chapters: section boundaries for the transition placer
 *   - sentiment_analysis: peaks the auto-zoom keys off
 *   - entity_detection: nice-to-have for the chat agent
 *   - speaker_labels: multi-speaker diarization
 *   - punctuate + format_text: rendered text for the transcript view
 *
 * Pricing: AssemblyAI Universal tier @ ~$0.27/hr with these add-ons.
 * Our credit math (30 cr/min source) assumes this stack.
 *
 * Two flows:
 *   - submitTranscription({ audioUrl }) → returns { id, status: 'queued' }
 *   - getTranscription(id) → returns the latest state
 *
 * Long videos run async and can take 1-3 minutes. The caller polls.
 */

const API_BASE = 'https://api.assemblyai.com/v2';

function client() {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error('ASSEMBLYAI_API_KEY is not set.');
  return {
    async post(path, body) {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: {
          authorization: key,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!res.ok) {
        const msg = data?.error || `AssemblyAI ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    },
    async get(path) {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'GET',
        headers: { authorization: key },
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!res.ok) {
        const msg = data?.error || `AssemblyAI ${res.status}`;
        const err = new Error(msg);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      return data;
    },
  };
}

/**
 * Submit a transcription job. `audioUrl` must be publicly reachable
 * by AssemblyAI's servers (Vercel Blob URLs are fine).
 *
 * Returns the initial transcript record. `status` will be 'queued'
 * or 'processing' — call getTranscription(id) to poll until it's
 * 'completed' or 'error'.
 */
export async function submitTranscription({ audioUrl, languageCode = 'en' }) {
  if (!audioUrl || typeof audioUrl !== 'string') {
    throw new Error('audioUrl is required.');
  }
  const c = client();
  return c.post('/transcript', {
    audio_url: audioUrl,
    language_code: languageCode,
    // AssemblyAI requires an explicit speech model. Universal-2 is the
    // current standard tier (~$0.27/hr) and supports every add-on we
    // use below; our 30 cr/min credit math is sized to it.
    speech_model: 'universal-2',
    // Preserve fillers so the UI can offer to cut them. If we set
    // `filter_profanity` or anything that re-writes word text, the
    // mapping from word -> "is this a filler?" gets brittle, so we
    // keep the raw transcript and detect fillers client/server-side.
    disfluencies: true,
    punctuate: true,
    format_text: true,
    auto_chapters: true,
    sentiment_analysis: true,
    entity_detection: true,
    speaker_labels: true,
  });
}

/**
 * Fetch the current state of a transcript. Possible `status` values:
 *   'queued' | 'processing' | 'completed' | 'error'
 * When completed, the record includes `words[]`, `chapters[]`,
 * `sentiment_analysis_results[]`, `entities[]`, etc.
 */
export async function getTranscription(transcriptId) {
  if (!transcriptId) throw new Error('transcriptId is required.');
  const c = client();
  return c.get(`/transcript/${encodeURIComponent(transcriptId)}`);
}

/**
 * Filler-word vocabulary. AssemblyAI returns the raw text of each
 * word in the transcript; we tag them as fillers by exact match
 * (case-insensitive, punctuation-stripped).
 *
 * Conservative list — only the disfluencies that almost always
 * indicate a vocal stumble rather than meaningful content. "like"
 * and "you know" are intentionally NOT here because they often carry
 * meaning ("I like cake", "you know him"). Aggressive mode (Stage 5
 * toggle) expands the set.
 */
export const FILLER_WORDS = new Set([
  'um', 'umm', 'ummm',
  'uh', 'uhh', 'uhhh',
  'er', 'err',
  'ah', 'ahh',
  'eh', 'ehh',
  'hm', 'hmm', 'hmmm',
  'mhm', 'mhmm',
  'mm', 'mmm',
]);

/**
 * Minimum silence-gap (seconds) between consecutive words that
 * counts as a candidate cut. 0.5s is the conservative default —
 * shorter gaps are natural speech rhythm and shouldn't be removed.
 */
export const DEFAULT_SILENCE_THRESHOLD_S = 0.5;

function normalizeWordText(text) {
  return (text || '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Given an AssemblyAI transcript record, produce a render-friendly
 * structure for the transcript preview:
 *
 *   {
 *     words: [
 *       {
 *         text, start, end, speaker, confidence,
 *         isFiller: bool,
 *         leadingSilenceMs: number  // 0 if previous word ended < threshold ago
 *       },
 *       ...
 *     ]
 *   }
 *
 * `silenceThresholdMs` lets the caller tighten or relax which gaps
 * count as a candidate cut. Sub-threshold gaps are 0.
 */
export function buildPreviewModel(transcript, opts = {}) {
  const threshold = (opts.silenceThresholdMs != null
    ? opts.silenceThresholdMs
    : DEFAULT_SILENCE_THRESHOLD_S * 1000);
  const raw = Array.isArray(transcript?.words) ? transcript.words : [];
  const out = [];
  let prevEnd = 0;
  for (const w of raw) {
    const start = Number(w.start) || 0;
    const end = Number(w.end) || start;
    const gap = Math.max(0, start - prevEnd);
    const leadingSilenceMs = gap >= threshold && prevEnd > 0 ? gap : 0;
    out.push({
      text: w.text || '',
      start,
      end,
      speaker: w.speaker || null,
      confidence: typeof w.confidence === 'number' ? w.confidence : null,
      isFiller: FILLER_WORDS.has(normalizeWordText(w.text)),
      leadingSilenceMs,
    });
    prevEnd = end;
  }
  return { words: out };
}
