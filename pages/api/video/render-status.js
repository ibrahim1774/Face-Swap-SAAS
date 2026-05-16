import { getUserFromRequest, getSupabaseAdmin } from '../../../lib/supabaseServer';

/*
 * GET ?renderId=… → { status, progress, outputUrl, errorMessage, cost }
 *
 * Reads the new render_jobs queue (Stage 2 onwards). status values:
 *   'pending'    → queued, worker hasn't claimed yet
 *   'processing' → worker is rendering
 *   'done'       → output_url populated
 *   'failed'     → error_code/error_message populated; credits refunded
 *
 * Translates the queue's status names to the legacy progress field the
 * editor page already polls against:
 *   pending    → progress 0.05 (so the progress bar shows up)
 *   processing → progress 0.4
 *   done       → progress 1.0, status 'completed'
 *   failed     → progress 1.0, status 'failed'
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getUserFromRequest(req, res);
  if (!session) return res.status(401).json({ error: 'Authentication required.' });

  const { renderId } = req.query;
  if (!renderId || typeof renderId !== 'string') {
    return res.status(400).json({ error: 'renderId required' });
  }

  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('render_jobs')
    .select('id, user_id, status, output_url, error_code, error_message, cost_credits, started_at, finished_at')
    .eq('id', renderId)
    .maybeSingle();

  if (error) {
    console.error('[video/render-status] supabase lookup failed', error.message);
    return res.status(500).json({ error: 'Could not fetch render status.' });
  }
  if (!data) {
    return res.status(404).json({ error: 'Render not found.' });
  }
  if (data.user_id !== session.user.id) {
    return res.status(403).json({ error: 'Forbidden.' });
  }

  const progress =
    data.status === 'done' ? 1
    : data.status === 'failed' ? 1
    : data.status === 'processing' ? 0.4
    : 0.05;

  const uiStatus =
    data.status === 'done' ? 'completed'
    : data.status === 'failed' ? 'failed'
    : 'rendering'; // the page treats pending + processing the same

  return res.status(200).json({
    status: uiStatus,
    progress,
    outputUrl: data.output_url || null,
    errorMessage: data.error_message || null,
    errorCode: data.error_code || null,
    cost: data.cost_credits || 0,
  });
}
