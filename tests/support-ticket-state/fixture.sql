-- Disposable-only reduced Supabase prerequisites. The real accounts, staff, audit and
-- support DDL/RLS/functions are loaded byte-for-byte from immutable migrations 01, 02, 03 and 13.
-- Default privileges mimic Supabase's public-schema grants so the explicit REVOKEs are exercised.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create extension if not exists pgcrypto;
create schema auth;
grant usage on schema public, auth to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
create table auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}',
  created_at timestamptz not null default clock_timestamp()
);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
