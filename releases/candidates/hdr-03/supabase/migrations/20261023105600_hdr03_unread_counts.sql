-- HDR-03 candidate only. Never apply from the immutable 58-file baseline.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Invoker execution is intentional: all source-table RLS and SELECT privileges
-- remain effective. No identity parameter, elevated aggregate or private helper.
create function public.get_unread_counts()
returns table (unread_messages bigint, unread_notifications bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or coalesce(app_security.get_account_status(v_uid)::text, '') not in ('active', 'suspended') then
    raise exception using errcode = '42501', message = 'Authentication or account access required';
  end if;

  -- Count messages, not conversations; never count the caller's own messages.
  -- last_read_at is when a read was recorded, NOT the message ordering cursor.
  select count(*) into unread_messages
  from public.conversations c
  join public.messages m on m.conversation_id = c.id
  left join public.conversation_read_states r on r.conversation_id = c.id and r.user_id = v_uid
  left join public.messages marker on marker.conversation_id = r.conversation_id and marker.id = r.last_read_message_id
  where (c.buyer_id = v_uid or c.seller_id = v_uid)
    and m.sender_id is distinct from v_uid
    and (marker.id is null or (m.created_at, m.id) > (marker.created_at, marker.id));

  select count(*) into unread_notifications
  from public.notifications n where n.user_id = v_uid and n.read_at is null;

  -- count(*) is non-negative bigint; reject values JS cannot represent exactly.
  if unread_messages > 9007199254740991 or unread_notifications > 9007199254740991 then
    raise exception using errcode = '22003', message = 'Unread count out of range';
  end if;
  return next;
end;
$$;
revoke all on function public.get_unread_counts() from public, anon, authenticated;
grant execute on function public.get_unread_counts() to authenticated;

-- Minimal invalidation signal: never publish message bodies or read-marker IDs.
create table public.unread_count_signals (
  -- DELETE tombstones must never expose the owner ID as a replica key.
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  revision bigint not null default 1 check (revision > 0)
);
alter table public.unread_count_signals enable row level security;
alter table public.unread_count_signals force row level security;
revoke all on public.unread_count_signals from public, anon, authenticated;
grant select on public.unread_count_signals to authenticated;
create policy unread_count_signals_owner_select on public.unread_count_signals
for select to authenticated using (
  user_id = (select auth.uid())
  and app_security.get_account_status((select auth.uid())) in ('active', 'suspended')
);

-- Only trigger owners can execute these helpers. Client DML stays revoked.
create function app_security.hdr03_signal_message()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.unread_count_signals as s (user_id)
  select participant from public.conversations c
  cross join lateral (values (c.buyer_id), (c.seller_id)) p(participant)
  where c.id = new.conversation_id and participant is not null
    and participant is distinct from new.sender_id
  order by participant
  on conflict (user_id) do update set revision = s.revision + 1;
  return new;
end;
$$;
revoke all on function app_security.hdr03_signal_message() from public, anon, authenticated;

create function app_security.hdr03_signal_read_state()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.unread_count_signals as s (user_id) values (new.user_id)
  on conflict (user_id) do update set revision = s.revision + 1;
  return new;
end;
$$;
revoke all on function app_security.hdr03_signal_read_state() from public, anon, authenticated;

create trigger hdr03_message_arrival after insert on public.messages
for each row execute function app_security.hdr03_signal_message();
create trigger hdr03_read_state_insert after insert on public.conversation_read_states
for each row execute function app_security.hdr03_signal_read_state();
create trigger hdr03_read_state_update after update of last_read_message_id on public.conversation_read_states
for each row when (old.last_read_message_id is distinct from new.last_read_message_id)
execute function app_security.hdr03_signal_read_state();

-- Existing Supabase publication must exist; missing prerequisites fail atomically.
alter publication supabase_realtime add table public.unread_count_signals;
notify pgrst, 'reload schema';
comment on function public.get_unread_counts() is
  'HDR-03: caller-only unread inbound message count after (created_at,id) read cursor, plus unread notification count; existing RLS applies.';
commit;
