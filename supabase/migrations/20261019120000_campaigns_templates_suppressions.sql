-- Campaigns, templates, suppressions, and contact/message columns
-- added after the base MailInsider schema.

alter table public.contacts
  add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table public.contacts
  add column if not exists source varchar(40);

alter table public.contacts
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.email_templates (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  created_by text not null references public.users (id),
  name varchar(160) not null,
  subject varchar(200) not null default '',
  body_text text not null default '',
  body_html text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaigns (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  created_by text not null references public.users (id),
  name varchar(160) not null,
  subject varchar(200) not null default '',
  body_text text not null default '',
  body_html text,
  status varchar(32) not null default 'draft',
  template_id text references public.email_templates (id) on delete set null,
  message_id text,
  open_tracking boolean not null default true,
  link_tracking boolean not null default true,
  gmail_connection_id text references public.gmail_connections (id),
  document_id text,
  attach_pdf boolean not null default false,
  include_sheet_link boolean not null default false,
  error_message text,
  launched_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campaign_recipients (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  campaign_id text not null references public.campaigns (id) on delete cascade,
  contact_id text references public.contacts (id),
  email varchar(320) not null,
  display_name varchar(160),
  custom_fields jsonb not null default '{}'::jsonb,
  status varchar(32) not null default 'pending',
  skip_reason varchar(64),
  created_at timestamptz not null default now(),
  constraint uq_campaign_recipient_email unique (campaign_id, email)
);

create table if not exists public.suppressions (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  email varchar(320) not null,
  reason varchar(40) not null default 'unsubscribe',
  source varchar(40) not null default 'user',
  message_id text,
  created_at timestamptz not null default now(),
  constraint uq_suppression_workspace_email unique (workspace_id, email)
);

create table if not exists public.unsubscribe_tokens (
  id text primary key,
  workspace_id text not null references public.workspaces (id) on delete cascade,
  message_recipient_id text not null references public.message_recipients (id) on delete cascade,
  email varchar(320) not null,
  token_hash varchar(64) not null unique,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.messages
  add column if not exists attach_pdf boolean not null default false;

alter table public.messages
  add column if not exists include_sheet_link boolean not null default false;

alter table public.messages
  add column if not exists campaign_id text references public.campaigns (id) on delete set null;

alter table public.messages
  add column if not exists template_id text references public.email_templates (id) on delete set null;

create index if not exists ix_email_templates_workspace_id on public.email_templates (workspace_id);
create index if not exists ix_campaigns_workspace_id on public.campaigns (workspace_id);
create index if not exists ix_campaigns_workspace_created on public.campaigns (workspace_id, created_at);
create index if not exists ix_campaign_recipients_workspace_id on public.campaign_recipients (workspace_id);
create index if not exists ix_campaign_recipients_campaign on public.campaign_recipients (campaign_id);
create index if not exists ix_suppressions_workspace_id on public.suppressions (workspace_id);
create index if not exists ix_unsubscribe_tokens_workspace_id on public.unsubscribe_tokens (workspace_id);
create index if not exists ix_unsubscribe_tokens_message_recipient_id on public.unsubscribe_tokens (message_recipient_id);
create index if not exists ix_messages_campaign_id on public.messages (campaign_id);

drop trigger if exists email_templates_updated_at on public.email_templates;
create trigger email_templates_updated_at
before update on public.email_templates
for each row execute function public.set_updated_at();

drop trigger if exists campaigns_updated_at on public.campaigns;
create trigger campaigns_updated_at
before update on public.campaigns
for each row execute function public.set_updated_at();

drop trigger if exists contacts_updated_at on public.contacts;
create trigger contacts_updated_at
before update on public.contacts
for each row execute function public.set_updated_at();

alter table public.email_templates enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.suppressions enable row level security;
alter table public.unsubscribe_tokens enable row level security;
