-- Long-form video editor: jobs queue + transcript cache
--
-- Two tables:
--   * render_jobs       — queue the Fly worker polls for FFmpeg renders.
--   * video_transcripts — AssemblyAI transcripts cached by source URL so
--                          re-opening the editor doesn't re-bill the user.
--
-- Both are user-scoped via RLS. Service-role inserts/updates from the
-- Vercel API routes and the Fly worker; anon role has no access.

-- ---------------------------------------------------------------------
-- render_jobs
-- ---------------------------------------------------------------------
-- Lifecycle: pending → processing → done | failed
-- The Fly worker claims the oldest 'pending' row via SELECT … FOR UPDATE
-- SKIP LOCKED, marks it 'processing', writes the output URL + status
-- 'done' on success, or refunds credits + 'failed' on error.
--
-- The watchdog (worker side) marks any row sitting in 'processing' for
-- > 20 min as 'failed' with a 'watchdog-timeout' error and refunds.

create table if not exists public.render_jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  source_url        text not null,
  source_seconds    double precision,
  edit_plan         jsonb not null,
  cost_credits      integer not null,
  status            text not null default 'pending'
                    check (status in ('pending','processing','done','failed')),
  output_url        text,
  error_code        text,
  error_message     text,
  refunded          boolean not null default false,
  created_at        timestamptz not null default now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz not null default now()
);

create index if not exists render_jobs_user_idx       on public.render_jobs(user_id);
create index if not exists render_jobs_status_idx     on public.render_jobs(status);
-- Worker's claim query: oldest pending first.
create index if not exists render_jobs_pending_created on public.render_jobs(created_at)
  where status = 'pending';
-- Watchdog scan: in-flight jobs ordered by when they started.
create index if not exists render_jobs_processing_started on public.render_jobs(started_at)
  where status = 'processing';

-- Auto-touch updated_at on every UPDATE.
create or replace function public.render_jobs_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists render_jobs_touch_updated_at on public.render_jobs;
create trigger render_jobs_touch_updated_at
before update on public.render_jobs
for each row execute function public.render_jobs_touch_updated_at();

alter table public.render_jobs enable row level security;

-- Users can read their own jobs (status polling from the browser).
drop policy if exists "render_jobs_select_own" on public.render_jobs;
create policy "render_jobs_select_own" on public.render_jobs
  for select using (auth.uid() = user_id);

-- Inserts + updates happen via the service role (Vercel API routes,
-- Fly worker). No browser-side writes.
drop policy if exists "render_jobs_no_anon_write" on public.render_jobs;
create policy "render_jobs_no_anon_write" on public.render_jobs
  for all using (false) with check (false);

-- ---------------------------------------------------------------------
-- video_transcripts
-- ---------------------------------------------------------------------
-- AssemblyAI transcript JSON keyed by (user, source_url). Stored so the
-- editor can re-open the same upload without re-transcribing (and
-- re-charging) the user. `transcript_id` is AssemblyAI's job id, kept
-- so a status-poll endpoint can resume long-running transcriptions.

create table if not exists public.video_transcripts (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  source_url      text not null,
  transcript_id   text,                          -- AssemblyAI id
  status          text not null default 'queued'
                  check (status in ('queued','processing','completed','error')),
  duration_sec    double precision,
  transcript      jsonb,                          -- full AssemblyAI payload once ready
  error_message   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, source_url)
);

create index if not exists video_transcripts_user_idx on public.video_transcripts(user_id);
create index if not exists video_transcripts_status_idx on public.video_transcripts(status);

drop trigger if exists video_transcripts_touch_updated_at on public.video_transcripts;
create or replace function public.video_transcripts_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
create trigger video_transcripts_touch_updated_at
before update on public.video_transcripts
for each row execute function public.video_transcripts_touch_updated_at();

alter table public.video_transcripts enable row level security;

drop policy if exists "video_transcripts_select_own" on public.video_transcripts;
create policy "video_transcripts_select_own" on public.video_transcripts
  for select using (auth.uid() = user_id);

drop policy if exists "video_transcripts_no_anon_write" on public.video_transcripts;
create policy "video_transcripts_no_anon_write" on public.video_transcripts
  for all using (false) with check (false);
