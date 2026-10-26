-- External scheduler cutover. No HTTP queue credential, net ACL edit or feature activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$begin if current_user<>'postgres' then raise exception using errcode='42501',message='CHAT_APPLICATION_OWNER_REQUIRED'; end if; end$$;
do $$begin if (select count(*) from app_security.chat_v2_flags where not enabled)<>5 then
 raise exception using errcode='55000',message='CHAT_FLAGS_MUST_REMAIN_OFF';end if;end$$;

alter table app_security.chat_safety_runtime add column external_scheduler_enabled boolean not null default false;
create table app_security.chat_safety_scheduler_runs(
  invocation_id text primary key check(invocation_id ~ '^gha:[1-9][0-9]{0,19}:(test|prod)$'),
  status text not null check(status in ('processing','completed','failed')),
  attempts integer not null check(attempts between 1 and 3),
  lease_token uuid not null,lease_until timestamptz not null,
  started_at timestamptz not null default clock_timestamp(),finished_at timestamptz,
  claimed integer not null default 0 check(claimed between 0 and 20),
  completed integer not null default 0 check(completed between 0 and 20),
  failed integer not null default 0 check(failed between 0 and 20),
  check(completed+failed=claimed)
);
create unique index chat_safety_one_external_run on app_security.chat_safety_scheduler_runs((true)) where status='processing';
create index chat_safety_scheduler_retention on app_security.chat_safety_scheduler_runs(finished_at) where finished_at is not null;
alter table app_security.chat_safety_scheduler_runs enable row level security;
alter table app_security.chat_safety_scheduler_runs force row level security;
revoke all on app_security.chat_safety_scheduler_runs from public,anon,authenticated,service_role;

-- Only a non-replayable-to-HTTP SHA-256 proof crosses the service RPC boundary.
-- The raw dispatch credential is never a SQL parameter or returned result.
create function app_security.impl_verify_chat_safety_worker_digest(p_candidate_sha256 text)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_count integer;v_digest text;
begin
  if p_candidate_sha256 is null or length(p_candidate_sha256)<>64 or p_candidate_sha256 !~ '^[0-9a-f]{64}$' then return false;end if;
  select count(*),min(case when length(decrypted_secret)=64 and decrypted_secret ~ '^[0-9a-f]{64}$'
    then encode(sha256(convert_to(decrypted_secret,'UTF8')),'hex') end)
    into v_count,v_digest from vault.decrypted_secrets where name='chat_safety_worker_secret';
  return coalesce(v_count=1 and v_digest=p_candidate_sha256,false);
exception when others then return false;
end;
$$;
revoke all on function app_security.impl_verify_chat_safety_worker_digest(text) from public,anon,authenticated;
grant execute on function app_security.impl_verify_chat_safety_worker_digest(text) to service_role;
create function public.verify_chat_safety_worker_digest(candidate_sha256 text) returns boolean
language sql stable security invoker set search_path='' as $$select app_security.impl_verify_chat_safety_worker_digest(candidate_sha256)$$;
revoke all on function public.verify_chat_safety_worker_digest(text) from public,anon,authenticated;
grant execute on function public.verify_chat_safety_worker_digest(text) to service_role;
-- Old Edge versions fail closed until replaced; no raw token verifier is callable by service clients.
revoke all on function public.verify_chat_safety_worker_secret(text) from service_role;
revoke all on function app_security.impl_verify_chat_safety_worker_secret(text) from service_role;

