import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { put } from '@vercel/blob';

/*
 * Worker storage helpers.
 *
 * Input videos live on Vercel Blob (uploaded by the browser via
 * /api/upload-token). Download with a plain fetch since they're
 * public.
 *
 * Output videos go BACK to Vercel Blob via @vercel/blob's `put()`
 * because that's where the rest of the app's media already lives —
 * keeps the URL surface uniform and the Supabase Storage egress
 * budget free for transcripts only.
 *
 * Requires BLOB_READ_WRITE_TOKEN as a Fly secret (same value used
 * by /api/upload-token on Vercel).
 */

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

export async function uploadOutput(localPath, { contentType = 'video/mp4' } = {}) {
  const data = await readFile(localPath);
  const key = `editor-renders/${Date.now()}.mp4`;
  const blob = await put(key, data, {
    access: 'public',
    contentType,
    addRandomSuffix: true,
  });
  return blob.url;
}

export async function cleanupTmp(...paths) {
  for (const p of paths) {
    if (!p) continue;
    try { await unlink(p); } catch { /* best-effort */ }
  }
}
