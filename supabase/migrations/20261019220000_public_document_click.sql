-- Public edge-function helpers: resolve document / click tokens and record access.

create or replace function public.resolve_document_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tok public.document_access_tokens%rowtype;
  doc public.document_assets%rowtype;
  msg_id text;
begin
  if p_token_hash is null or length(trim(p_token_hash)) < 16 then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;

  select * into tok
  from public.document_access_tokens
  where token_hash = p_token_hash
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;

  if tok.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;

  if tok.expires_at is not null and tok.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  select * into doc
  from public.document_assets
  where id = tok.document_id
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;

  msg_id := null;
  if tok.message_recipient_id is not null then
    select message_id into msg_id
    from public.message_recipients
    where id = tok.message_recipient_id
    limit 1;
  end if;

  return jsonb_build_object(
    'ok', true,
    'token_id', tok.id,
    'workspace_id', tok.workspace_id,
    'document_id', doc.id,
    'message_id', msg_id,
    'message_recipient_id', tok.message_recipient_id,
    'storage_path', doc.storage_path,
    'content_type', coalesce(doc.content_type, 'application/octet-stream'),
    'filename', coalesce(doc.filename, 'document')
  );
end;
$$;

create or replace function public.record_document_access(
  p_token_hash text,
  p_event_type text default 'document_access_granted'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved jsonb;
  event_id text;
  idem text;
begin
  resolved := public.resolve_document_token(p_token_hash);
  if coalesce((resolved->>'ok')::boolean, false) is not true then
    return resolved;
  end if;

  idem := 'doc-access:' || (resolved->>'token_id') || ':' || to_char(now() at time zone 'utc', 'YYYYMMDDHH24');

  if exists (
    select 1 from public.tracking_events
    where workspace_id = resolved->>'workspace_id'
      and idempotency_key = idem
  ) then
    return resolved || jsonb_build_object('recorded', false, 'duplicate', true);
  end if;

  event_id := gen_random_uuid()::text;
  insert into public.tracking_events (
    id, workspace_id, message_id, message_recipient_id, document_id,
    event_type, source, occurred_at, idempotency_key, metadata
  ) values (
    event_id,
    resolved->>'workspace_id',
    nullif(resolved->>'message_id', ''),
    nullif(resolved->>'message_recipient_id', ''),
    resolved->>'document_id',
    p_event_type,
    'document_viewer',
    now(),
    idem,
    jsonb_build_object('counts_toward_metric', case when p_event_type = 'document_view_started' then 1 else 0 end)
  );

  return resolved || jsonb_build_object('recorded', true, 'event_id', event_id);
end;
$$;

create or replace function public.resolve_click_token(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  link public.tracking_links%rowtype;
  msg_id text;
begin
  if p_token_hash is null or length(trim(p_token_hash)) < 16 then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;

  select * into link
  from public.tracking_links
  where token_hash = p_token_hash
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown');
  end if;

  if link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'revoked');
  end if;

  msg_id := null;
  if link.message_recipient_id is not null then
    select message_id into msg_id
    from public.message_recipients
    where id = link.message_recipient_id
    limit 1;
  end if;

  return jsonb_build_object(
    'ok', true,
    'link_id', link.id,
    'workspace_id', link.workspace_id,
    'message_id', msg_id,
    'message_recipient_id', link.message_recipient_id,
    'destination_url', link.destination_url
  );
end;
$$;

create or replace function public.record_tracked_click(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  resolved jsonb;
  event_id text;
  host text;
begin
  resolved := public.resolve_click_token(p_token_hash);
  if coalesce((resolved->>'ok')::boolean, false) is not true then
    return resolved;
  end if;

  begin
    host := regexp_replace(resolved->>'destination_url', '^https?://([^/]+).*$', '\1');
  exception when others then
    host := '';
  end;

  event_id := gen_random_uuid()::text;
  insert into public.tracking_events (
    id, workspace_id, message_id, message_recipient_id, document_id,
    event_type, source, occurred_at, idempotency_key, metadata
  ) values (
    event_id,
    resolved->>'workspace_id',
    nullif(resolved->>'message_id', ''),
    nullif(resolved->>'message_recipient_id', ''),
    null,
    'tracked_link_requested',
    'redirect',
    now(),
    'click:' || (resolved->>'link_id') || ':' || floor(extract(epoch from now()) / 30)::text,
    jsonb_build_object(
      'counts_toward_metric', 1,
      'destination_host', host,
      'destination_url', resolved->>'destination_url',
      'confidence', 'observed'
    )
  )
  on conflict (source, idempotency_key) do nothing;

  return resolved || jsonb_build_object('recorded', true, 'event_id', event_id);
end;
$$;

grant execute on function public.resolve_document_token(text) to service_role;
grant execute on function public.record_document_access(text, text) to service_role;
grant execute on function public.resolve_click_token(text) to service_role;
grant execute on function public.record_tracked_click(text) to service_role;
