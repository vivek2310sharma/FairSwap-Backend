-- Chat V2 phase 1. LOCAL CANDIDATE ONLY; reconcile each hosted ledger before release.
-- No rich kinds, Storage policies, scanner, sale transition, or activation in this slice.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_security.chat_v2_flags (
  name text primary key check (name in ('inbox', 'safety_warnings', 'rich_media', 'meetup_pin', 'seller_sale_flow')),
  enabled boolean not null default false
);
alter table app_security.chat_v2_flags enable row level security;
alter table app_security.chat_v2_flags force row level security;
revoke all on app_security.chat_v2_flags from public, anon, authenticated;
grant select, update on app_security.chat_v2_flags to service_role;
insert into app_security.chat_v2_flags(name) values
  ('inbox'), ('safety_warnings'), ('rich_media'), ('meetup_pin'), ('seller_sale_flow');

create function app_security.chat_v2_enabled(p_name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select enabled from app_security.chat_v2_flags where name = p_name), false)
$$;
revoke all on function app_security.chat_v2_enabled(text) from public, anon, authenticated;

create index chat_v2_conversations_listing_activity
  on public.conversations(listing_id, last_message_at desc, id desc);
create index chat_v2_conversations_buyer_activity
  on public.conversations(buyer_id, last_message_at desc, id desc);
create index chat_v2_conversations_seller_activity
  on public.conversations(seller_id, last_message_at desc, id desc);

-- Group BEFORE applying the cursor/limit: an ad with >50 enquiries stays one row.
-- A cursor is the last emitted row's (last_message_at,id), both descending.
create function app_security.impl_chat_v2_inbox(
  p_tab text, p_page_size integer, p_cursor_at timestamptz, p_cursor_id uuid,
  p_listing_id uuid, p_query_text text, p_unread_only boolean
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null or coalesce(app_security.get_account_status(v_actor)::text, '') not in ('active','suspended') then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_DENIED';
  end if;
  if not app_security.chat_v2_enabled('inbox') then
    raise exception using errcode = '55000', message = 'CHAT_V2_DISABLED';
  end if;
  if p_tab is null or p_tab not in ('all','buying','selling') or p_page_size is null
     or p_page_size not between 1 and 50 or p_unread_only is null
     or (p_cursor_at is null) <> (p_cursor_id is null)
     or coalesce(length(p_query_text), 0) > 100 then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_PAGE';
  end if;
  if p_listing_id is not null and not exists (
    select 1 from public.listings l where l.id = p_listing_id and l.seller_id = v_actor
  ) then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_DENIED';
  end if;

  with participants as materialized (
    select c.*, coalesce(c.seller_id = v_actor, false) as is_selling,
      case when c.seller_id = v_actor then c.buyer_id else c.seller_id end as peer_id
    from public.conversations c
    where (c.buyer_id = v_actor or c.seller_id = v_actor)
      and (p_listing_id is null or (c.listing_id = p_listing_id and c.seller_id = v_actor))
  ), summaries as materialized (
    select c.*, l.title, l.slug, l.price_paise, l.status::text as listing_status,
      case when app_security.is_listing_publicly_visible(l.id) then l.cover_photo_id end as cover_photo_id,
      coalesce(p.display_name, 'Deleted user') as peer_name,
      left(m.content, 160) as preview, m.sender_id = v_actor as preview_is_own,
      coalesce(u.unread_count, 0) as unread_count
    from participants c
    join public.listings l on l.id = c.listing_id
    left join public.profiles p on p.id = c.peer_id
    left join lateral (
      select x.content, x.sender_id from public.messages x where x.conversation_id = c.id
      order by x.created_at desc, x.id desc limit 1
    ) m on true
    left join public.conversation_read_states rs on rs.conversation_id = c.id and rs.user_id = v_actor
    left join public.messages rm on rm.conversation_id = c.id and rm.id = rs.last_read_message_id
    left join lateral (
      select count(*) as unread_count from public.messages x
      where x.conversation_id = c.id and x.sender_id is distinct from v_actor
        and (rm.id is null or (x.created_at, x.id) > (rm.created_at, rm.id))
    ) u on true
    where coalesce(btrim(p_query_text), '') = ''
      or strpos(lower(l.title), lower(btrim(p_query_text))) > 0
      or strpos(lower(coalesce(p.display_name,'')), lower(btrim(p_query_text))) > 0
  ), filtered as (
    select * from summaries where p_tab = 'all'
      or (p_tab = 'selling' and is_selling) or (p_tab = 'buying' and not is_selling)
  ), grouped as (
    select case when is_selling and p_listing_id is null then listing_id else id end as group_key,
      count(*) as enquiry_count, sum(unread_count) as unread_count,
      (array_agg(id order by last_message_at desc, id desc))[1] as latest_id
    from filtered
    group by is_selling, case when is_selling and p_listing_id is null then listing_id else id end
  ), rows as (
    select s.id, s.last_message_at, jsonb_build_object(
      'id', s.id, 'conversation_id', case when g.enquiry_count = 1 then s.id end,
      'listing_id', s.listing_id, 'is_group', g.enquiry_count > 1,
      'enquiry_count', g.enquiry_count, 'unread_count', g.unread_count,
      'is_selling', s.is_selling, 'last_message_at', s.last_message_at,
      'listing', jsonb_build_object('title',s.title,'slug',s.slug,'price_paise',s.price_paise,
        'status',s.listing_status,'cover_photo_id',s.cover_photo_id),
      'peer_name', case when g.enquiry_count = 1 then s.peer_name end,
      'preview', s.preview, 'preview_is_own', s.preview_is_own
    ) as item
    from grouped g join filtered s on s.id = g.latest_id
    where (not p_unread_only or g.unread_count > 0)
      and (p_cursor_at is null or (s.last_message_at,s.id) < (p_cursor_at,p_cursor_id))
    order by s.last_message_at desc, s.id desc limit p_page_size + 1
  ), page as (
    select * from rows order by last_message_at desc, id desc limit p_page_size
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(item order by last_message_at desc,id desc) from page),'[]'::jsonb),
    'has_more', (select count(*) > p_page_size from rows),
    'next_cursor', case when (select count(*) > p_page_size from rows) then
      (select jsonb_build_object('at',last_message_at,'id',id) from page order by last_message_at,id limit 1) end,
    'counts', (select jsonb_build_object('all',count(*),'buying',count(*) filter(where not is_selling),
      'selling',count(*) filter(where is_selling)) from summaries)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function app_security.impl_chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function app_security.impl_chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean) to authenticated;

