import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getSupabase } from './supabase.js';

/*
 * Worker storage helpers.
 *
 * Input videos live on Vercel Blob (uploaded by the browser via
 * /api/upload-token). Blob URLs are public, so a plain fetch with no
 * auth is enough to pull them.
 *
 * Output videos go to Supabase Storage (bucket: `editor-renders`,
 * public). We use Supabase here instead of Vercel Blob so the worker
 * has exactly one cross-service credential (SUPABASE_SERVICE_ROLE_KEY)
 * — no BLOB_READ_WRITE_TOKEN required.
 *
 * The bucket is created by the migration at
 * supabase/migrations/20260516_editor_renders_bucket.sql. Run it once
 * before deploying the worker.
 */

const OUTPUT_BUCKET = 'editor-renders';

export async function downloadToTmp(url, filename = 'source.mp4') {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download source (${res.status} ${res.statusText}).`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dir = join(tmpdir(), 'haelabs-render');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${filename}`);
  await writeFile(path, buf);
  return path;
}

/**
 * Upload the rendered MP4 to Supabase Storage and return the public
 * URL. Path collision-proofed with a timestamp + 8-byte random suffix.
 */
export async function uploadOutput(localPath, { contentType = 'video/mp4' } = {}) {
  const supabase = getSupabase();
  const data = await readFile(localPath);
  const suffix = Math.random().toString(36).slice(2, 10);
  const key = `${Date.now()}-${suffix}.mp4`;

  const { error: uploadErr } = await supabase
    .storage
    .from(OUTPUT_BUCKET)
    .upload(key, data, {
      contentType,
      cacheControl: '3600',
      upsert: false,
    });
  if (uploadErr) {
    throw new Error(`Storage upload failed: ${uploadErr.message}`);
  }

  const { data: pub } = supabase.storage.from(OUTPUT_BUCKET).getPublicUrl(key);
  if (!pub?.publicUrl) {
    throw new Error('Storage upload succeeded but public URL was empty.');
  }
  return pub.publicUrl;
}

export async function cleanupTmp(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try { await unlink(p); } catch { /* best-effort */ }
  }
}
