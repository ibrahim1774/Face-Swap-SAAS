/*
 * Long-form video editor worker — entrypoint stub.
 *
 * Real implementation arrives in Stage 2 of the build plan. For Stage 0
 * scaffolding, this file just logs that the worker started and idles
 * so `fly deploy` succeeds and the machine boots cleanly.
 *
 * Next step (Stage 2): replace this stub with the poll loop documented
 * in README.md — claim a `render_jobs` row, FFmpeg-render, settle.
 */

const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000', 10);

console.log('[worker] Stage 0 stub starting');
console.log('[worker] supabase url present:', !!process.env.SUPABASE_URL);
console.log('[worker] supabase service key present:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
console.log('[worker] assemblyai key present:', !!process.env.ASSEMBLYAI_API_KEY);
console.log('[worker] anthropic key present:', !!process.env.ANTHROPIC_API_KEY);
console.log('[worker] stripe key present:', !!process.env.STRIPE_SECRET_KEY);

// Heartbeat so Fly's process supervision sees a healthy event loop.
setInterval(() => {
  console.log('[worker] heartbeat — Stage 0 stub, no jobs polled yet');
}, POLL_INTERVAL_MS);
