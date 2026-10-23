-- Disposable-only reduced prerequisites. Real notification/communication DDL and RLS
-- below are loaded byte-for-byte from immutable migrations 10 and 11.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema app_security;
grant usage on schema public, auth, app_security to anon, authenticated, service_role;
create table auth.users (id uuid primary key);
create type public.account_status_enum as enum ('active','suspended','deletion_pending','deleted');
create table public.user_accounts(user_id uuid primary key references auth.users(id), account_status public.account_status_enum not null);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function app_security.get_account_status(p_user_id uuid) returns public.account_status_enum language sql stable security definer set search_path='' as $$ select account_status from public.user_accounts where user_id=p_user_id $$;
create table public.listings(id uuid primary key, seller_id uuid references auth.users(id), title text, slug text);
create table public.listing_status_transitions(id uuid primary key, listing_id uuid references public.listings(id), from_status text, to_status text, reason text);
create publication supabase_realtime;
