-- Job-hunting CRM fields on contacts.

alter table public.contacts add column if not exists company varchar(160);
alter table public.contacts add column if not exists job_title varchar(160);
alter table public.contacts add column if not exists linkedin_url text;
alter table public.contacts add column if not exists company_website text;
alter table public.contacts add column if not exists job_posting_url text;
alter table public.contacts add column if not exists target_role varchar(160);
alter table public.contacts add column if not exists pipeline_status varchar(40) not null default 'to_contact';
alter table public.contacts add column if not exists notes text;
alter table public.contacts add column if not exists tags jsonb not null default '[]'::jsonb;
alter table public.contacts add column if not exists last_contacted_at timestamptz;
alter table public.contacts add column if not exists next_follow_up_at timestamptz;

create index if not exists ix_contacts_pipeline_status on public.contacts (workspace_id, pipeline_status);
create index if not exists ix_contacts_next_follow_up on public.contacts (workspace_id, next_follow_up_at);
