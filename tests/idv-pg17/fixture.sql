-- FairSwap IDV-V1 PG17 Disposable Test Fixture
-- Sets up core Supabase roles, schemas, auth and account helpers.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema if not exists auth;
create schema if not exists app_security;
create schema if not exists vault;
create schema if not exists cron;
create schema if not exists net;

grant usage on schema public, auth, app_security to anon, authenticated, service_role;
grant usage on schema vault to service_role;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  created_at timestamptz default clock_timestamp()
);

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'sub', current_setting('request.jwt.claim.sub', true),
    'role', current_setting('request.jwt.claim.role', true),
    'aal', coalesce(nullif(current_setting('request.jwt.claim.aal', true), ''), 'aal1'),
    'staff_role', current_setting('request.jwt.claim.staff_role', true)
  );
$$;

create type public.account_status_enum as enum ('active', 'suspended', 'deletion_pending', 'deleted');

create table if not exists public.user_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  account_status public.account_status_enum not null default 'active',
  created_at timestamptz default clock_timestamp()
);

create or replace function app_security.get_account_status(p_user_id uuid)
returns public.account_status_enum
language sql stable security definer set search_path = '' as $$
  select account_status from public.user_accounts where user_id = p_user_id;
$$;

create type public.staff_role_enum as enum (
  'administrator',
  'moderator',
  'support_agent',
  'content_editor'
);

create table if not exists public.staff_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role public.staff_role_enum not null,
  assigned_at timestamptz not null default clock_timestamp(),
  assigned_by uuid references auth.users(id)
);

create or replace function app_security.is_active_staff_aal2(p_required_role public.staff_role_enum)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_user_role public.staff_role_enum;
  v_status public.account_status_enum;
  v_aal text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return false;
  end if;

  select account_status into v_status
  from public.user_accounts
  where user_id = v_user_id;

  if v_status is distinct from 'active' then
    return false;
  end if;

  v_aal := (auth.jwt() ->> 'aal');
  if v_aal is distinct from 'aal2' then
    return false;
  end if;

  select role into v_user_role
  from public.staff_roles
  where user_id = v_user_id;

  if v_user_role is null then
    return false;
  end if;

  if v_user_role = 'administrator' then
    return true;
  end if;

  return v_user_role = p_required_role;
end;
$$;

revoke all on function app_security.is_active_staff_aal2(public.staff_role_enum) from public, authenticated, anon;
grant execute on function app_security.is_active_staff_aal2(public.staff_role_enum) to authenticated, service_role;

create table if not exists vault.decrypted_secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  decrypted_secret text not null
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000
)
returns bigint language sql as $$ select 1::bigint; $$;

create table if not exists cron.job (
  jobid bigserial primary key,
  jobname text unique,
  schedule text,
  command text,
  active boolean default true
);

create or replace function cron.schedule(text, text, text)
returns bigint language plpgsql as $$
declare j bigint;
begin
  insert into cron.job(jobname, schedule, command)
  values($1, $2, $3)
  on conflict(jobname) do update set schedule = excluded.schedule, command = excluded.command
  returning jobid into j;
  return j;
end;
$$;

create or replace function cron.unschedule(p_jobname text)
returns void language sql as $$
  delete from cron.job where jobname = p_jobname;
$$;
