-- 1x1 transparent GIF used by the public open-pixel Edge Function.
create table public.tracking_pixel_assets (
  id text primary key,
  content_type varchar(120) not null default 'image/gif',
  bytes bytea not null,
  created_at timestamptz not null default now()
);

alter table public.tracking_pixel_assets enable row level security;

insert into public.tracking_pixel_assets (id, content_type, bytes)
values (
  'default',
  'image/gif',
  decode(
    '47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b',
    'hex'
  )
)
on conflict (id) do nothing;

-- Helper so Edge Functions can fetch the GIF as base64 without bytea encoding surprises.
create or replace function public.read_tracking_pixel_base64()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select encode(bytes, 'base64')
  from public.tracking_pixel_assets
  where id = 'default'
  limit 1;
$$;

revoke all on function public.read_tracking_pixel_base64() from public;
grant execute on function public.read_tracking_pixel_base64() to service_role;
