# Haelabs Long-Form Video Editor — Fly Worker

Background worker for the long-form Video Editor feature. Polls Supabase's `render_jobs` table for pending jobs, downloads the source video from Supabase Storage, runs a single-pass FFmpeg render (auto-cut + subtitles + transitions + auto-zoom + audio cleanup), uploads the output back, and marks the job done.

Lives outside Vercel because Vercel functions cap at 60–300s and FFmpeg renders for long-form videos take 3–15 minutes.

## Runtime layout

```
worker/
  index.js          Main loop: poll → claim → download → render → upload → settle
  render.js         Builds the single FFmpeg filter chain from edit_plan JSON
  transcribe.js     Submits jobs to AssemblyAI + polls for completion (Stage 1)
  subtitles.js      ASS subtitle template engine (Stage 3)
  fonts/            Bundled fonts (don't load from URLs at render time)
  Dockerfile        Node + FFmpeg + fonts
  fly.toml          Fly app config: shared-cpu-2x, 2 GB, auto-stop/start
  package.json
```

## Lifecycle of one job

1. Poll `render_jobs` `WHERE status='pending' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`.
2. Update row → `status='processing'`, `started_at=now()`.
3. Download `source_url` (Supabase Storage signed URL) to `/tmp/<job_id>.mp4`.
4. Build one FFmpeg command from `edit_plan`. **Single pass only.** Every re-encode loses quality and time.
5. Run FFmpeg. Stream stderr to logs for observability.
6. Upload output MP4 to Supabase Storage (`renders/<job_id>.mp4`).
7. Update row → `status='done'`, `output_url=...`, `finished_at=now()`.
8. On failure: update row → `status='failed'`, `error_code`/`error_message`, fire credit refund via Stripe customer metadata (`videoEditorCreditsRemaining` += `cost_credits`), set `refunded=true`.

## Watchdog

Every 60s, scan `WHERE status='processing' AND started_at < now() - interval '20 minutes'`. Mark as failed with `error_code='watchdog-timeout'` and refund.

## Secrets (set via `fly secrets set`)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`  (service role — full Storage + table access; worker uses this for both render_jobs queue ops AND uploading output MP4s to the `editor-renders` bucket)
- `STRIPE_SECRET_KEY`          (refund flow writes to customer metadata)
- `ASSEMBLYAI_API_KEY`         (Stage 3+ — transcription is currently fired from Vercel)
- `ANTHROPIC_API_KEY`          (Stage 4 — chat-driven plan revisions run on the worker)

Inputs are pulled from Vercel Blob via plain `fetch` (URLs are public,
no auth needed). Outputs are written to Supabase Storage so the worker
has exactly one cross-service credential to manage.

## Deploy

First-time:
```
cd worker
fly launch --no-deploy --copy-config
# edit fly.toml region, machine size if needed
fly secrets set SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ASSEMBLYAI_API_KEY=... ANTHROPIC_API_KEY=... STRIPE_SECRET_KEY=...
fly deploy
```

Subsequent:
```
cd worker && fly deploy
```

## Local dev

```
cd worker
npm install
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... ASSEMBLYAI_API_KEY=... npm start
```

Or rendering-only smoke test with no Supabase poll loop:
```
node render.js --input sample.mp4 --plan plan.json --output out.mp4
```

## Stages (per build plan)

- **Stage 1** — `transcribe.js`, no rendering yet. Just submit → poll → write `video_transcripts.transcript` JSON.
- **Stage 2** — `render.js` end-to-end with cut + caption operations. **MVP.**
- **Stage 3** — Subtitle style templates, auto-zoom (MediaPipe face detect), vertical reframe.
- **Stage 4** — AI transition placer, chat-driven plan revisions.
- **Stage 5** — Audio-only mode, retention cron, concurrent worker scale-up.

See `/Users/ibrahim/.claude/plans/i-want-to-create-purring-castle.md` and the long-form upgrade prompt for full context.

## What NOT to do

- **Multi-pass FFmpeg.** Build one filter chain that does everything in one command. Multiple passes lose quality and waste time.
- **Loading fonts at runtime.** Bundle fonts into the Docker image at build time — ASS subtitle styles fall back silently if a font isn't found.
- **Hitting AssemblyAI from the Vercel API.** Only fire AssemblyAI from this worker so the long-poll lives off-Vercel.
- **Forgetting to refund on failure.** Every failed render must refund `cost_credits` to the customer's `videoEditorCreditsRemaining` and set `refunded=true`.
