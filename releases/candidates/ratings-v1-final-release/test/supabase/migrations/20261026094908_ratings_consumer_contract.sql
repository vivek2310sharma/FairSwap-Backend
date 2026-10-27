begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Only current public profile names and a nonremoved listing title are projected.
-- Never snapshot listing content or join media, contact data or case evidence.
create function app_security.rating_context(p_trade_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select pg_catalog.jsonb_build_object('trade_id',t.id,'listing_id',l.id,
  'listing_title',coalesce(l.title,'Listing removed'),'sold_at',t.sold_at)
 from public.rating_trades t left join public.listings l on l.id=t.listing_id
  and l.status in ('active','reserved','sold')
  and app_security.get_account_status(l.seller_id)='active'
 where t.id=p_trade_id
$$;

-- Preserve the installed visibility predicate, private ACL and callers (including
-- privacy export), adding only safe card context. No new route to sealed content.
create or replace function app_security.rating_review_json(p_id uuid,p_own boolean default false) returns jsonb
language sql stable security definer set search_path='' as $$
 select pg_catalog.jsonb_build_object('id',r.id,
 'author_id',case when app_security.get_account_status(r.author_id)='active' then r.author_id end,
 'recipient_id',case when app_security.get_account_status(r.recipient_id)='active' then r.recipient_id end,
 'author_display_name',(select p.display_name from public.profiles p where p.id=r.author_id and app_security.get_account_status(p.id)='active'),
 'recipient_display_name',(select p.display_name from public.profiles p where p.id=r.recipient_id and app_security.get_account_status(p.id)='active'),
 'context',app_security.rating_context(t.id),
 'reviewer_role',r.reviewer_role,'communication',r.communication,'payment_item',r.payment_item,'meetup',r.meetup,
 'score',r.score,'body',case when not r.redacted then r.body end,
 'tags',coalesce((select pg_catalog.jsonb_agg(x.code order by x.code) from unnest(r.tags) a(code) join app_security.rating_tags x on x.code=a.code where not x.internal_signal),'[]'::jsonb),
 'submitted_at',r.submitted_at,'published_at',r.published_at,
 'reply',(select pg_catalog.jsonb_build_object('body',q.body,'created_at',q.created_at) from public.rating_replies q where q.review_id=r.id))
 from public.rating_reviews r join public.rating_trades t on t.id=r.trade_id
 where r.id=p_id and ((p_own and r.author_id=auth.uid()) or (r.published_at is not null and not r.hidden and not r.redacted and not t.voided and t.state<>'disputed'))
$$;

create index rating_trades_conversation on public.rating_trades(conversation_id) where conversation_id is not null;
create function app_security.impl_ratings_trade_for_conversation(p_conversation_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u uuid; c public.conversations; v_trade uuid;
begin
 u:=app_security.rating_actor();
 select * into c from public.conversations where id=p_conversation_id;
 if not found or (u is distinct from c.seller_id and u is distinct from c.buyer_id) then
  raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501';
 end if;
 select t.id into v_trade from public.rating_trades t
 where (t.conversation_id=c.id or (t.state='pending_selection' and t.conversation_id is null and t.listing_id=c.listing_id and t.seller_id=u))
 and u in (t.seller_id,t.buyer_id);
 if v_trade is null then return null; end if;
 return app_security.impl_ratings_trade(v_trade);
end $$;
create function public.ratings_trade_for_conversation(conversation_id uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_trade_for_conversation(conversation_id)$$;

-- Separate projection preserves ratings_given's review-only response. Ordering is
-- immutable submission time for reviews, deadline for missing own submissions.
create function app_security.impl_ratings_given_history(p_before_at timestamptz,p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u uuid; result jsonb;
begin
 u:=app_security.rating_actor();
 if (p_before_at is null)<>(p_before_id is null) then raise exception 'RATINGS_INVALID_CURSOR' using errcode='22023'; end if;
 with entries as (
  select r.id,r.submitted_at at,pg_catalog.jsonb_build_object('kind','review','id',r.id,'at',r.submitted_at,'review',app_security.rating_review_json(r.id,true)) value
  from public.rating_reviews r where r.author_id=u
  union all
  select t.id,t.deadline,pg_catalog.jsonb_build_object('kind','not_rated','id',t.id,'at',t.deadline,
   'context',app_security.rating_context(t.id),'my_role',case when u=t.seller_id then 'seller' else 'buyer' end)
  from public.rating_trades t where u in (t.seller_id,t.buyer_id)
  and t.seller_id is not null and t.buyer_id is not null and not t.voided
  and t.state in ('pending_buyer','confirmed','disputed','expired_unconfirmed')
  and t.deadline<=pg_catalog.statement_timestamp()
  and not exists(select 1 from public.rating_reviews r where r.trade_id=t.id and r.author_id=u)
 ), page as (
  select * from entries where p_before_at is null or (at,id)<(p_before_at,p_before_id) order by at desc,id desc limit 21
 ), shown as (select * from page order by at desc,id desc limit 20)
 select pg_catalog.jsonb_build_object('items',coalesce((select jsonb_agg(value order by at desc,id desc) from shown),'[]'::jsonb),
 'has_more',(select count(*)>20 from page),'next_cursor',case when (select count(*)>20 from page) then
 (select jsonb_build_object('before_at',at,'before_id',id) from shown order by at,id limit 1) end) into result;
 return result;
end $$;
create function public.ratings_given_history(before_at timestamptz default null,before_id uuid default null) returns jsonb
language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_given_history(before_at,before_id)$$;

create index rating_cases_queue on app_security.rating_cases(kind,created_at desc,id desc);
create function app_security.impl_admin_ratings_cases(p_kind text,p_status text,p_before_at timestamptz,p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if auth.uid() is null or not app_security.is_active_staff_aal2('moderator') then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 if not (select staff_enabled from app_security.ratings_settings) then raise exception 'RATINGS_STAFF_DISABLED' using errcode='55000'; end if;
 if p_kind is null or p_kind not in ('review_report','dispute') or p_status is null or p_status not in ('open','resolved','all') then raise exception 'RATINGS_INVALID_QUEUE' using errcode='22023'; end if;
 if (p_before_at is null)<>(p_before_id is null) then raise exception 'RATINGS_INVALID_CURSOR' using errcode='22023'; end if;
 with page as (
  select c.id,c.created_at at,pg_catalog.jsonb_build_object('id',c.id,'trade_id',c.trade_id,'review_id',c.review_id,
   'support_ticket_id',c.support_ticket_id,'kind',c.kind,'created_at',c.created_at,'resolved_at',c.resolved_at) value
  from app_security.rating_cases c join public.rating_trades t on t.id=c.trade_id
  where c.kind=p_kind and (p_status='all' or (p_status='open')=(c.resolved_at is null))
  and auth.uid() is distinct from t.seller_id and auth.uid() is distinct from t.buyer_id and auth.uid() is distinct from c.reporter_id
  and (p_before_at is null or (c.created_at,c.id)<(p_before_at,p_before_id))
  order by c.created_at desc,c.id desc limit 21
 ), shown as (select * from page order by at desc,id desc limit 20)
 select pg_catalog.jsonb_build_object('items',coalesce((select jsonb_agg(value order by at desc,id desc) from shown),'[]'::jsonb),
 'has_more',(select count(*)>20 from page),'next_cursor',case when (select count(*)>20 from page) then
 (select jsonb_build_object('before_at',at,'before_id',id) from shown order by at,id limit 1) end) into result;
 return result;
end $$;
create function public.admin_ratings_cases(kind text,status text default 'open',before_at timestamptz default null,before_id uuid default null) returns jsonb
language sql stable security invoker set search_path='' as $$select app_security.impl_admin_ratings_cases(kind,status,before_at,before_id)$$;

revoke all on function app_security.rating_context(uuid),app_security.impl_ratings_trade_for_conversation(uuid),public.ratings_trade_for_conversation(uuid),app_security.impl_ratings_given_history(timestamptz,uuid),public.ratings_given_history(timestamptz,uuid),app_security.impl_admin_ratings_cases(text,text,timestamptz,uuid),public.admin_ratings_cases(text,text,timestamptz,uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_ratings_trade_for_conversation(uuid),public.ratings_trade_for_conversation(uuid),app_security.impl_ratings_given_history(timestamptz,uuid),public.ratings_given_history(timestamptz,uuid),app_security.impl_admin_ratings_cases(text,text,timestamptz,uuid),public.admin_ratings_cases(text,text,timestamptz,uuid) to authenticated;
commit;
