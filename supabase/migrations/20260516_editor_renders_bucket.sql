-- Long-form video editor: storage bucket for finished renders.
--
-- The Fly worker writes the final MP4 here after FFmpeg finishes.
-- Bucket is PUBLIC so the editor page can <video src="..."> the
-- output URL directly without signing — the URL is unguessable
-- (timestamp + random suffix) and ephemeral (retention cron in
-- Stage 5 will purge after 7 days).
--
-- Idempotent: re-running is safe.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'editor-renders',
  'editor-renders',
  true,
  -- 2 GB hard cap on a single render output. The 30-min source cap
  -- + libx264 CRF 22 produces ~500 MB outputs; 2 GB is loose headroom.
  2147483648,
  array['video/mp4','video/quicktime','video/webm']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public read policy for the bucket. Writes are service-role only
-- (worker uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS, so we
-- don't need an explicit insert policy for it).
drop policy if exists "editor_renders_public_read" on storage.objects;
create policy "editor_renders_public_read" on storage.objects
  for select using (bucket_id = 'editor-renders');
