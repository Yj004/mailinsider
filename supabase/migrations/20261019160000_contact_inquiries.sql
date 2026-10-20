create table if not exists public.contact_inquiries (
  id text primary key,
  name varchar(200) not null,
  email varchar(320) not null,
  subject varchar(300) not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists ix_contact_inquiries_created on public.contact_inquiries (created_at desc);

alter table public.contact_inquiries enable row level security;
