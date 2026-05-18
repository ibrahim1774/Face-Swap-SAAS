import { getUserFromRequest } from '../../lib/supabaseServer';
import { screenImage, ModerationError, moderationErrorResponse } from '../../lib/moderation';

/*
 * Thin endpoint the client calls right after `uploadTempFile` resolves
 * — before showing the success state — so a flagged image clears the
 * upload zone instead of letting the user advance to the next step
 * with an invalid input.
 *
 * Body: { url: string }   — Vercel Blob public URL from uploadTempFile
 * Returns: { ok: true } | 400 { error, code: 'BLOCKED_NSFW', category }
 *
 * The result is cached server-side (moderation_results table), so the
 * later screenImage() call inside a generation route is free.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Anon-friendly: /ugc and /image-to-video allow anon uploads up to
  // the paywall. We still moderate those — better to clear bad images
  // before a non-paying user tries to sign up to use them.
  await getUserFromRequest(req, res);

  const { url } = req.body || {};
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    return res.status(400).json({ error: 'Valid https url required.' });
  }

  try {
    await screenImage(url);
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof ModerationError) {
      return moderationErrorResponse(res, err);
    }
    console.error('[moderate-image] threw', err);
    return res.status(500).json({ error: 'Moderation check failed.' });
  }
}
