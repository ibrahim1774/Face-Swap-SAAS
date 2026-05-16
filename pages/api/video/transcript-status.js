import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer';
import { getTranscription, buildPreviewModel } from '../../../lib/assemblyai';

/*
 * GET /api/video/transcript-status?transcriptId=...
 *
 * Polls AssemblyAI for a transcript's current state and, when complete,
 * persists the full payload to `video_transcripts` and returns the
 * preview model (words with isFiller + leadingSilenceMs flags).
 *
 * Response shapes:
 *   in-flight:  { status: 'queued' | 'processing' }
 *   error:      { status: 'error', errorMessage }
 *   ready:      {
 *                 status: 'completed',
 *                 durationSec,
 *                 preview: { words: [...] },
 *                 chapters,
 *                 sentiment,
 *                 entities,
 *                 speakers,
 *               }
 *
 * Authorization: the transcriptId is paired against the caller's
 * user_id in video_transcripts. Anyone else asking for it gets 403.
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const transcriptId = typeof req.query.transcriptId === 'string'
    ? req.query.transcriptId
    : null;
  if (!transcriptId) {
    return res.status(400).json({ error: 'transcriptId is required.' });
  }

  const admin = getSupabaseAdmin();
  const userId = session.user.id;

  // Auth check: this transcript must belong to the caller.
  const { data: row } = await admin
    .from('video_transcripts')
    .select('id, status, transcript, error_message, duration_sec, source_url, user_id')
    .eq('transcript_id', transcriptId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!row) {
    return res.status(403).json({ error: 'Transcript not found for this user.' });
  }

  // Fast path: already cached as completed.
  if (row.status === 'completed' && row.transcript) {
    return res.status(200).json(shapeCompletedResponse(row.transcript));
  }

  // Otherwise poll AssemblyAI.
  let live;
  try {
    live = await getTranscription(transcriptId);
  } catch (err) {
    return res.status(502).json({
      status: 'error',
      errorMessage: err.message || 'Transcription poll failed.',
    });
  }

  if (live.status === 'completed') {
    try {
      await admin
        .from('video_transcripts')
        .update({
          status: 'completed',
          transcript: live,
          duration_sec: typeof live.audio_duration === 'number' ? live.audio_duration : null,
          error_message: null,
        })
        .eq('id', row.id);
    } catch (writeErr) {
      console.warn('[transcript-status] DB update failed', writeErr.message);
    }
    return res.status(200).json(shapeCompletedResponse(live));
  }

  if (live.status === 'error') {
    try {
      await admin
        .from('video_transcripts')
        .update({
          status: 'error',
          error_message: live.error || 'Unknown AssemblyAI error.',
        })
        .eq('id', row.id);
    } catch {}
    return res.status(200).json({
      status: 'error',
      errorMessage: live.error || 'Transcription failed.',
    });
  }

  // queued | processing — keep the row's status synced.
  if (live.status !== row.status) {
    try {
      await admin
        .from('video_transcripts')
        .update({ status: live.status })
        .eq('id', row.id);
    } catch {}
  }
  return res.status(200).json({ status: live.status });
}

function shapeCompletedResponse(transcript) {
  const preview = buildPreviewModel(transcript);
  return {
    status: 'completed',
    durationSec: typeof transcript.audio_duration === 'number'
      ? transcript.audio_duration
      : null,
    preview,
    chapters: Array.isArray(transcript.chapters) ? transcript.chapters : [],
    sentiment: Array.isArray(transcript.sentiment_analysis_results)
      ? transcript.sentiment_analysis_results
      : [],
    entities: Array.isArray(transcript.entities) ? transcript.entities : [],
    text: transcript.text || '',
  };
}
