-- MailInsider application tables.
-- public.users is the app account table. It is not auth.users.
-- The API checks workspace membership. Row level security is on with no
-- policies, so the publishable key cannot read these tables.

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.users (
  id text primary key,
  email varchar(320) not null unique,
  password_hash varchar(255) not null,
  display_name varchar(120) not null,
  created_at timestamptz not null default now()
);

create table public.password_resets (
  id text primary key,
  user_id text not null references public.users (id) on delete cascade,
  token_hash varchar(64) not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.workspaces (
  id text primary key,
  name varchar(160) not null,
  created_by text not null references public.users (id),
  open_tracking_default boolean not null default true,
  link_tracking_default boolean not null default true,
  retention_days integer not null default 365,
  created_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id text not null references public.workspaces (id) on delete cascade,
  user_id text not null references public.users (id) on delete cascade,
  role varchar(20) not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.workspace_invites (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  email varchar(320) not null,
  role varchar(20) not null,
  invited_by text not null references public.users (id),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint uq_invite_workspace_email unique (workspace_id, email)
);

create table public.gmail_connections (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  connected_by text not null references public.users (id),
  google_account_email varchar(320) not null,
  google_subject_id varchar(255),
  encrypted_refresh_token text not null default '',
  granted_scopes jsonb not null default '[]'::jsonb,
  status varchar(32) not null default 'connected',
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.contacts (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  email varchar(320) not null,
  display_name varchar(160),
  created_at timestamptz not null default now(),
  constraint uq_contacts_workspace_email unique (workspace_id, email)
);

create table public.messages (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  created_by text not null references public.users (id),
  gmail_connection_id text references public.gmail_connections (id),
  from_email varchar(320),
  subject varchar(200) not null,
  body_format varchar(20) not null default 'plain',
  body_text text not null default '',
  body_html text,
  send_status varchar(32) not null default 'draft',
  error_code varchar(64),
  error_message text,
  open_tracking boolean not null default true,
  link_tracking boolean not null default true,
  is_sample boolean not null default false,
  idempotency_key varchar(80),
  document_id text,
  attach_pdf boolean not null default false,
  include_sheet_link boolean not null default false,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_messages_idempotency unique (workspace_id, idempotency_key)
);

create table public.message_recipients (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  message_id text not null references public.messages (id) on delete cascade,
  contact_id text references public.contacts (id),
  email_snapshot varchar(320) not null,
  display_name_snapshot varchar(160),
  recipient_type varchar(8) not null,
  send_status varchar(32) not null default 'draft',
  gmail_message_id varchar(128),
  error_code varchar(64),
  error_message text,
  attempt_count integer not null default 0,
  next_attempt_at timestamptz,
  rendered_html text,
  rendered_text text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tracking_links (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  message_recipient_id text not null references public.message_recipients (id) on delete cascade,
  token_hash varchar(64) not null unique,
  destination_url text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.open_tokens (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  message_id text not null references public.messages (id) on delete cascade,
  message_recipient_id text not null references public.message_recipients (id) on delete cascade,
  token_hash varchar(64) not null unique,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.document_assets (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  uploaded_by text not null references public.users (id),
  storage_path text not null,
  filename varchar(200) not null,
  content_type varchar(120) not null,
  size_bytes bigint not null,
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.document_access_tokens (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  document_id text not null references public.document_assets (id) on delete cascade,
  message_recipient_id text references public.message_recipients (id) on delete set null,
  token_hash varchar(64) not null unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.tracking_events (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  message_id text references public.messages (id) on delete cascade,
  message_recipient_id text references public.message_recipients (id) on delete cascade,
  document_id text references public.document_assets (id) on delete cascade,
  event_type varchar(64) not null,
  source varchar(32) not null,
  occurred_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  idempotency_key varchar(160),
  metadata jsonb not null default '{}'::jsonb
);

create unique index uq_events_idem on public.tracking_events (source, idempotency_key);

create table public.audit_logs (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  actor_user_id text references public.users (id),
  action varchar(80) not null,
  target_type varchar(40),
  target_id text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table public.oauth_states (
  state varchar(128) primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  user_id text not null references public.users (id) on delete cascade,
  code_verifier varchar(128) not null,
  purpose varchar(20) not null default 'gmail',
  spreadsheet_url text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table public.sheet_connections (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  connected_by text not null references public.users (id),
  google_account_email varchar(320) not null,
  spreadsheet_id varchar(128) not null,
  spreadsheet_title varchar(200) not null default 'Google Sheet',
  spreadsheet_url text not null default '',
  sheet_tab varchar(120) not null default 'Sheet1',
  encrypted_refresh_token text not null default '',
  granted_scopes jsonb not null default '[]'::jsonb,
  status varchar(32) not null default 'connected',
  is_demo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.sheet_logs (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  sheet_connection_id text not null references public.sheet_connections (id) on delete cascade,
  message_id text not null references public.messages (id) on delete cascade,
  message_recipient_id text not null unique references public.message_recipients (id) on delete cascade,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index ix_users_email on public.users (email);
create index ix_password_resets_user_id on public.password_resets (user_id);
create index ix_workspace_invites_workspace_id on public.workspace_invites (workspace_id);
create index ix_gmail_connections_workspace_id on public.gmail_connections (workspace_id);
create index ix_contacts_workspace_id on public.contacts (workspace_id);
create index ix_messages_workspace_id on public.messages (workspace_id);
create index ix_messages_workspace_created on public.messages (workspace_id, created_at);
create index ix_messages_workspace_status_created on public.messages (workspace_id, send_status, created_at);
create index ix_message_recipients_workspace_id on public.message_recipients (workspace_id);
create index ix_recipients_message on public.message_recipients (message_id);
create index ix_tracking_links_workspace_id on public.tracking_links (workspace_id);
create index ix_tracking_links_message_recipient_id on public.tracking_links (message_recipient_id);
create index ix_open_tokens_workspace_id on public.open_tokens (workspace_id);
create index ix_open_tokens_message_id on public.open_tokens (message_id);
create index ix_open_tokens_message_recipient_id on public.open_tokens (message_recipient_id);
create index ix_document_assets_workspace_id on public.document_assets (workspace_id);
create index ix_document_access_tokens_workspace_id on public.document_access_tokens (workspace_id);
create index ix_document_access_tokens_document_id on public.document_access_tokens (document_id);
create index ix_tracking_events_workspace_id on public.tracking_events (workspace_id);
create index ix_events_workspace_message_time on public.tracking_events (workspace_id, message_id, occurred_at);
create index ix_events_recipient_time on public.tracking_events (message_recipient_id, occurred_at);
create index ix_events_workspace_type_time on public.tracking_events (workspace_id, event_type, occurred_at);
create index ix_audit_logs_workspace_id on public.audit_logs (workspace_id);
create index ix_sheet_connections_workspace_id on public.sheet_connections (workspace_id);
create index ix_sheet_logs_workspace_id on public.sheet_logs (workspace_id);
create index ix_sheet_logs_message_id on public.sheet_logs (message_id);

create trigger gmail_connections_updated_at
before update on public.gmail_connections
for each row execute function public.set_updated_at();

create trigger messages_updated_at
before update on public.messages
for each row execute function public.set_updated_at();

create trigger message_recipients_updated_at
before update on public.message_recipients
for each row execute function public.set_updated_at();

create trigger sheet_connections_updated_at
before update on public.sheet_connections
for each row execute function public.set_updated_at();

alter table public.users enable row level security;
alter table public.password_resets enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;
alter table public.gmail_connections enable row level security;
alter table public.contacts enable row level security;
alter table public.messages enable row level security;
alter table public.message_recipients enable row level security;
alter table public.tracking_links enable row level security;
alter table public.open_tokens enable row level security;
alter table public.document_assets enable row level security;
alter table public.document_access_tokens enable row level security;
alter table public.tracking_events enable row level security;
alter table public.audit_logs enable row level security;
alter table public.oauth_states enable row level security;
alter table public.sheet_connections enable row level security;
alter table public.sheet_logs enable row level security;

-- Row counts. Run in the SQL editor; do not apply as a migration.
-- select 'users' as table_name, count(*) as rows from public.users
-- union all select 'password_resets', count(*) from public.password_resets
-- union all select 'workspaces', count(*) from public.workspaces
-- union all select 'workspace_members', count(*) from public.workspace_members
-- union all select 'workspace_invites', count(*) from public.workspace_invites
-- union all select 'gmail_connections', count(*) from public.gmail_connections
-- union all select 'sheet_connections', count(*) from public.sheet_connections
-- union all select 'sheet_logs', count(*) from public.sheet_logs
-- union all select 'contacts', count(*) from public.contacts
-- union all select 'messages', count(*) from public.messages
-- union all select 'message_recipients', count(*) from public.message_recipients
-- union all select 'document_assets', count(*) from public.document_assets
-- union all select 'document_access_tokens', count(*) from public.document_access_tokens
-- union all select 'open_tokens', count(*) from public.open_tokens
-- union all select 'tracking_links', count(*) from public.tracking_links
-- union all select 'tracking_events', count(*) from public.tracking_events
-- union all select 'audit_logs', count(*) from public.audit_logs
-- union all select 'oauth_states', count(*) from public.oauth_states
-- order by table_name;
--
-- Workspace data, without passwords or tokens:
-- select w.name as workspace, m.subject, m.send_status, m.attach_pdf,
--        m.include_sheet_link, m.sent_at, r.email_snapshot as recipient,
--        r.recipient_type, r.send_status as recipient_status,
--        g.google_account_email as gmail, g.is_demo as gmail_demo,
--        s.spreadsheet_title as sheet, s.is_demo as sheet_demo
-- from public.workspaces w
-- left join public.messages m on m.workspace_id = w.id
-- left join public.message_recipients r on r.message_id = m.id
-- left join public.gmail_connections g on g.id = m.gmail_connection_id
-- left join public.sheet_connections s on s.workspace_id = w.id and s.status = 'connected'
-- order by w.name, m.created_at desc;
