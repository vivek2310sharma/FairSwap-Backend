-- Support-ticket state RPC candidate only. Never apply from the immutable 58-file baseline.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Fail closed if this environment lacks the expected legacy contract. Test and
-- Production have different migration ledgers; this checks objects, not versions.
do $$
begin
  if to_regclass('public.support_tickets') is null
     or to_regtype('public.support_ticket_status_enum') is null
     or to_regtype('public.support_ticket_priority_enum') is null
     or to_regprocedure('app_security.is_active_staff_aal2(public.staff_role_enum)') is null
     or to_regprocedure('app_security.log_audit_event(text,text,uuid,jsonb)') is null
     or to_regprocedure('public.admin_update_ticket_status(uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum,uuid)') is null then
    raise exception 'support ticket state preflight failed';
  end if;
  if to_regprocedure('app_security.impl_staff_update_ticket_state(uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum)') is not null
     or to_regprocedure('public.admin_update_ticket_state(uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum)') is not null then
    raise exception 'support ticket state functions already exist';
  end if;
end
$$;

-- Never writes assigned_to: the UPDATE column list is status, priority, updated_at.
-- Postgres re-reads the latest committed row version after waiting on a row lock,
-- so a concurrent reassignment is neither overwritten nor replayed from a stale read.
-- FOR NO KEY UPDATE serialises state writers without blocking support_messages
-- inserts that take FOR KEY SHARE through the ticket foreign key.
create function app_security.impl_staff_update_ticket_state(
  p_ticket_id uuid,
  p_status public.support_ticket_status_enum,
  p_priority public.support_ticket_priority_enum
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_caller_id uuid;
  v_previous_status public.support_ticket_status_enum;
  v_previous_priority public.support_ticket_priority_enum;
begin
  v_caller_id := auth.uid();
  if v_caller_id is null then
    raise exception using errcode = '42501', message = 'Not authenticated';
  end if;

  if not app_security.is_active_staff_aal2('support_agent') then
    raise exception using errcode = '42501', message = 'Forbidden: requires active support agent with AAL2';
  end if;

  if p_ticket_id is null or p_status is null or p_priority is null then
    raise exception using errcode = '22023', message = 'Ticket id, status and priority are required';
  end if;

  select t.status, t.priority
    into v_previous_status, v_previous_priority
  from public.support_tickets t
  where t.id = p_ticket_id
  for no key update;

  if not found then
    raise exception using errcode = 'P0002', message = 'Support ticket not found';
  end if;

  update public.support_tickets
  set status = p_status,
      priority = p_priority,
      updated_at = pg_catalog.clock_timestamp()
  where id = p_ticket_id;

  perform app_security.log_audit_event(
    'support_ticket.updated',
    'support_tickets',
    p_ticket_id,
    pg_catalog.jsonb_build_object(
      'status', p_status,
      'priority', p_priority,
      'previous_status', v_previous_status,
      'previous_priority', v_previous_priority
    )
  );
end;
$$;

revoke all on function app_security.impl_staff_update_ticket_state(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum) from public, anon, authenticated, service_role;
grant execute on function app_security.impl_staff_update_ticket_state(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum) to authenticated;

create function public.admin_update_ticket_state(
  ticket_id uuid,
  status public.support_ticket_status_enum,
  priority public.support_ticket_priority_enum
) returns void
language plpgsql volatile security invoker
set search_path = ''
as $$
begin
  perform app_security.impl_staff_update_ticket_state(ticket_id, status, priority);
end;
$$;

revoke all on function public.admin_update_ticket_state(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum) from public, anon, authenticated, service_role;
grant execute on function public.admin_update_ticket_state(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum) to authenticated;

-- Post-install guard: abort the whole transaction on any privilege drift.
do $$
declare
  v_impl oid := to_regprocedure('app_security.impl_staff_update_ticket_state(uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum)');
  v_pub oid := to_regprocedure('public.admin_update_ticket_state(uuid,public.support_ticket_status_enum,public.support_ticket_priority_enum)');
  v_role text;
begin
  foreach v_role in array array['anon', 'service_role'] loop
    if pg_catalog.has_function_privilege(v_role, v_impl, 'EXECUTE')
       or pg_catalog.has_function_privilege(v_role, v_pub, 'EXECUTE') then
      raise exception 'support ticket state privilege check failed';
    end if;
  end loop;
  if not (pg_catalog.has_function_privilege('authenticated', v_impl, 'EXECUTE')
          and pg_catalog.has_function_privilege('authenticated', v_pub, 'EXECUTE')) then
    raise exception 'support ticket state privilege check failed';
  end if;
  if exists (
    select 1 from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a
    where p.oid in (v_impl, v_pub) and a.grantee = 0
  ) then
    raise exception 'support ticket state privilege check failed';
  end if;
end
$$;

commit;