create function app_security.impl_chat_safety_schedule_begin(p_invocation_id text,p_target text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_ref text;v_run app_security.chat_safety_scheduler_runs;v_token uuid;v_enabled boolean;
begin
  if p_target is null or p_target not in ('test','prod') or p_invocation_id is null
    or p_invocation_id !~ ('^gha:[1-9][0-9]{0,19}:'||p_target||'$') then
    raise exception using errcode='22023',message='INVALID_CHAT_SCHEDULE';
  end if;
  select project_ref,external_scheduler_enabled into v_ref,v_enabled from app_security.chat_safety_runtime where singleton for update;
  if v_ref is distinct from (case when p_target='test' then 'wpppxlnbzqynvhpeuavd' else 'kriuhwppxgxsyyrbjsau' end) then
    raise exception using errcode='42501',message='CHAT_SCHEDULE_TARGET_MISMATCH';
  end if;
  if not v_enabled or not app_security.chat_v2_enabled('safety_warnings') then return jsonb_build_object('state','disabled');end if;
  -- Finite retention exceeds GitHub's normal rerun window; messages/findings retain their own idempotency.
  delete from app_security.chat_safety_scheduler_runs where invocation_id in (
    select invocation_id from app_security.chat_safety_scheduler_runs where finished_at<clock_timestamp()-interval '90 days'
    order by finished_at limit 100);
  update app_security.chat_safety_scheduler_runs set status='failed',finished_at=clock_timestamp()
    where status='processing' and lease_until<=clock_timestamp();
  select * into v_run from app_security.chat_safety_scheduler_runs where invocation_id=p_invocation_id;
  if found and v_run.status='completed' then return jsonb_build_object('state','completed',
    'claimed',v_run.claimed,'completed',v_run.completed,'failed',v_run.failed);end if;
  if found and v_run.finished_at is not null and v_run.lease_until>clock_timestamp() and v_run.status='failed' then
    return jsonb_build_object('state','failed');
  end if;
  if found and v_run.attempts>=3 then return jsonb_build_object('state','exhausted');end if;
  if exists(select 1 from app_security.chat_safety_scheduler_runs where status='processing') then return jsonb_build_object('state','busy');end if;
  v_token:=gen_random_uuid();
  insert into app_security.chat_safety_scheduler_runs(invocation_id,status,attempts,lease_token,lease_until)
    values(p_invocation_id,'processing',1,v_token,clock_timestamp()+interval '120 seconds')
    on conflict(invocation_id) do update set status='processing',attempts=app_security.chat_safety_scheduler_runs.attempts+1,
      lease_token=excluded.lease_token,lease_until=excluded.lease_until,finished_at=null,claimed=0,completed=0,failed=0;
  return jsonb_build_object('state','claimed','lease_token',v_token);
end;
$$;
revoke all on function app_security.impl_chat_safety_schedule_begin(text,text) from public,anon,authenticated;
grant execute on function app_security.impl_chat_safety_schedule_begin(text,text) to service_role;
create function public.chat_safety_schedule_begin(invocation_id text,target text) returns jsonb
language sql security invoker set search_path='' as $$select app_security.impl_chat_safety_schedule_begin(invocation_id,target)$$;
revoke all on function public.chat_safety_schedule_begin(text,text) from public,anon,authenticated;
grant execute on function public.chat_safety_schedule_begin(text,text) to service_role;

create function app_security.impl_chat_safety_schedule_finish(p_invocation_id text,p_lease_token uuid,p_claimed integer,p_completed integer,p_failed integer)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_updated integer;
begin
  if p_claimed is null or p_completed is null or p_failed is null or p_claimed not between 0 and 20
    or p_completed not between 0 and 20 or p_failed not between 0 and 20 or p_completed+p_failed<>p_claimed then
    raise exception using errcode='22023',message='INVALID_CHAT_SCHEDULE_RESULT';
  end if;
  perform 1 from app_security.chat_safety_runtime where singleton for update;
  update app_security.chat_safety_scheduler_runs set status=case when p_failed=0 then 'completed' else 'failed' end,
    claimed=p_claimed,completed=p_completed,failed=p_failed,finished_at=clock_timestamp()
    where invocation_id=p_invocation_id and lease_token=p_lease_token and status='processing' and lease_until>clock_timestamp();
  get diagnostics v_updated=row_count;
  return v_updated=1 or exists(select 1 from app_security.chat_safety_scheduler_runs where invocation_id=p_invocation_id
    and lease_token=p_lease_token and status in ('completed','failed') and claimed=p_claimed and completed=p_completed and failed=p_failed);
end;
$$;
revoke all on function app_security.impl_chat_safety_schedule_finish(text,uuid,integer,integer,integer) from public,anon,authenticated;
grant execute on function app_security.impl_chat_safety_schedule_finish(text,uuid,integer,integer,integer) to service_role;
create function public.chat_safety_schedule_finish(invocation_id text,lease_token uuid,claimed integer,completed integer,failed integer)
returns boolean language sql security invoker set search_path='' as $$
  select app_security.impl_chat_safety_schedule_finish(invocation_id,lease_token,claimed,completed,failed)
$$;
revoke all on function public.chat_safety_schedule_finish(text,uuid,integer,integer,integer) from public,anon,authenticated;
grant execute on function public.chat_safety_schedule_finish(text,uuid,integer,integer,integer) to service_role;

create function app_security.impl_chat_safety_scheduler_metrics() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('completed',count(*) filter(where status='completed'),
   'failed',count(*) filter(where status='failed'),'processing',count(*) filter(where status='processing'),
   'last_started_at',max(started_at),'last_finished_at',max(finished_at)) from app_security.chat_safety_scheduler_runs
$$;
revoke all on function app_security.impl_chat_safety_scheduler_metrics() from public,anon,authenticated;
grant execute on function app_security.impl_chat_safety_scheduler_metrics() to service_role;
create function public.chat_safety_scheduler_metrics() returns jsonb language sql stable security invoker set search_path='' as $$
 select app_security.impl_chat_safety_scheduler_metrics()
$$;
revoke all on function public.chat_safety_scheduler_metrics() from public,anon,authenticated;
grant execute on function public.chat_safety_scheduler_metrics() to service_role;

-- Only Chat Safety's two obsolete jobs are disabled. Email/moderation objects/grants unchanged.
do $$declare j record;begin
 if to_regclass('cron.job') is not null then
  for j in select jobid from cron.job where jobname in ('chat-safety-fairswaptest','chat-safety-fairswapprod') loop
   perform cron.alter_job(j.jobid,active:=false);
  end loop;
 end if;
end$$;
update app_security.chat_safety_runtime set dispatch_enabled=false,external_scheduler_enabled=false;
create or replace function app_security.dispatch_chat_safety() returns void
language plpgsql security definer set search_path='' as $$begin
 raise warning 'CHAT_SAFETY_DATABASE_DISPATCH_RETIRED';return;
end$$;
revoke all on function app_security.dispatch_chat_safety() from public,anon,authenticated,service_role;

create function app_security.chat_safety_external_preflight(p_project_ref text) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform app_security.assert_chat_safety_environment(p_project_ref,false);
 if (select count(*) from app_security.chat_v2_flags where not enabled)<>5
   or exists(select 1 from app_security.chat_safety_runtime where dispatch_enabled or external_scheduler_enabled
     or (project_ref is not null and project_ref<>p_project_ref)) then
  raise exception using errcode='55000',message='CHAT_RELEASE_MUST_REMAIN_INACTIVE';end if;
 if to_regclass('cron.job') is not null then
  if exists(select 1 from cron.job where jobname in ('chat-safety-fairswaptest','chat-safety-fairswapprod') and active) then
   raise exception using errcode='55000',message='CHAT_DATABASE_SCHEDULE_MUST_REMAIN_OFF';end if;
 end if;
end;
$$;
revoke all on function app_security.chat_safety_external_preflight(text) from public,anon,authenticated,service_role;

create function app_security.configure_chat_safety_external_inactive(p_project_ref text) returns void
language plpgsql security definer set search_path='' as $$
declare v_count integer;v_token text;v_old text;
begin
 perform pg_advisory_xact_lock(784271319);
 perform app_security.chat_safety_external_preflight(p_project_ref);
 select project_ref into v_old from app_security.chat_safety_runtime where singleton for update;
 if v_old is not null and v_old<>p_project_ref then raise exception using errcode='22023',message='CHAT_ENVIRONMENT_MISMATCH';end if;
 if (select count(*) from app_security.chat_v2_flags where not enabled)<>5 then
   raise exception using errcode='55000',message='CHAT_FLAGS_MUST_REMAIN_OFF';end if;
 select count(*),min(decrypted_secret) into v_count,v_token from vault.decrypted_secrets where name='chat_safety_worker_secret';
 if v_count=0 then perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'chat_safety_worker_secret');
 elsif v_count<>1 or v_token is null or length(v_token)<>64 or v_token !~ '^[0-9a-f]{64}$' then
   raise exception using errcode='55000',message='CHAT_VAULT_CONFIGURATION_INVALID';end if;
 update app_security.chat_safety_runtime set project_ref=p_project_ref,dispatch_enabled=false,external_scheduler_enabled=false where singleton;
