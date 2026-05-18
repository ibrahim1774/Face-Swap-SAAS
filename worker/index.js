import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimNext, markDone, markFailed, scanWatchdog } from './jobs.js';
import { downloadToTmp, uploadOutput, cleanupTmp } from './storage.js';
import { render } from './render.js';
import { writeAssFile, getStylePreset } from './subtitles.js';
import { screenVideoSource, BlockedNSFWError } from './moderation.js';

/*
 * Long-form video editor — Fly worker main loop.
 *
 * Every POLL_INTERVAL_MS:
 *   1. Try to claim a pending render_jobs row.
 *   2. If a job: download source → FFmpeg render → upload output →
 *      mark done. On any error: mark failed + refund.
 *   3. Run the watchdog scan to fail any 'processing' row stuck > 20 min.
 *
 * Designed for single-machine deploy initially. Stage 5 scales to N
 * machines — the claimNext() implementation already tolerates races
 * because it filters on status='pending' in the UPDATE.
 *
 * Failures are surfaced via console.error to Fly's log pipeline.
 * Critical secrets are checked at boot; missing env aborts cleanly so
 * `fly deploy` surfaces the misconfig.
 */

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`[worker] required env ${name} is missing`);
    process.exit(1);
  }
}

requireEnv('SUPABASE_URL');
requireEnv('SUPABASE_SERVICE_ROLE_KEY');
requireEnv('STRIPE_SECRET_KEY');

console.log('[worker] boot — polling every', POLL_INTERVAL_MS, 'ms');

let processing = false;

async function processOne() {
  if (processing) return; // serialize within a single machine
  processing = true;
  let inputPath = null;
  let outputPath = null;
  let subtitlePath = null;
  let job = null;
  try {
    job = await claimNext();
    if (!job) return;
    console.log('[worker] claimed job', job.id, 'cost', job.cost_credits, 'cr');
    const plan = job.edit_plan || {};
    const keepIntervals = Array.isArray(plan.keepIntervals) ? plan.keepIntervals : null;
    if (!keepIntervals || keepIntervals.length === 0) {
      throw new Error('edit_plan.keepIntervals missing or empty');
    }

    // 1. Pull source.
    inputPath = await downloadToTmp(job.source_url, `job-${job.id}-source.mp4`);
    outputPath = join(tmpdir(), 'haelabs-render', `job-${job.id}-out.mp4`);

    // 1a. Pre-render moderation: extract one keyframe at ~5s and run
    // it through Claude Haiku vision. Block sexual / minor content
    // before we waste compute on a full single-pass render. Cached on
    // the moderation_results table keyed by source_url so repeat
    // submissions of the same file short-circuit.
    try {
      await screenVideoSource({
        inputPath,
        sourceUrl: job.source_url,
        durationSec: Number(job.source_seconds) || 0,
        jobId: job.id,
      });
    } catch (err) {
      if (err instanceof BlockedNSFWError) {
        console.warn(`[worker] job ${job.id} blocked by moderation (${err.category})`);
        await markFailed(job.id, {
          code: 'BLOCKED_NSFW',
          message: err.message,
        });
        return; // finally{} still runs cleanup
      }
      throw err;
    }

    // 1b. Optional: generate the ASS subtitle file when the caller
    // requested a style + provided word timings. Silently skips when
    // either is absent so existing render flows are unaffected.
    const styleKey = typeof plan.subtitleStyle === 'string' ? plan.subtitleStyle : '';
    const words = Array.isArray(plan.transcriptWords) ? plan.transcriptWords : null;
    const style = styleKey && styleKey !== 'none' ? getStylePreset(styleKey) : null;
    if (style && words && words.length > 0) {
      subtitlePath = await writeAssFile({
        words,
        keepIntervalsSec: keepIntervals,
        style,
        videoWidth: Number(plan.width) || 1080,
        videoHeight: Number(plan.height) || 1920,
        jobId: job.id,
      });
      console.log(`[worker] job ${job.id} captions: ${styleKey} (${words.length} words)`);
    }

    // 2. Render. onProgress is purely advisory for now.
    await render({
      inputPath,
      outputPath,
      keepIntervals,
      subtitlePath,
      onProgress: (s) => {
        if (Math.floor(s) % 30 === 0) {
          console.log(`[worker] job ${job.id} progress`, Math.floor(s), 'sec rendered');
        }
      },
    });

    // 3. Push output to Vercel Blob.
    const outputUrl = await uploadOutput(outputPath);
    console.log('[worker] job', job.id, 'output', outputUrl);

    // 4. Settle.
    await markDone(job.id, outputUrl);
  } catch (err) {
    if (job?.id) {
      console.error('[worker] job failed', job.id, err.message);
      await markFailed(job.id, {
        code: 'render-error',
        message: err.message || 'Render failed.',
      });
    } else {
      // No job claimed yet — failure was in the claim path itself
      // (e.g. Supabase client init). Log once and let the next poll
      // retry. Avoids spamming "job failed undefined" every 5 sec.
      console.error('[worker] poll failed (no job claimed)', err.message);
    }
  } finally {
    await cleanupTmp(inputPath, outputPath, subtitlePath);
    processing = false;
  }
}

async function poll() {
  try {
    await processOne();
  } catch (err) {
    console.error('[worker] poll iteration threw', err);
  }
}

async function watchdog() {
  try {
    await scanWatchdog();
  } catch (err) {
    console.error('[worker] watchdog iteration threw', err);
  }
}

// Two independent timers: fast poll for new work, slower watchdog scan.
setInterval(poll, POLL_INTERVAL_MS);
setInterval(watchdog, 60 * 1000);

// First-tick fire so we don't wait POLL_INTERVAL_MS at boot.
poll();
watchdog();

// Heartbeat so Fly's process supervisor sees activity even when idle.
setInterval(() => {
  console.log('[worker] heartbeat — processing:', processing);
}, 5 * 60 * 1000);

// Graceful shutdown on SIGTERM/SIGINT so Fly's auto-stop drains
// without orphaning a running render.
function shutdown(signal) {
  console.log(`[worker] ${signal} received — exiting after current job`);
  const waitTillIdle = setInterval(() => {
    if (!processing) {
      clearInterval(waitTillIdle);
      process.exit(0);
    }
  }, 1000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