create function public.chat_v2_inbox(
  tab text default 'all', page_size integer default 30, cursor_at timestamptz default null,
  cursor_id uuid default null, listing_id uuid default null, query_text text default '', unread_only boolean default false
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select app_security.impl_chat_v2_inbox(tab,page_size,cursor_at,cursor_id,listing_id,query_text,unread_only)
$$;
revoke all on function public.chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean) from public, anon;
grant execute on function public.chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean) to authenticated;

-- Text-compatible readers. Read cursors are never advanced by fetching a page.
create function app_security.impl_chat_v2_messages(
  p_conversation_id uuid, p_page_size integer, p_cursor_at timestamptz, p_cursor_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_actor uuid := auth.uid(); v_peer uuid; v_result jsonb;
begin
  if v_actor is null or coalesce(app_security.get_account_status(v_actor)::text,'') not in ('active','suspended') then
    raise exception using errcode = '42501', message = 'CHAT_ACCESS_DENIED';
  end if;
  if not app_security.chat_v2_enabled('inbox') then
    raise exception using errcode = '55000', message = 'CHAT_V2_DISABLED';
  end if;
  if p_page_size is null or p_page_size not between 1 and 100 or (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_PAGE';
  end if;
  select case when c.buyer_id = v_actor then c.seller_id else c.buyer_id end into v_peer
    from public.conversations c where c.id = p_conversation_id and (c.buyer_id = v_actor or c.seller_id = v_actor);
  if not found then raise exception using errcode = '42501', message = 'CHAT_ACCESS_DENIED'; end if;
  with rows as (
    select m.id,m.conversation_id,m.sender_id,m.content,m.created_at,m.client_request_id
    from public.messages m where m.conversation_id = p_conversation_id
      and (p_cursor_at is null or (m.created_at,m.id) < (p_cursor_at,p_cursor_id))
    order by m.created_at desc,m.id desc limit p_page_size + 1
  ), page as (select * from rows order by created_at desc,id desc limit p_page_size)
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(p) order by created_at,id) from page p),'[]'::jsonb),
    'has_more', (select count(*) > p_page_size from rows),
    'next_cursor', case when (select count(*) > p_page_size from rows) then
      (select jsonb_build_object('at',created_at,'id',id) from page order by created_at,id limit 1) end,
    'peer_read_cursor', (select jsonb_build_object('at',m.created_at,'id',m.id)
      from public.conversation_read_states rs join public.messages m
        on m.conversation_id = rs.conversation_id and m.id = rs.last_read_message_id
      where rs.conversation_id = p_conversation_id and rs.user_id = v_peer)
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function app_security.impl_chat_v2_messages(uuid,integer,timestamptz,uuid) from public, anon, authenticated;
grant execute on function app_security.impl_chat_v2_messages(uuid,integer,timestamptz,uuid) to authenticated;
create function public.chat_v2_messages(conversation_id uuid, page_size integer default 50,
  cursor_at timestamptz default null, cursor_id uuid default null) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select app_security.impl_chat_v2_messages(conversation_id,page_size,cursor_at,cursor_id)
