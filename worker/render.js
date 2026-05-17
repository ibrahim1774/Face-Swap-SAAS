import { spawn as spawnProcess } from 'node:child_process';

/*
 * Single-pass FFmpeg render for the long-form video editor.
 *
 * Input  : path to the downloaded source video (mp4/mov/etc.)
 * Output : path the rendered MP4 should land at on local disk
 * Plan   : { keepIntervals: [{ start, end }] }   // seconds
 *
 * Security: uses node:child_process spawn with an argv ARRAY (no shell
 * interpolation, no exec()), so arguments — including paths and the
 * FFmpeg filter expression — are passed verbatim to ffmpeg without
 * shell parsing. No injection surface even if a path contained spaces
 * or special characters.
 *
 * Strategy
 * --------
 * Use FFmpeg's `select` + `aselect` filters with a chained
 * `between(t,a,b)` per kept interval, then `setpts/asetpts` to compact
 * the time base so the output runs continuously.
 *
 *   -vf "select='between(t,a1,b1)+between(t,a2,b2)+…',setpts=N/FRAME_RATE/TB"
 *   -af "aselect='between(t,a1,b1)+…',asetpts=N/SR/TB"
 *
 * One pass = single re-encode. Critical for quality + speed. The
 * filter expression scales linearly with the number of cuts; up to
 * ~2,000 intervals work fine, beyond that switch to concat-demuxer.
 *
 * Audio is normalized via the loudnorm filter (EBU R128, single-pass
 * approximation). Good enough for talking-head cleanup without a
 * separate analyze pass.
 *
 * Encoding presets aimed at quality/speed balance for shared-cpu-2x:
 *   libx264 -preset fast -crf 22  → ~720p at 1× realtime on Fly
 */

function buildBetweenExpr(intervals) {
  if (!intervals || intervals.length === 0) {
    // No-op: keep everything.
    return 'between(t,0,1e9)';
  }
  // Round to 3 decimal places so the filter string stays compact.
  const fmt = (n) => Number(n).toFixed(3);
  return intervals
    .map((iv) => `between(t,${fmt(iv.start)},${fmt(iv.end)})`)
    .join('+');
}

export function buildFfmpegArgs({ inputPath, outputPath, keepIntervals, subtitlePath }) {
  const expr = buildBetweenExpr(keepIntervals);
  // Subtitles are burned in AFTER the cut+retime so the ASS timings
  // (already in output-time) align with the rendered frames.
  // FFmpeg's `subtitles=` filter expects a path; we escape the colon
  // and backslash so paths like /tmp/foo work cross-platform.
  const escapePath = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const videoChain = subtitlePath
    ? `select='${expr}',setpts=N/FRAME_RATE/TB,subtitles='${escapePath(subtitlePath)}'`
    : `select='${expr}',setpts=N/FRAME_RATE/TB`;
  const audioFilter = `aselect='${expr}',asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11`;
  return [
    '-y',
    '-i', inputPath,
    '-vf', videoChain,
    '-af', audioFilter,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    outputPath,
  ];
}

export function runFfmpeg(args, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    // spawnProcess uses execvp-style argument passing (no shell). Args
    // array is forwarded verbatim to /usr/bin/ffmpeg.
    const proc = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      // FFmpeg emits "time=00:00:XX.XX" lines on stderr — surface them
      // for the optional onProgress callback so the worker can update
      // render_jobs.updated_at as a heartbeat.
      const m = /time=(\d+):(\d+):(\d+\.\d+)/.exec(text);
      if (m && onProgress) {
        const seconds = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        try { onProgress(seconds); } catch { /* ignore */ }
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

export async function render({ inputPath, outputPath, keepIntervals, subtitlePath, onProgress }) {
  const args = buildFfmpegArgs({ inputPath, outputPath, keepIntervals, subtitlePath });
  await runFfmpeg(args, { onProgress });
}
