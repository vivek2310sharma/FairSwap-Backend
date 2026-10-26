-- Phase 1B: additive infrastructure only; no flags, secret provisioning or schedules activated.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_security.impl_verify_chat_safety_worker_secret(p_candidate text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_expected text; v_count integer;
begin
  if p_candidate is null or length(p_candidate) <> 64 or p_candidate !~ '^[0-9a-f]{64}$' then return false; end if;
  select count(*), min(decrypted_secret) into v_count,v_expected
    from vault.decrypted_secrets where name = 'chat_safety_worker_secret';
  return coalesce(v_count = 1 and length(v_expected) = 64 and v_expected ~ '^[0-9a-f]{64}$' and p_candidate = v_expected,false);
exception when others then return false;
end;
$$;
revoke all on function app_security.impl_verify_chat_safety_worker_secret(text) from public,anon,authenticated;
grant execute on function app_security.impl_verify_chat_safety_worker_secret(text) to service_role;
create function public.verify_chat_safety_worker_secret(candidate text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select app_security.impl_verify_chat_safety_worker_secret(candidate)
$$;
revoke all on function public.verify_chat_safety_worker_secret(text) from public,anon,authenticated;
grant execute on function public.verify_chat_safety_worker_secret(text) to service_role;

create table app_security.chat_safety_runtime (
  singleton boolean primary key default true check(singleton),
  project_ref text check(project_ref in ('wpppxlnbzqynvhpeuavd','kriuhwppxgxsyyrbjsau')),
  dispatch_enabled boolean not null default false
);
create table app_security.chat_safety_recovery_state (
  singleton boolean primary key default true check(singleton),
  cursor_at timestamptz, cursor_id uuid,
  horizon_at timestamptz, horizon_id uuid,
  scanned_total bigint not null default 0, recovered_total bigint not null default 0,
  enqueue_failures bigint not null default 0, sweeps bigint not null default 0,
  last_scan_size integer not null default 0 check(last_scan_size between 0 and 100),
  last_recovered_size integer not null default 0,
  last_scan_at timestamptz,
  check((cursor_at is null) = (cursor_id is null)),
  check((horizon_at is null) = (horizon_id is null))
);
alter table app_security.chat_safety_runtime enable row level security;
alter table app_security.chat_safety_runtime force row level security;
alter table app_security.chat_safety_recovery_state enable row level security;
alter table app_security.chat_safety_recovery_state force row level security;
revoke all on app_security.chat_safety_runtime,app_security.chat_safety_recovery_state
  from public,anon,authenticated,service_role;
insert into app_security.chat_safety_runtime(singleton) values(true);
insert into app_security.chat_safety_recovery_state(singleton) values(true);

-- Global cursor index. LIMIT is applied BEFORE the anti-join, not after it.
create index chat_safety_recovery_messages on public.messages(created_at,id);
create function app_security.chat_safety_recover() returns void
language plpgsql security definer set search_path = '' as $$
declare v_state app_security.chat_safety_recovery_state; v_scanned integer;
  v_inserted integer; v_at timestamptz; v_id uuid; v_finished boolean;
begin
  select * into strict v_state from app_security.chat_safety_recovery_state where singleton for update;
  if v_state.horizon_at is null then
    select m.created_at,m.id into v_state.horizon_at,v_state.horizon_id
      from public.messages m order by m.created_at desc,m.id desc limit 1;
  end if;
  with scan as materialized (
    select m.id,m.created_at,m.conversation_id,m.sender_id
    from public.messages m
    where (m.created_at,m.id) > (coalesce(v_state.cursor_at,'-infinity'::timestamptz),
      coalesce(v_state.cursor_id,'00000000-0000-0000-0000-000000000000'::uuid))
      and (m.created_at,m.id) <= (v_state.horizon_at,v_state.horizon_id)
    order by m.created_at,m.id limit 100
  ), recovered as (
    insert into app_security.chat_safety_jobs(message_id,recipient_id)
    select m.id,case when m.sender_id = c.buyer_id then c.seller_id else c.buyer_id end
      from scan m join public.conversations c on c.id = m.conversation_id
      where c.buyer_id is not null and c.seller_id is not null
        and (m.sender_id = c.buyer_id or m.sender_id = c.seller_id)
        and not exists(select 1 from app_security.chat_safety_jobs j where j.message_id = m.id)
    on conflict do nothing returning message_id
  )
  select (select count(*) from scan),(select count(*) from recovered),
    (select created_at from scan order by created_at desc,id desc limit 1),
    (select id from scan order by created_at desc,id desc limit 1)
  into v_scanned,v_inserted,v_at,v_id;
  v_finished := v_scanned < 100 or (v_at,v_id) >= (v_state.horizon_at,v_state.horizon_id);
  update app_security.chat_safety_recovery_state set
    cursor_at = case when not v_finished then v_at end,
    cursor_id = case when not v_finished then v_id end,
    horizon_at = case when not v_finished then v_state.horizon_at end,
    horizon_id = case when not v_finished then v_state.horizon_id end,
    scanned_total = scanned_total + v_scanned, recovered_total = recovered_total + v_inserted,
    sweeps = sweeps + case when v_finished then 1 else 0 end,
    last_scan_size = v_scanned, last_recovered_size = v_inserted, last_scan_at = clock_timestamp()
  where singleton;
end;
$$;
revoke all on function app_security.chat_safety_recover() from public,anon,authenticated,service_role;

create or replace function app_security.impl_chat_safety_claim(p_batch_size integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if p_batch_size is null or p_batch_size not between 1 and 20 then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_BATCH';
  end if;
  if not app_security.chat_v2_enabled('safety_warnings') then return '[]'::jsonb; end if;
  perform app_security.chat_safety_recover();
  with candidates as (
    select j.message_id from app_security.chat_safety_jobs j
    where j.completed_at is null and j.attempts < 5 and j.next_attempt_at <= clock_timestamp()
    order by j.next_attempt_at,j.message_id limit p_batch_size for update skip locked
  ), claimed as (
    update app_security.chat_safety_jobs j set attempts = j.attempts + 1,
      lease_token = gen_random_uuid(),
      next_attempt_at = clock_timestamp() + make_interval(secs => (120 * power(2,j.attempts))::integer)
    from candidates c where j.message_id = c.message_id returning j.message_id,j.lease_token
  )
  select coalesce(jsonb_agg(jsonb_build_object('message_id',c.message_id,'lease_token',c.lease_token,
    'content',m.content)), '[]'::jsonb) into v_result
    from claimed c join public.messages m on m.id = c.message_id;
  return v_result;
end;
$$;
revoke all on function app_security.impl_chat_safety_claim(integer) from public,anon,authenticated;
grant execute on function app_security.impl_chat_safety_claim(integer) to service_role;

create or replace function app_security.chat_safety_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if app_security.chat_v2_enabled('safety_warnings') then
    insert into app_security.chat_safety_jobs(message_id,recipient_id)
      select new.id,case when new.sender_id = c.buyer_id then c.seller_id else c.buyer_id end
      from public.conversations c where c.id = new.conversation_id
        and (new.sender_id = c.buyer_id or new.sender_id = c.seller_id)
        and c.buyer_id is not null and c.seller_id is not null on conflict do nothing;
  end if;
  return new;
exception when others then
  -- Cautions must never block legacy text delivery; record only a counter, then repair by cursor.
  begin
    update app_security.chat_safety_recovery_state set enqueue_failures = enqueue_failures + 1 where singleton;
  exception when others then null;
  end;
  return new;
end;
$$;
revoke all on function app_security.chat_safety_enqueue() from public,anon,authenticated;

create function app_security.impl_chat_safety_metrics() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'pending',count(*) filter(where completed_at is null),
    'due',count(*) filter(where completed_at is null and attempts < 5 and next_attempt_at <= statement_timestamp()),
    'leased',count(*) filter(where completed_at is null and attempts > 0 and next_attempt_at > statement_timestamp()),
    'exhausted',count(*) filter(where completed_at is null and attempts = 5 and next_attempt_at <= statement_timestamp()),
    'completed',count(*) filter(where completed_at is not null),
    'recovery',(select jsonb_build_object('scanned_total',scanned_total,'recovered_total',recovered_total,
      'enqueue_failures',enqueue_failures,'sweeps',sweeps,'last_scan_size',last_scan_size,
      'last_recovered_size',last_recovered_size,'last_scan_at',last_scan_at)
      from app_security.chat_safety_recovery_state where singleton)
  ) from app_security.chat_safety_jobs
$$;
revoke all on function app_security.impl_chat_safety_metrics() from public,anon,authenticated;
grant execute on function app_security.impl_chat_safety_metrics() to service_role;
create function public.chat_safety_metrics() returns jsonb
language sql stable security invoker set search_path = '' as $$select app_security.impl_chat_safety_metrics()$$;
revoke all on function public.chat_safety_metrics() from public,anon,authenticated;
grant execute on function public.chat_safety_metrics() to service_role;

-- Owner/cron only, with no user-supplied destination or token. Inactive until separately authorized.
create function app_security.dispatch_chat_safety() returns void
language plpgsql security definer set search_path = '' as $$
declare v_ref text; v_token text; v_count integer;
begin
  select project_ref into v_ref from app_security.chat_safety_runtime where singleton and dispatch_enabled;
  if v_ref is null or not app_security.chat_v2_enabled('safety_warnings') then return; end if;
  select count(*),min(decrypted_secret) into v_count,v_token
    from vault.decrypted_secrets where name = 'chat_safety_worker_secret';
  if v_count <> 1 or v_token is null or length(v_token) <> 64 or v_token !~ '^[0-9a-f]{64}$' then return; end if;
  perform net.http_post(
    url := 'https://' || v_ref || '.supabase.co/functions/v1/process-chat-safety',
    headers := jsonb_build_object('Content-Type','application/json','x-chat-safety-worker-secret',v_token),
    body := '{}'::jsonb, timeout_milliseconds := 10000);
exception when others then
  -- No request body, credential or upstream SQL error logging.
  return;
end;
$$;
revoke all on function app_security.dispatch_chat_safety() from public,anon,authenticated,service_role;

-- pg_net briefly holds the custom credential in its request queue; never client-readable.
revoke all on net.http_request_queue from public,anon,authenticated,service_role;

-- Owner-only, environment-bound, repeatable provisioning. Called only by release artifacts.
create function app_security.configure_chat_safety_inactive(p_project_ref text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_url text; v_count integer; v_token text; v_job bigint; v_name text; v_previous text;
begin
  if p_project_ref is null or p_project_ref not in ('wpppxlnbzqynvhpeuavd','kriuhwppxgxsyyrbjsau') then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_ENVIRONMENT';
  end if;
  perform pg_advisory_xact_lock(784271319);
  select project_ref into v_previous from app_security.chat_safety_runtime where singleton for update;
  if v_previous is not null and v_previous <> p_project_ref then
    raise exception using errcode = '22023', message = 'CHAT_ENVIRONMENT_MISMATCH';
  end if;
  select count(*),min(decrypted_secret) into v_count,v_url from vault.decrypted_secrets where name = 'project_url';
  if v_count <> 1 or v_url is distinct from ('https://' || p_project_ref || '.supabase.co') then
    raise exception using errcode = '22023', message = 'CHAT_ENVIRONMENT_MISMATCH';
  end if;
  if (select count(*) from app_security.chat_v2_flags where not enabled) <> 5 then
    raise exception using errcode = '55000', message = 'CHAT_FLAGS_MUST_REMAIN_OFF';
  end if;
  select count(*),min(decrypted_secret) into v_count,v_token from vault.decrypted_secrets where name = 'chat_safety_worker_secret';
  if v_count = 0 then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'chat_safety_worker_secret');
  elsif v_count <> 1 or v_token is null or length(v_token) <> 64 or v_token !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '55000', message = 'CHAT_VAULT_CONFIGURATION_INVALID';
  end if;
  update app_security.chat_safety_runtime set project_ref = p_project_ref,dispatch_enabled = false where singleton;
  v_name := case when p_project_ref = 'wpppxlnbzqynvhpeuavd' then 'chat-safety-fairswaptest' else 'chat-safety-fairswapprod' end;
  v_job := cron.schedule(v_name,'* * * * *','select app_security.dispatch_chat_safety();');
  -- Same transaction: no worker can observe an active schedule on commit.
  perform cron.alter_job(v_job,active := false);
end;
$$;
revoke all on function app_security.configure_chat_safety_inactive(text) from public,anon,authenticated,service_role;
commit;
