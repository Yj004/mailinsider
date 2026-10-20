-- Gmail thread id on outbound messages + synced recipient replies.
alter table public.messages add column if not exists gmail_thread_id varchar(128);
alter table public.messages add column if not exists rfc_message_id varchar(320);

create index if not exists ix_messages_gmail_thread on public.messages (workspace_id, gmail_thread_id);

create table if not exists public.message_replies (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  message_id text not null references public.messages (id) on delete cascade,
  gmail_message_id varchar(128) not null,
  gmail_thread_id varchar(128),
  rfc_message_id varchar(320),
  direction varchar(16) not null default 'inbound',
  from_email varchar(320) not null,
  from_name varchar(160),
  to_email varchar(320),
  subject varchar(500),
  snippet text,
  body_text text,
  body_html text,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, gmail_message_id)
);

alter table public.message_replies add column if not exists rfc_message_id varchar(320);

create index if not exists ix_message_replies_message on public.message_replies (message_id, occurred_at);
create index if not exists ix_message_replies_workspace on public.message_replies (workspace_id, occurred_at desc);
