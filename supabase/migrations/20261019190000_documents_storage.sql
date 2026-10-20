-- Private Supabase Storage bucket for MailInsider document uploads.
-- Bytes are never public; the API streams them after DocumentAccessToken checks.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  15728640,
  array[
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/webp',
    'text/plain'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- No anon/authenticated policies — only the service role key used by the API can read/write.
drop policy if exists "documents_service_all" on storage.objects;
-- Service role bypasses RLS; keep bucket private with zero public policies.