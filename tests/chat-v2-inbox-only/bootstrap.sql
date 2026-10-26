-- Synthetic disposable database only: no HTTP, cron, pg_net or actual Vault.
do $$begin if not exists(select 1 from pg_roles where rolname='inbox_fixture_admin') then create role inbox_fixture_admin superuser login;end if;end$$;
set session authorization inbox_fixture_admin;
do $$begin
 if exists(select 1 from pg_roles where oid=10 and rolname='postgres') then alter role postgres rename to pglite_bootstrap;end if;
 if not exists(select 1 from pg_roles where rolname='postgres') then create role postgres bypassrls;end if;
end$$;
create role anon;create role authenticated;create role service_role bypassrls;
grant create on database postgres to postgres;
grant usage,create on schema public to postgres;
set role postgres;
create schema auth;create schema app_security;create schema vault;create schema supabase_migrations;
grant usage on schema public,auth,app_security to anon,authenticated,service_role;
create table auth.users(id uuid primary key,status text not null default 'active',policy boolean not null default true);
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user',true),'')::uuid$$;
create function app_security.get_account_status(uuid) returns text language sql stable security definer set search_path='' as $$select status from auth.users where id=$1$$;
create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql stable security definer set search_path='' as $$select policy from auth.users where id=$1$$;
create table public.profiles(id uuid primary key references auth.users,display_name text);
create table public.listings(id uuid primary key,seller_id uuid references auth.users,title text,slug text,price_paise integer,status text,cover_photo_id uuid);
create function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable security definer set search_path='' as $$select status='active' from public.listings where id=$1$$;
create function app_security.create_notification(uuid,text,text,text,text) returns void language plpgsql as $$begin end$$;
create table public.user_blocks(blocker_id uuid,blocked_id uuid);
create table vault.identity_fixture(name text,decrypted_secret text);
create view vault.decrypted_secrets as select * from vault.identity_fixture;
revoke all on vault.identity_fixture,vault.decrypted_secrets from public,anon,authenticated,service_role;
create table supabase_migrations.schema_migrations(version text primary key,statements text[],name text);
insert into supabase_migrations.schema_migrations values('20260914000011',array['fixture baseline'], 'create_communication');
insert into vault.identity_fixture values('moderation_worker_url','https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-listing-moderation');
