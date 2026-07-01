-- Run once in the Supabase SQL editor for project yhaloppwmvdyzssknkpc.
create extension if not exists pgcrypto;

create table if not exists public.field_feedback (
  id uuid primary key default gen_random_uuid(),
  event_date date not null,
  event_name text not null,
  state text not null,
  school text not null,
  context text not null default '',
  transcript text not null,
  english_translation text not null,
  language_code text,
  sarvam_transcription_id text,
  sarvam_translation_id text,
  audio_path text not null unique,
  audio_mime_type text not null,
  audio_size_bytes bigint not null,
  created_at timestamptz not null default now()
);

alter table public.field_feedback enable row level security;

-- The application performs all operations from its server with the secret key.
-- No public or anonymous table policy is intentionally created.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'field-audio',
  'field-audio',
  false,
  15728640,
  array['audio/webm','video/webm','audio/wav','audio/x-wav','audio/mpeg','audio/mp4','audio/ogg']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create index if not exists field_feedback_created_at_idx on public.field_feedback (created_at desc);
create index if not exists field_feedback_event_date_idx on public.field_feedback (event_date desc);
