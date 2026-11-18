-- Minimal stand-ins for tables/functions the DigiLocker-direct migration touches (disposable PG17 only).
create table if not exists public.app_system_settings (
  setting_key text primary key, setting_value text not null, description text
);
create type public.listing_status_enum as enum ('draft','pending_review','active','reserved','sold','rejected','paused','expired','removed');
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid references auth.users(id) on delete cascade, -- nullable, as in hosted Test/Prod
  status public.listing_status_enum not null default 'draft',
  title text
);
create table public.listing_media (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade
);
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references public.listings(id) on delete cascade,
  buyer_id uuid references auth.users(id) on delete set null,
  seller_id uuid references auth.users(id) on delete set null
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid references auth.users(id) on delete set null,
  content text not null default 'hi'
);
-- Dependencies of the REAL app_security.impl_update_user_account_status (loaded by run-disposable.mjs).
alter table public.user_accounts add column if not exists updated_at timestamptz default clock_timestamp();
create table if not exists public.test_audit_log (action text, entity text, entity_id uuid, details jsonb, at timestamptz default clock_timestamp());
create or replace function app_security.log_audit_event(p_action text, p_entity text, p_entity_id uuid, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.test_audit_log (action, entity, entity_id, details) values (p_action, p_entity, p_entity_id, p_details);
$$;