$$;
revoke all on function public.chat_v2_messages(uuid,integer,timestamptz,uuid) from public, anon;
grant execute on function public.chat_v2_messages(uuid,integer,timestamptz,uuid) to authenticated;

create table app_security.chat_safety_jobs (
  message_id uuid primary key references public.messages(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  attempts integer not null default 0 check(attempts between 0 and 5),
  lease_token uuid, next_attempt_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz
);
create index chat_safety_jobs_pending on app_security.chat_safety_jobs(next_attempt_at,message_id)
  where completed_at is null and attempts < 5;
alter table app_security.chat_safety_jobs enable row level security;
alter table app_security.chat_safety_jobs force row level security;
revoke all on app_security.chat_safety_jobs from public, anon, authenticated, service_role;

create table public.message_safety_findings (
  message_id uuid primary key references public.messages(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  rule_version text not null check(rule_version = 'chat_india_v1'),
  rule_ids text[] not null check(cardinality(rule_ids) between 1 and 8 and rule_ids <@ array[
    'OTP_PIN','QR_RECEIVE','ADVANCE_VIEWING','IMPERSONATION_FEE',
    'UPI_COLLECT','PAYMENT_LINK','ADVANCE_DELIVERY','OFF_PLATFORM']::text[]),
  created_at timestamptz not null default clock_timestamp()
);
create index message_safety_findings_recipient on public.message_safety_findings(recipient_id,message_id);
alter table public.message_safety_findings enable row level security;
alter table public.message_safety_findings force row level security;
revoke all on public.message_safety_findings from public, anon, authenticated, service_role;
grant select on public.message_safety_findings to authenticated;
-- Not published to Realtime. Recipient polling/read API only; sender never receives results.
create policy chat_safety_recipient on public.message_safety_findings for select to authenticated using (
  recipient_id = (select auth.uid())
  and app_security.chat_v2_enabled('safety_warnings')
  and app_security.get_account_status((select auth.uid())) in ('active','suspended')
  and exists(select 1 from public.messages m join public.conversations c on c.id = m.conversation_id
    where m.id = message_id and m.sender_id is distinct from (select auth.uid())
      and (c.buyer_id = (select auth.uid()) or c.seller_id = (select auth.uid())))
);
-- Policy helpers may be executed but expose only the two shipping capabilities.
grant execute on function app_security.chat_v2_enabled(text) to authenticated;

create function app_security.chat_safety_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if app_security.chat_v2_enabled('safety_warnings') then
    insert into app_security.chat_safety_jobs(message_id,recipient_id)
      select new.id, case when new.sender_id = c.buyer_id then c.seller_id else c.buyer_id end
      from public.conversations c where c.id = new.conversation_id
        and (new.sender_id = c.buyer_id or new.sender_id = c.seller_id)
        and c.buyer_id is not null and c.seller_id is not null
      on conflict do nothing;
  end if;
  return new;
exception when others then
  -- Never block message delivery for a caution. Service recovery below repairs missed jobs.
  return new;
end;
$$;
revoke all on function app_security.chat_safety_enqueue() from public,anon,authenticated;
create trigger chat_safety_enqueue after insert on public.messages
  for each row execute function app_security.chat_safety_enqueue();

-- Service calls run through private implementations; no client-chosen recipient/text.
create function app_security.impl_chat_safety_claim(p_batch_size integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_result jsonb;
begin
  if not app_security.chat_v2_enabled('safety_warnings') then return '[]'::jsonb; end if;
  if p_batch_size is null or p_batch_size not between 1 and 20 then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_BATCH';
  end if;
  -- Recover missed inserts, including legacy RPC callers, without exposing results to sender.
  insert into app_security.chat_safety_jobs(message_id,recipient_id)
    select m.id,case when m.sender_id = c.buyer_id then c.seller_id else c.buyer_id end
    from public.messages m join public.conversations c on c.id = m.conversation_id
    where c.buyer_id is not null and c.seller_id is not null
      and (m.sender_id = c.buyer_id or m.sender_id = c.seller_id)
      and not exists(select 1 from app_security.chat_safety_jobs j where j.message_id = m.id)
    order by m.created_at desc,m.id desc limit p_batch_size
    on conflict do nothing;
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
revoke all on function app_security.impl_chat_safety_claim(integer) from public, anon, authenticated;
grant execute on function app_security.impl_chat_safety_claim(integer) to service_role;
create function public.chat_safety_claim(batch_size integer default 20) returns jsonb
language sql security invoker set search_path = '' as $$select app_security.impl_chat_safety_claim(batch_size)$$;
revoke all on function public.chat_safety_claim(integer) from public, anon, authenticated;
grant execute on function public.chat_safety_claim(integer) to service_role;

create function app_security.impl_chat_safety_complete(p_message_id uuid,p_lease_token uuid,p_rule_ids text[])
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_job app_security.chat_safety_jobs;
begin
  if not app_security.chat_v2_enabled('safety_warnings') then return false; end if;
  if p_rule_ids is null or cardinality(p_rule_ids) > 8 or array_position(p_rule_ids,null) is not null
    or not (p_rule_ids <@ array['OTP_PIN','QR_RECEIVE','ADVANCE_VIEWING','IMPERSONATION_FEE',
      'UPI_COLLECT','PAYMENT_LINK','ADVANCE_DELIVERY','OFF_PLATFORM']::text[]) then
    raise exception using errcode = '22023', message = 'INVALID_CHAT_FINDINGS';
  end if;
  select * into v_job from app_security.chat_safety_jobs j where j.message_id = p_message_id for update;
  if not found or v_job.lease_token is distinct from p_lease_token or p_lease_token is null then return false; end if;
  if v_job.completed_at is not null then return true; end if;
  if v_job.next_attempt_at <= clock_timestamp() then return false; end if;
  if cardinality(p_rule_ids) > 0 then
    insert into public.message_safety_findings(message_id,recipient_id,rule_version,rule_ids)
    values(p_message_id,v_job.recipient_id,'chat_india_v1',p_rule_ids);
  end if;
  update app_security.chat_safety_jobs set completed_at = clock_timestamp() where message_id = p_message_id;
  return true;
end;
$$;
revoke all on function app_security.impl_chat_safety_complete(uuid,uuid,text[]) from public, anon, authenticated;
grant execute on function app_security.impl_chat_safety_complete(uuid,uuid,text[]) to service_role;
create function public.chat_safety_complete(message_id uuid,lease_token uuid,rule_ids text[]) returns boolean
language sql security invoker set search_path = '' as $$
  select app_security.impl_chat_safety_complete(message_id,lease_token,rule_ids)
$$;
revoke all on function public.chat_safety_complete(uuid,uuid,text[]) from public, anon, authenticated;
grant execute on function public.chat_safety_complete(uuid,uuid,text[]) to service_role;
commit;
