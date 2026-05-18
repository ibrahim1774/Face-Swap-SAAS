import { spawn } from 'node:child_process';
import { readFile, unlink, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { getSupabase } from './supabase.js';

/*
 * Worker-side moderation. Parallels lib/moderation.js on the Vercel
 * side but uses the worker's Supabase client and ffmpeg for keyframe
 * extraction. Shares the same `moderation_results` table so verdicts
 * persist across the two surfaces.
 *
 * Flow for video moderation:
 *   1. Source already downloaded to /tmp by storage.js
 *   2. ffmpeg extracts one keyframe at the 5s mark (or 10% of duration)
 *   3. Frame fed to Claude Haiku 4.5 vision
 *   4. Block → throw BlockedNSFWError → worker/jobs.js markFailed with
 *      BLOCKED_NSFW code, refund handled by existing path
 */

export class BlockedNSFWError extends Error {
  constructor(category, reason) {
    super("AI doesn't allow sexual content or anything involving minors.");
    this.code = 'BLOCKED_NSFW';
    this.category = category;
    this.reason = reason || '';
  }
}

const IMAGE_SYSTEM_PROMPT = `You are a strict content-safety classifier for image inputs to a video editor.

Classify the image for two categories:
1. **sexual** — Visible nudity (exposed breasts, genitals, buttocks), partial undress that exposes intimate areas, sexual acts, or explicit erotic posing. Bikinis, swimwear, lingerie, and form-fitting clothing are NOT sexual on their own. Medical/anatomical diagrams are NOT sexual.
2. **minor** — Anyone in the image who appears to be under 18, evaluated by face/body proportions, clothing context, and setting. A child or teen in a non-sexual, fully-clothed context is acceptable. Flag minors only if they are present AND any sexualization is apparent.

Return ONLY a JSON object on a single line:
{"sexual": <bool>, "minor": <bool>, "reason": "<one short sentence>"}`;

function urlHash(input) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, 32);
}

/**
 * Extract one keyframe from a local video file using ffmpeg. Returns
 * the absolute path of the JPEG written to /tmp.
 *
 * Position: 5 seconds in, or 10% of duration (whichever is sooner) so
 * we don't capture a blank opening frame. Falls back to 0 if neither
 * is known.
 */
export function extractKeyframe({ inputPath, durationSec, jobId }) {
  return new Promise(async (resolve, reject) => {
    const dur = Number(durationSec) || 0;
    const seekSec = dur > 0 ? Math.min(5, Math.max(0, dur * 0.1)) : 0;
    const dir = join(tmpdir(), 'haelabs-render');
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `job-${jobId || Date.now()}-keyframe.jpg`);
    const args = [
      '-y',
      '-ss', String(seekSec),
      '-i', inputPath,
      '-frames:v', '1',
      '-q:v', '5',
      outPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`ffmpeg keyframe extract failed (${code}): ${stderr.slice(-500)}`));
    });
  });
}

async function readCachedImageResult(cacheKey) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from('moderation_results')
      .select('sexual, minor, reason')
      .eq('url_hash', cacheKey)
      .maybeSingle();
    return data || null;
  } catch (err) {
    console.warn('[worker/moderation] cache read failed', err.message);
    return null;
  }
}

async function writeCachedImageResult(cacheKey, sourceUrl, { sexual, minor, reason }) {
  try {
    const supabase = getSupabase();
    await supabase
      .from('moderation_results')
      .upsert(
        {
          url_hash: cacheKey,
          url: String(sourceUrl || '').slice(0, 1000),
          sexual: !!sexual,
          minor: !!minor,
          reason: String(reason || '').slice(0, 300),
        },
        { onConflict: 'url_hash' }
      );
  } catch (err) {
    console.warn('[worker/moderation] cache write failed', err.message);
  }
}

async function classifyImageFile(localPath) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[worker/moderation] ANTHROPIC_API_KEY missing; skipping');
    return null;
  }
  const client = new Anthropic({ apiKey });
  const buf = await readFile(localPath);
  if (buf.length > 5 * 1024 * 1024) {
    console.warn('[worker/moderation] keyframe > 5 MB, skipping classifier');
    return null;
  }
  try {
    const result = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: [
        {
          type: 'text',
          text: IMAGE_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') },
            },
            { type: 'text', text: 'Classify this video keyframe.' },
          ],
        },
      ],
    });
    const block = result.content.find((b) => b.type === 'text');
    if (!block) return null;
    const cleaned = block.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.warn('[worker/moderation] classify failed', err.message);
    return null;
  }
}

/**
 * Moderate a video source. Caches by source URL so re-uploads of the
 * same Blob URL short-circuit.
 *
 * Throws BlockedNSFWError on block. Fail-open on transient errors.
 */
export async function screenVideoSource({ inputPath, sourceUrl, durationSec, jobId }) {
  const cacheKey = urlHash(sourceUrl || inputPath);
  const cached = await readCachedImageResult(cacheKey);
  if (cached) {
    if (cached.sexual || cached.minor) {
      throw new BlockedNSFWError(
        cached.minor ? 'minor' : 'sexual',
        `Cached: ${cached.reason || ''}`
      );
    }
    return { ok: true, cached: true };
  }

  let keyframePath = null;
  try {
    keyframePath = await extractKeyframe({ inputPath, durationSec, jobId });
    const result = await classifyImageFile(keyframePath);
    if (!result) {
      // Fail-open: classifier was unavailable. Don't block.
      return { ok: true, cached: false };
    }
    await writeCachedImageResult(cacheKey, sourceUrl, result);
    if (result.sexual || result.minor) {
      throw new BlockedNSFWError(
        result.minor ? 'minor' : 'sexual',
        result.reason || ''
      );
    }
    return { ok: true, cached: false };
  } finally {
    if (keyframePath) {
      try { await unlink(keyframePath); } catch {}
    }
  }
}
