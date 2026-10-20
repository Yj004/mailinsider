-- Per-thread follow-up cadence on outbound messages (3-day default until reply).
alter table public.messages add column if not exists parent_message_id text references public.messages (id) on delete set null;
alter table public.messages add column if not exists follow_up_count integer not null default 0;
alter table public.messages add column if not exists follow_up_index integer not null default 0;
alter table public.messages add column if not exists next_follow_up_at timestamptz;
alter table public.messages add column if not exists conversation_status varchar(32) not null default 'active';

create index if not exists ix_messages_parent on public.messages (parent_message_id);
create index if not exists ix_messages_next_follow_up on public.messages (workspace_id, next_follow_up_at);
create index if not exists ix_messages_conversation_status on public.messages (workspace_id, conversation_status);

-- Backfill active threads: next follow-up 3 days after last send.
update public.messages
set
  next_follow_up_at = coalesce(sent_at, created_at) + interval '3 days',
  conversation_status = 'awaiting_reply'
where parent_message_id is null
  and send_status in ('sent', 'partial')
  and next_follow_up_at is null
  and coalesce(conversation_status, 'active') not in ('ended', 'dead');
