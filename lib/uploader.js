/*
 * Browser-only file uploader using Vercel Blob.
 *
 * Vercel serverless functions cap request bodies at 4.5 MB, so we
 * can't push videos through our own API. Instead the browser uses
 * @vercel/blob/client's `upload()` to:
 *   1. Hit /api/upload-token for a short-lived token.
 *   2. PUT the file directly to *.blob.vercel-storage.com.
 *   3. Return the public URL we then hand to Replicate.
 *
 * Requires BLOB_READ_WRITE_TOKEN in project env vars (auto-added by
 * Vercel when you create a Blob store under the Storage tab).
 */

import { upload } from '@vercel/blob/client';
import { log } from './debugLog';

/*
 * Browser-thrown error for content-moderation rejections. Pages can
 * catch this and surface a friendly "NSFW detected" message without
 * treating it as a generic upload failure.
 */
export class UploadModerationError extends Error {
  constructor(message, category) {
    super(message || 'Image flagged as NSFW. Pick a different photo.');
    this.code = 'BLOCKED_NSFW';
    this.category = category || 'sexual';
  }
}

async function moderateImageUrl(url) {
  const res = await fetch('/api/moderate-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (res.ok) return;
  let data = null;
  try { data = await res.json(); } catch {}
  if (data?.code === 'BLOCKED_NSFW') {
    throw new UploadModerationError(data.error, data.category);
  }
  // Non-block failure (5xx, network) — fail-open so users aren't
  // stranded by a transient classifier hiccup. Server-side check
  // still fires inside each generation route.
  log('warn', 'moderate-image non-block failure', { status: res.status });
}

/**
 * Upload a file to Vercel Blob and (for image MIMEs) run a synchronous
 * NSFW pre-screen via /api/moderate-image. On block: throws
 * UploadModerationError — caller should clear the UploadZone and show
 * err.message.
 *
 * @param file        The browser File / Blob
 * @param screenMode  'auto' (default) — screen images, skip non-images.
 *                    'force' — always screen.
 *                    'skip'  — never screen.
 */
export async function uploadTempFile(file, screenMode = 'auto') {
  log('info', 'upload start', { name: file.name, size: file.size, type: file.type });
  let blob;
  try {
    blob = await upload(file.name, file, {
      access: 'public',
      handleUploadUrl: '/api/upload-token',
    });
    log('info', 'upload ok', { name: file.name, url: blob.url });
  } catch (err) {
    log('error', 'upload failed', {
      name: file.name,
      message: err && err.message,
      stack: err && err.stack && err.stack.split('\n').slice(0, 4).join('\n'),
    });
    throw err;
  }

  const shouldScreen =
    screenMode === 'force' ||
    (screenMode === 'auto' && typeof file.type === 'string' && file.type.startsWith('image/'));
  if (shouldScreen) {
    await moderateImageUrl(blob.url);
  }
  return blob.url;
}