end;
$$;
revoke all on function app_security.configure_chat_safety_external_inactive(text) from public,anon,authenticated,service_role;
-- Stale release scripts cannot accidentally recreate a DB HTTP schedule.
create or replace function app_security.configure_chat_safety_inactive(p_project_ref text) returns void
language sql security definer set search_path='' as $$select app_security.configure_chat_safety_external_inactive(p_project_ref)$$;
revoke all on function app_security.configure_chat_safety_inactive(text) from public,anon,authenticated,service_role;
create or replace function app_security.chat_safety_release_preflight(p_project_ref text,p_require_url boolean default true) returns void
language plpgsql security definer set search_path='' as $$begin
 if p_require_url is null then raise exception using errcode='22023',message='INVALID_CHAT_ENVIRONMENT';end if;
 perform app_security.chat_safety_external_preflight(p_project_ref);
end$$;
revoke all on function app_security.chat_safety_release_preflight(text,boolean) from public,anon,authenticated,service_role;
create or replace function app_security.provision_chat_safety_project_url(p_project_ref text) returns void
language plpgsql security definer set search_path='' as $$begin
 raise exception using errcode='0A000',message='CHAT_PROJECT_URL_PROVISIONING_RETIRED';
end$$;
revoke all on function app_security.provision_chat_safety_project_url(text) from public,anon,authenticated,service_role;
commit;
