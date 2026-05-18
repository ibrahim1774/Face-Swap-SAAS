-- Image-moderation result cache.
--
-- Vercel Blob URLs (and other content-addressed image hosts) never
-- change their contents at a given URL, so we cache classifier
-- verdicts indefinitely. Repeat uses (storyboard scenes pointing at
-- the same upload, retries, multi-step UGC flows) short-circuit
-- without re-billing Anthropic.
--
-- The `url_hash` is sha256(url) truncated to 32 hex chars (16 bytes).
-- Keyed on the hash so very long Blob URLs don't blow up the index.

create table if not exists public.moderation_results (
  url_hash text primary key,
  url text not null,
  sexual boolean not null default false,
  minor boolean not null default false,
  reason text,
  created_at timestamptz not null default now()
);

-- Service-role-only access. The table is touched only by server-side
-- routes (lib/moderation.js via getSupabaseAdmin). No anon/auth reads.
alter table public.moderation_results enable row level security;

-- No policies defined: with RLS enabled and no SELECT/INSERT/UPDATE
-- policies, only the service role (which bypasses RLS) can read or
-- write. This is intentional.
