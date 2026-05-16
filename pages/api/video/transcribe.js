import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer';
import { submitTranscription, getTranscription } from '../../../lib/assemblyai';

/*
 * POST /api/video/transcribe
 *
 * Body: { sourceUrl: string }
 *
 * Submits the source video to AssemblyAI and creates a `video_transcripts`
 * row keyed to (user_id, source_url). If a transcript already exists for
 * this pair we return it directly (the user re-opened the editor for the
 * same upload — don't bill them twice).
 *
 * Response:
 *   { transcriptId, status, cached? }
 *
 * No credits are charged here — transcription cost is rolled into the
 * eventual render charge (30 cr/min source). If the render never
 * happens, AssemblyAI cost is on us (acceptable: small fraction of
 * margin).
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const { sourceUrl } = req.body || {};
  if (typeof sourceUrl !== 'string' || !sourceUrl.startsWith('https://')) {
    return res.status(400).json({ error: 'A valid https sourceUrl is required.' });
  }

  const admin = getSupabaseAdmin();
  const userId = session.user.id;

  // Cache lookup: same (user, source_url) → reuse the AssemblyAI job.
  // This makes the transcribing step idempotent across page refreshes
  // and lets the user bounce in and out of the editor without paying
  // for transcription twice on the same upload.
  try {
    const { data: existing } = await admin
      .from('video_transcripts')
      .select('id, transcript_id, status, transcript')
      .eq('user_id', userId)
      .eq('source_url', sourceUrl)
      .maybeSingle();

    if (existing && existing.transcript_id) {
      // If we never finished, check current state in case AssemblyAI
      // has completed it in the meantime.
      if (existing.status === 'completed') {
        return res.status(200).json({
          transcriptId: existing.transcript_id,
          status: 'completed',
          cached: true,
        });
      }
      try {
        const live = await getTranscription(existing.transcript_id);
        if (live.status !== existing.status) {
          await admin
            .from('video_transcripts')
            .update({
              status: live.status === 'error' ? 'error' : live.status,
              transcript: live.status === 'completed' ? live : existing.transcript,
              error_message: live.status === 'error' ? (live.error || null) : null,
            })
            .eq('id', existing.id);
        }
        return res.status(200).json({
          transcriptId: existing.transcript_id,
          status: live.status,
          cached: true,
        });
      } catch (pollErr) {
        console.warn('[transcribe] cached job re-check failed', pollErr.message);
        return res.status(200).json({
          transcriptId: existing.transcript_id,
          status: existing.status,
          cached: true,
        });
      }
    }
  } catch (lookupErr) {
    console.warn('[transcribe] cache lookup failed', lookupErr.message);
  }

  // No cache hit — submit a fresh transcription.
  let submitted;
  try {
    submitted = await submitTranscription({ audioUrl: sourceUrl });
  } catch (err) {
    console.error('[transcribe] submit failed', err.message);
    return res.status(502).json({ error: err.message || 'Transcription submission failed.' });
  }

  try {
    await admin
      .from('video_transcripts')
      .upsert(
        {
          user_id: userId,
          source_url: sourceUrl,
          transcript_id: submitted.id,
          status: submitted.status === 'error' ? 'error' : (submitted.status || 'queued'),
        },
        { onConflict: 'user_id,source_url' }
      );
  } catch (writeErr) {
    console.warn('[transcribe] DB upsert failed', writeErr.message);
    // Non-fatal: the job is already submitted to AssemblyAI; the client
    // can still poll via /api/video/transcript-status. We just won't
    // have a cached row.
  }

  return res.status(200).json({
    transcriptId: submitted.id,
    status: submitted.status,
    cached: false,
  });
}
