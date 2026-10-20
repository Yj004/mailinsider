-- Best-case open tracking:
-- 1) Always store the pixel hit (hit_count, UA, IP).
-- 2) Do not count GETs in the first 90s after send (Gmail image-proxy prefetch).
-- 3) Promote to a counted open on a later GET after the grace window.
-- 4) HEAD never counts.

drop function if exists public.record_open_pixel(text);
drop function if exists public.record_open_pixel(text, text, text);

create or replace function public.record_open_pixel(
  p_token_hash text,
  p_user_agent text default null,
  p_client_ip text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tok public.open_tokens%rowtype;
  peer_email text;
  msg_sent_at timestamptz;
  recent_count int;
  winner_message_id text;
  evt public.tracking_events%rowtype;
  evt_id text;
  counts int := 1;
  automated int := 0;
  early int := 0;
  proxy int := 0;
  hits int := 1;
  since timestamptz := now() - interval '45 seconds';
  ua text := coalesce(p_user_agent, '');
  already_counts boolean := false;
begin
  select * into tok
  from public.open_tokens
  where token_hash = p_token_hash
    and revoked_at is null
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'missing_or_revoked');
  end if;

  if lower(ua) like '%googleimageproxy%'
     or lower(ua) like '%ggpht.com%'
     or lower(ua) like '%google-proxy%'
     or lower(ua) like '%yahoomailproxy%' then
    proxy := 1;
  end if;

  select m.sent_at into msg_sent_at
  from public.messages m
  where m.id = tok.message_id;

  -- Gmail image proxy often fetches seconds after delivery.
  if msg_sent_at is not null and now() < msg_sent_at + interval '90 seconds' then
    counts := 0;
    automated := 1;
    early := 1;
  end if;

  -- Existing row for this GIF token?
  select * into evt
  from public.tracking_events
  where source = 'tracking_pixel'
    and idempotency_key = 'open-pixel:' || p_token_hash
  limit 1;

  if found then
    hits := coalesce((evt.metadata->>'hit_count')::int, 1) + 1;
    already_counts := coalesce((evt.metadata->>'counts_toward_metric')::int, 0) = 1;

    update public.tracking_events
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'hit_count', hits,
      'last_hit_at', now(),
      'user_agent', left(ua, 240),
      'client_ip', left(coalesce(p_client_ip, ''), 64),
      'proxy_ua', proxy,
      -- Promote early/suppressed first hit when a later GET arrives after grace.
      'counts_toward_metric', case
        when already_counts then 1
        when counts = 1 then 1
        else coalesce((metadata->>'counts_toward_metric')::int, 0)
      end,
      'possible_automated', case
        when already_counts then 0
        when counts = 1 then 0
        else coalesce((metadata->>'possible_automated')::int, 1)
      end,
      'early_open', case
        when already_counts then 0
        when counts = 1 then 0
        else coalesce((metadata->>'early_open')::int, 0)
      end,
      'promoted_at', case
        when (not already_counts) and counts = 1 then to_jsonb(now()::text)
        else metadata->'promoted_at'
      end,
      'promoted_from', case
        when (not already_counts) and counts = 1 then '"pixel_hit"'::jsonb
        else metadata->'promoted_from'
      end
    )
    where id = evt.id
    returning * into evt;

    return jsonb_build_object(
      'ok', true,
      'message_id', tok.message_id,
      'event_id', evt.id,
      'counted', coalesce((evt.metadata->>'counts_toward_metric')::int, 0) = 1,
      'hit_count', hits,
      'promoted', (not already_counts) and counts = 1
    );
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
      'counts_toward_metric', counts,
      'possible_automated', automated,
      'early_open', early,
      'proxy_ua', proxy,
      'hit_count', 1,
      'first_hit_at', now(),
      'last_hit_at', now(),
      'user_agent', left(ua, 240),
      'client_ip', left(coalesce(p_client_ip, ''), 64)
    )
  );

  -- Cross-message prefetch: same address, multiple counted opens within 45s →
  -- keep counted open only on the most recently sent message.
  if peer_email is not null and counts = 1 then
    select count(distinct te.message_id) into recent_count
    from public.tracking_events te
    join public.message_recipients mr on mr.id = te.message_recipient_id
    where te.workspace_id = tok.workspace_id
      and te.event_type = 'open_pixel_requested'
      and te.occurred_at >= since
      and lower(mr.email_snapshot) = lower(peer_email)
      and coalesce((te.metadata->>'counts_toward_metric')::int, 1) = 1;

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
          and coalesce((te.metadata->>'counts_toward_metric')::int, 1) = 1
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
        and lower(mr.email_snapshot) = lower(peer_email)
        and coalesce((te.metadata->>'early_open')::int, 0) = 0;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'message_id', tok.message_id,
    'event_id', evt_id,
    'counted', counts = 1,
    'early_open', early = 1,
    'hit_count', 1
  );
end;
$$;

revoke all on function public.record_open_pixel(text, text, text) from public;
grant execute on function public.record_open_pixel(text, text, text) to service_role;
-- Keep single-arg form working for older callers.
create or replace function public.record_open_pixel(p_token_hash text)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select public.record_open_pixel(p_token_hash, null::text, null::text);
$$;
revoke all on function public.record_open_pixel(text) from public;
grant execute on function public.record_open_pixel(text) to service_role;
