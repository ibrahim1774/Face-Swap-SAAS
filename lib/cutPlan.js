/*
 * Translate an AssemblyAI transcript preview + the user's manual
 * overrides into a list of [start, end] intervals (seconds) to KEEP
 * in the final render.
 *
 * Used by the Vercel API route (server) and the editor page (client),
 * so it has no React / Node-only imports. Output feeds straight into
 * the Fly worker's FFmpeg select filter.
 *
 * Input shape (from /api/video/transcript-status):
 *   preview.words = [
 *     { text, start, end, isFiller, leadingSilenceMs, speaker, confidence }
 *   ]
 * Times are MILLISECONDS in AssemblyAI's output.
 *
 * Overrides shape (from TranscriptPreview state):
 *   {
 *     [wordIdx]: 'keep' | 'cut',
 *     [`silence-${wordIdx}`]: 'keep'   // user opted to keep this silence
 *   }
 *
 * Algorithm
 * ---------
 * Walk the word list in order, tracking the current "kept segment"
 * boundaries. A word is CUT when (auto-filler && !keep-override) ||
 * (manual cut-override). A silence is CUT when its gap exceeds the
 * threshold AND there's no `silence-${idx}: 'keep'` override.
 *
 * Whenever we cut, close the current segment (if it has content) and
 * start a new one after the cut. Adjacent cuts collapse — no empty
 * 0-length segments emitted.
 */

const DEFAULT_SILENCE_THRESHOLD_MS = 500;

export function deriveKeepIntervals({
  preview,
  overrides = {},
  silenceThresholdMs = DEFAULT_SILENCE_THRESHOLD_MS,
  sourceDurationSec = null,
  cutFillers = true,
  cutSilences = true,
}) {
  const words = preview?.words || [];
  if (words.length === 0) {
    // Nothing to cut. Keep the whole thing if we know the duration.
    if (sourceDurationSec && sourceDurationSec > 0) {
      return [{ start: 0, end: sourceDurationSec }];
    }
    return [];
  }

  const intervals = [];
  // Open segment is in MILLISECONDS, converted to seconds when pushed.
  let segStartMs = words[0].start;

  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];

    // Silence cut decision (the gap immediately BEFORE this word).
    // If the caller disabled silence-trimming, only honor explicit
    // overrides[`silence-${i}`] === 'cut' (which the user clicked).
    const silenceOverride = overrides[`silence-${i}`];
    const silenceCut =
      silenceOverride === 'cut' ||
      (cutSilences &&
        w.leadingSilenceMs >= silenceThresholdMs &&
        silenceOverride !== 'keep');
    if (silenceCut) {
      // Close any open segment up to the start of the silence
      // (which equals the END of the previous word).
      const prevWord = words[i - 1];
      if (prevWord) {
        const endMs = prevWord.end;
        if (endMs > segStartMs) {
          pushInterval(intervals, segStartMs, endMs);
        }
      }
      // The new segment resumes at this word's start (after the silence).
      segStartMs = w.start;
    }

    // Word cut decision. Filler auto-detection is gated by cutFillers;
    // explicit overrides ('keep'/'cut') always win.
    const override = overrides[i];
    let wordCut;
    if (override === 'keep') wordCut = false;
    else if (override === 'cut') wordCut = true;
    else wordCut = cutFillers && !!w.isFiller;

    if (wordCut) {
      // Close the segment at the word's start, skip the word, resume
      // at the word's end.
      const segEndMs = w.start;
      if (segEndMs > segStartMs) {
        pushInterval(intervals, segStartMs, segEndMs);
      }
      segStartMs = w.end;
    }
  }

  // Tail segment from segStart → end of last word (or source duration).
  const lastWord = words[words.length - 1];
  const tailEndMs = sourceDurationSec
    ? Math.max(lastWord.end, sourceDurationSec * 1000)
    : lastWord.end;
  if (tailEndMs > segStartMs) {
    pushInterval(intervals, segStartMs, tailEndMs);
  }

  return intervals;
}

function pushInterval(list, startMs, endMs) {
  const start = Math.max(0, startMs) / 1000;
  const end = Math.max(0, endMs) / 1000;
  if (end <= start) return;
  // Merge with previous interval if they touch (no gap) — keeps the
  // FFmpeg filter short.
  const prev = list[list.length - 1];
  if (prev && Math.abs(prev.end - start) < 0.001) {
    prev.end = end;
    return;
  }
  list.push({ start, end });
}

/**
 * Total kept duration in seconds — useful for cost previews + the
 * editor's "estimated output" stat.
 */
export function totalKeptSeconds(intervals) {
  return (intervals || []).reduce((acc, iv) => acc + Math.max(0, iv.end - iv.start), 0);
}

/**
 * Source duration in seconds — sum of intervals + cuts isn't quite
 * right (overlapping rounding), so callers should pass this in
 * separately when they have it (transcript.durationSec).
 */
