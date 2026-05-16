import { getSupabase } from './supabase.js';
import { refundVideoEditorCredits } from './refund.js';

/*
 * render_jobs claim + settle helpers.
 *
 * `claimNext()` atomically grabs the oldest pending job and marks it
 * 'processing'. Implemented with PostgREST's "update where status = pending"
 * filter — Postgres serializes this naturally, and since we only run
 * 1 worker initially, there's no lock contention. When Stage 5 scales
 * to multiple workers, swap to an RPC that uses SELECT FOR UPDATE
 * SKIP LOCKED.
 *
 * Watchdog: scans for rows stuck in 'processing' beyond a threshold
 * and fails them (worker may have crashed mid-render).
 */

const WATCHDOG_TIMEOUT_MS = parseInt(
  process.env.WATCHDOG_TIMEOUT_MS || '1200000', // 20 min
  10
);

/**
 * Claim the oldest pending job by:
 *   1. SELECT the oldest pending row's id
 *   2. UPDATE ... WHERE id = ? AND status = 'pending' RETURNING *
 *
 * If two workers race on step 2, only one update returns a row; the
 * other gets nothing and tries again next poll. No double-claim
 * possible.
 *
 * Returns the row or null if nothing pending.
 */
export async function claimNext() {
  const supabase = getSupabase();
  const { data: candidates, error: selErr } = await supabase
    .from('render_jobs')
    .select('id')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(1);
  if (selErr) {
    console.error('[jobs] select failed', selErr.message);
    return null;
  }
  if (!candidates || candidates.length === 0) return null;
  const id = candidates[0].id;
  const { data: claimed, error: updErr } = await supabase
    .from('render_jobs')
    .update({ status: 'processing', started_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select()
    .maybeSingle();
  if (updErr) {
    console.error('[jobs] claim update failed', updErr.message);
    return null;
  }
  return claimed || null;
}

export async function markDone(jobId, outputUrl) {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('render_jobs')
    .update({
      status: 'done',
      output_url: outputUrl,
      finished_at: new Date().toISOString(),
      error_code: null,
      error_message: null,
    })
    .eq('id', jobId);
  if (error) console.error('[jobs] markDone failed', error.message);
}

/**
 * Mark a job failed AND refund the credit charge. Idempotent on the
 * refund: we only refund if `refunded` was false.
 */
export async function markFailed(jobId, { code, message }) {
  const supabase = getSupabase();
  const { data: row, error: readErr } = await supabase
    .from('render_jobs')
    .select('id, stripe_customer_id, cost_credits, refunded, status')
    .eq('id', jobId)
    .maybeSingle();
  if (readErr || !row) {
    console.error('[jobs] markFailed read failed', readErr?.message);
    return;
  }
  let refundedNow = row.refunded;
  if (!row.refunded && row.stripe_customer_id && row.cost_credits > 0) {
    try {
      await refundVideoEditorCredits({
        customerId: row.stripe_customer_id,
        amount: row.cost_credits,
      });
      refundedNow = true;
    } catch (refundErr) {
      console.error('[jobs] refund failed', refundErr.message);
    }
  }
  const { error: updErr } = await supabase
    .from('render_jobs')
    .update({
      status: 'failed',
      error_code: code || 'unknown',
      error_message: message || 'Render failed.',
      finished_at: new Date().toISOString(),
      refunded: refundedNow,
    })
    .eq('id', jobId);
  if (updErr) console.error('[jobs] markFailed update', updErr.message);
}

/**
 * Watchdog scan: any row sitting in 'processing' beyond the timeout
 * gets failed + refunded.
 */
export async function scanWatchdog() {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - WATCHDOG_TIMEOUT_MS).toISOString();
  const { data: stuck, error } = await supabase
    .from('render_jobs')
    .select('id')
    .eq('status', 'processing')
    .lt('started_at', cutoff);
  if (error) {
    console.error('[jobs] watchdog scan failed', error.message);
    return;
  }
  if (!stuck || stuck.length === 0) return;
  for (const row of stuck) {
    console.warn('[jobs] watchdog timing out job', row.id);
    await markFailed(row.id, {
      code: 'watchdog-timeout',
      message: `Render exceeded ${Math.round(WATCHDOG_TIMEOUT_MS / 1000)}s wall-time.`,
    });
  }
}
