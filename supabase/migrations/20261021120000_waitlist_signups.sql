create table if not exists public.waitlist_signups (
  id text primary key,
  name varchar(200) not null,
  company_name varchar(200),
  email varchar(320) not null unique,
  monthly_sends integer not null,
  willing_to_pay varchar(80) not null,
  created_at timestamptz not null default now()
);

create index if not exists ix_waitlist_signups_created on public.waitlist_signups (created_at desc);

alter table public.waitlist_signups enable row level security;
