-- CHEKI STUDIO persistent storage schema
-- Run this entire file in Supabase Dashboard > SQL Editor.

create table if not exists public.cheki_studios (
  id text primary key check (id ~ '^[a-f0-9]{32}$'),
  admin_key text not null,
  view_key text not null,
  settings jsonb not null default '{"username":"","giftMode":"all","giftQuery":""}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.cheki_items (
  studio_id text not null references public.cheki_studios(id) on delete cascade,
  id text not null,
  name text not null default 'チェキ',
  image_path text not null,
  created_at bigint not null default (extract(epoch from now()) * 1000)::bigint,
  primary key (studio_id, id)
);

alter table public.cheki_studios enable row level security;
alter table public.cheki_items enable row level security;

-- The Node server uses the service_role key. Do not create public insert/update policies.
-- Public bucket is required so OBS browser sources can display the image URLs returned by the server.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cheki-images', 'cheki-images', true, 10485760, array['image/png']::text[])
on conflict (id) do update set public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
