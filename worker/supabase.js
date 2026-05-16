import { createClient } from '@supabase/supabase-js';

/*
 * Service-role Supabase client for the Fly worker. Bypasses RLS so the
 * worker can claim render_jobs rows, update their status, and read
 * any user's row.
 *
 * Env required:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY  (NOT the anon key)
 */

let cached = null;

export function getSupabase() {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
