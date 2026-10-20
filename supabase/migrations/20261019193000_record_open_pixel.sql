-- Record an open only for the GIF token's message (unique per email send).
-- Suppresses Gmail cross-message image prefetch within a short window.

create or replace function public.record_open_pixel(p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tok public.open_tokens%rowtype;
  peer_email text;
  recent_count int;
  winner_message_id text;
  evt_id text;
  since timestamptz := now() - interval '45 seconds';
begin
  select * into tok
  from public.open_tokens
  where token_hash = p_token_hash
    and revoked_at is null
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'missing_or_revoked');
  end if;

  -- One counted event per GIF token (unique pixel per send).
  if exists (
    select 1 from public.tracking_events
    where source = 'tracking_pixel'
      and idempotency_key = 'open-pixel:' || p_token_hash
  ) then
    return jsonb_build_object('ok', true, 'reason', 'already_recorded', 'message_id', tok.message_id);
  end if;

  select mr.email_snapshot into peer_email
  from public.message_recipients mr
  where mr.id = tok.message_recipient_id;

  evt_id := gen_random_uuid()::text;

  insert into public.tracking_events (
    id, workspace_id, message_id, message_recipient_id, event_type, source,
    occurred_at, idempotency_key, metadata
  ) values (
    evt_id,
    tok.workspace_id,
    tok.message_id,
    tok.message_recipient_id,
    'open_pixel_requested',
    'tracking_pixel',
    now(),
    'open-pixel:' || p_token_hash,
    jsonb_build_object(
      'counts_toward_metric', 1,
      'possible_automated', 0
    )
  );

  -- If the same address got opens on multiple messages within 45s (Gmail prefetch),
  -- keep only the most recently sent message's open as counted.
  if peer_email is not null then
    select count(distinct te.message_id) into recent_count
    from public.tracking_events te
    join public.message_recipients mr on mr.id = te.message_recipient_id
    where te.workspace_id = tok.workspace_id
      and te.event_type = 'open_pixel_requested'
      and te.occurred_at >= since
      and lower(mr.email_snapshot) = lower(peer_email);

    if recent_count > 1 then
      select m.id into winner_message_id
      from public.messages m
      where m.id in (
        select distinct te.message_id
        from public.tracking_events te
        join public.message_recipients mr on mr.id = te.message_recipient_id
        where te.workspace_id = tok.workspace_id
          and te.event_type = 'open_pixel_requested'
          and te.occurred_at >= since
          and lower(mr.email_snapshot) = lower(peer_email)
          and te.message_id is not null
      )
      order by coalesce(m.sent_at, m.created_at) desc
      limit 1;

      update public.tracking_events te
      set metadata = coalesce(te.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'counts_toward_metric', case when te.message_id = winner_message_id then 1 else 0 end,
          'possible_automated', case when te.message_id = winner_message_id then 0 else 1 end,
          'prefetch_suppressed', case when te.message_id = winner_message_id then 0 else 1 end
        )
      from public.message_recipients mr
      where te.message_recipient_id = mr.id
        and te.workspace_id = tok.workspace_id
        and te.event_type = 'open_pixel_requested'
        and te.occurred_at >= since
        and lower(mr.email_snapshot) = lower(peer_email);
    end if;
  end if;

  return jsonb_build_object('ok', true, 'message_id', tok.message_id, 'event_id', evt_id);
end;
$$;

revoke all on function public.record_open_pixel(text) from public;
grant execute on function public.record_open_pixel(text) to service_role;
