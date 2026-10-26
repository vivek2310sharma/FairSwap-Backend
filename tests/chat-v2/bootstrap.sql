-- Disposable fixtures only. No real extension, HTTP, Vault encryption or hosted credentials.
do $$begin
 if not exists(select 1 from pg_roles where rolname='chat_fixture_admin') then create role chat_fixture_admin superuser login; end if;
end$$;
set session authorization chat_fixture_admin;
-- PGlite's initial role (OID 10) cannot be demoted. Rename it ONLY in this
-- disposable DB, then create the real non-superuser postgres fixture role.
do $$begin
 if exists(select 1 from pg_roles where oid=10 and rolname='postgres') then
   alter role postgres rename to pglite_bootstrap;
 end if;
 if not exists(select 1 from pg_roles where rolname='postgres') then create role postgres bypassrls; end if;
end$$;
create role anon; create role authenticated; create role service_role bypassrls;
create role supabase_admin nologin;
create role supabase_functions_admin nologin;
grant create on database postgres to postgres;
grant usage,create on schema public to postgres;
set role postgres;
    create schema auth; create schema app_security;
    grant usage on schema public,auth,app_security to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,status text not null default 'active');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user',true),'')::uuid$$;
    create function app_security.get_account_status(uuid) returns text language sql stable security definer as $$select status from auth.users where id=$1$$;
    create table public.profiles(id uuid primary key references auth.users,display_name text);
    create table public.listings(id uuid primary key,seller_id uuid references auth.users,title text,slug text,price_paise integer,status text,cover_photo_id uuid);
    create function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable security definer as $$select status='active' from public.listings where id=$1$$;
    create function app_security.create_notification(uuid,text,text,text,text) returns void language plpgsql as $$begin end$$;
    -- Extension surfaces below are explicit fixtures, not Vault encryption/pg_net execution.
    create schema vault; create schema net; create schema cron; create schema extensions;
    create table vault.secrets_fixture(id uuid default gen_random_uuid(),name text,decrypted_secret text);
    create view vault.decrypted_secrets as select * from vault.secrets_fixture;
    create function vault.create_secret(secret text,name text) returns uuid language plpgsql as $$declare v_id uuid;begin insert into vault.secrets_fixture(name,decrypted_secret) values(name,secret) returning id into v_id;return v_id;end$$;
    create function extensions.gen_random_bytes(integer) returns bytea language sql as $$select decode(repeat(md5(random()::text),2),'hex')$$;
    create table cron.job(jobid bigserial primary key,jobname text unique,schedule text,command text,active boolean default true);
    create function cron.schedule(job_name text,job_schedule text,job_command text) returns bigint language plpgsql as $$declare v_id bigint;begin insert into cron.job(jobname,schedule,command) values(job_name,job_schedule,job_command) on conflict(jobname) do update set schedule=excluded.schedule,command=excluded.command returning jobid into v_id;return v_id;end$$;
    create function cron.alter_job(job_id bigint,active boolean) returns void language sql as $$update cron.job set active=$2 where jobid=$1$$;
    create table net.http_request_queue(id bigserial,url text,headers jsonb,body jsonb,timeout_milliseconds integer);

    create function net.http_post(url text,body jsonb default '{}'::jsonb,params jsonb default '{}'::jsonb,headers jsonb default '{}'::jsonb,timeout_milliseconds integer default 5000) returns bigint language plpgsql as $$declare v_id bigint;begin insert into net.http_request_queue(url,headers,body,timeout_milliseconds) values($1,$4,$2,$5) returning id into v_id;return v_id;end$$;
reset role;
set session authorization chat_fixture_admin;
alter schema net owner to supabase_admin;
alter table net.http_request_queue owner to supabase_admin;
alter sequence net.http_request_queue_id_seq owner to supabase_admin;
alter function net.http_post(text,jsonb,jsonb,jsonb,integer) owner to supabase_admin;
set role supabase_admin;
grant usage on schema net to public;
grant all on net.http_request_queue to public;
grant all on net.http_request_queue_id_seq to public;
reset role;
set role postgres;
