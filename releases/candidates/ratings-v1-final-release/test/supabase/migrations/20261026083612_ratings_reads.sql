begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create view app_security.rating_pending as
 select t.id,t.listing_id,t.sold_at,t.deadline,t.state,t.seller_id user_id,'select_buyer'::text action
 from public.rating_trades t where t.state='pending_selection' and not t.voided and t.deadline>clock_timestamp()
 union all
 select t.id,t.listing_id,t.sold_at,t.deadline,t.state,u.id,
 case when u.id=t.buyer_id and t.buyer_confirmed_at is null then 'confirm_and_rate' else 'rate' end
 from public.rating_trades t cross join lateral (values(t.seller_id),(t.buyer_id)) u(id)
 where t.state in ('pending_buyer','confirmed') and not t.voided and t.deadline>clock_timestamp()
 and u.id is not null and not exists(select 1 from public.rating_reviews r where r.trade_id=t.id and r.author_id=u.id);
revoke all on app_security.rating_pending from public,anon,authenticated,service_role;

create function app_security.rating_review_json(p_id uuid,p_own boolean default false) returns jsonb
language sql stable security definer set search_path='' as $$
 select pg_catalog.jsonb_build_object('id',r.id,'author_id',case when app_security.get_account_status(r.author_id)='active' then r.author_id end,
 'recipient_id',r.recipient_id,'reviewer_role',r.reviewer_role,'communication',r.communication,'payment_item',r.payment_item,'meetup',r.meetup,
 'score',r.score,'body',case when not r.redacted then r.body end,
 'tags',coalesce((select pg_catalog.jsonb_agg(x.code order by x.code) from unnest(r.tags) a(code) join app_security.rating_tags x on x.code=a.code where not x.internal_signal),'[]'::jsonb),
 'submitted_at',r.submitted_at,'published_at',r.published_at,
 'reply',(select pg_catalog.jsonb_build_object('body',q.body,'created_at',q.created_at) from public.rating_replies q where q.review_id=r.id))
 from public.rating_reviews r join public.rating_trades t on t.id=r.trade_id
 where r.id=p_id and ((p_own and r.author_id=auth.uid()) or (r.published_at is not null and not r.hidden and not r.redacted and not t.voided and t.state<>'disputed'))
$$;

create function app_security.impl_ratings_page(p_kind text,p_target uuid,p_before_at timestamptz,p_before_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u uuid; result jsonb;
begin
 if (p_before_at is null)<>(p_before_id is null) then raise exception 'RATINGS_INVALID_CURSOR' using errcode='22023'; end if;
 if p_kind='public' then
  if not (select public_reads from app_security.ratings_settings) then raise exception 'RATINGS_DISABLED' using errcode='55000'; end if;
  if app_security.get_account_status(p_target) is distinct from 'active' then return '{"items":[],"has_more":false,"next_cursor":null}'; end if;
 else
  u:=app_security.rating_actor();
 end if;
 if p_kind='candidates' then
  if not exists(select 1 from public.listings where id=p_target and seller_id=u) then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 elsif p_kind='events' then
  if not exists(select 1 from public.rating_trades where id=p_target and u in (seller_id,buyer_id)) then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 elsif p_kind not in ('given','received','pending','public') then raise exception 'RATINGS_INVALID_PAGE' using errcode='22023'; end if;
 with candidates as (
  select c.id,c.created_at at,pg_catalog.jsonb_build_object('id',c.id,'buyer_id',c.buyer_id,'display_name',p.display_name,'created_at',c.created_at) value
  from public.conversations c join public.profiles p on p.id=c.buyer_id
  where p_kind='candidates' and c.listing_id=p_target and c.seller_id=u and c.buyer_id<>u and app_security.get_account_status(c.buyer_id)='active'
  union all
  select a.id,a.sold_at,pg_catalog.jsonb_build_object('id',a.id,'listing_id',a.listing_id,'sold_at',a.sold_at,'deadline',a.deadline,'state',a.state,'action',a.action)
  from app_security.rating_pending a where p_kind='pending' and a.user_id=u
  union all
  select r.id,r.submitted_at,app_security.rating_review_json(r.id,p_kind='given')
  from public.rating_reviews r join public.rating_trades t on t.id=r.trade_id
  where (p_kind='given' and r.author_id=u) or
   (p_kind in ('received','public') and r.recipient_id=case when p_kind='public' then p_target else u end
    and r.published_at is not null and not r.hidden and not r.redacted and not t.voided and t.state<>'disputed')
  union all
  select e.id,e.created_at,pg_catalog.jsonb_build_object('id',e.id,'trade_id',e.trade_id,'kind',e.kind,'created_at',e.created_at)
  from public.trade_system_events e where p_kind='events' and e.trade_id=p_target
 ), page as (
  select * from candidates where p_before_at is null or (at,id)<(p_before_at,p_before_id) order by at desc,id desc limit 21
 ), shown as (select * from page order by at desc,id desc limit 20)
 select pg_catalog.jsonb_build_object('items',coalesce((select jsonb_agg(value order by at desc,id desc) from shown),'[]'::jsonb),
  'has_more',(select count(*)>20 from page),
  'next_cursor',case when (select count(*)>20 from page) then (select jsonb_build_object('before_at',at,'before_id',id) from shown order by at,id limit 1) end) into result;
 return result;
end $$;

create function app_security.impl_ratings_summary(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not (select public_reads from app_security.ratings_settings) then raise exception 'RATINGS_DISABLED' using errcode='55000'; end if;
 if app_security.get_account_status(p_user_id) is distinct from 'active' then return null; end if;
 return (select to_jsonb(s)||pg_catalog.jsonb_build_object('display_state',case when s.score is null then 'no_rating_yet' else 'rated' end) from public.profile_rating_stats s where s.user_id=p_user_id);
end $$;
create function app_security.impl_ratings_pending_count() returns integer language plpgsql stable security definer set search_path='' as $$
declare u uuid;
begin u:=app_security.rating_actor(); return (select count(*)::integer from app_security.rating_pending where user_id=u); end $$;
create function app_security.impl_ratings_trade(p_trade_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u uuid; t public.rating_trades;
begin
 u:=app_security.rating_actor(); select * into t from public.rating_trades where id=p_trade_id;
 if not found or (u is distinct from t.seller_id and u is distinct from t.buyer_id) then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 return pg_catalog.jsonb_build_object('id',t.id,'listing_id',t.listing_id,'conversation_id',t.conversation_id,'state',t.state,'deadline',t.deadline,
 'buyer_confirmed',t.buyer_confirmed_at is not null,'can_dispute',u=t.buyer_id and t.deadline>pg_catalog.clock_timestamp() and t.state in ('pending_buyer','confirmed') and not t.voided,
 'my_review_id',(select r.id from public.rating_reviews r where r.trade_id=t.id and r.author_id=u),
 'my_rating_status',case when exists(select 1 from public.rating_reviews r where r.trade_id=t.id and r.author_id=u) then 'submitted' when t.deadline<=pg_catalog.clock_timestamp() then 'not_rated' else 'pending' end);
end $$;

create function public.ratings_buyer_candidates(listing_id uuid,before_at timestamptz default null,before_id uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_page('candidates',listing_id,before_at,before_id)$$;
create function public.ratings_pending(before_at timestamptz default null,before_id uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_page('pending',null,before_at,before_id)$$;
create function public.ratings_given(before_at timestamptz default null,before_id uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_page('given',null,before_at,before_id)$$;
create function public.ratings_received(before_at timestamptz default null,before_id uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_page('received',null,before_at,before_id)$$;
create function public.ratings_public_reviews(user_id uuid,before_at timestamptz default null,before_id uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_page('public',user_id,before_at,before_id)$$;
create function public.ratings_events(trade_id uuid,before_at timestamptz default null,before_id uuid default null) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_page('events',trade_id,before_at,before_id)$$;
create function public.ratings_summary(user_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_summary(user_id)$$;
create function public.ratings_trade(trade_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_trade(trade_id)$$;
create function public.ratings_pending_count() returns integer language sql stable security invoker set search_path='' as $$select app_security.impl_ratings_pending_count()$$;

revoke all on function app_security.rating_review_json(uuid,boolean),app_security.impl_ratings_page(text,uuid,timestamptz,uuid),app_security.impl_ratings_summary(uuid),app_security.impl_ratings_pending_count(),app_security.impl_ratings_trade(uuid),public.ratings_buyer_candidates(uuid,timestamptz,uuid),public.ratings_pending(timestamptz,uuid),public.ratings_given(timestamptz,uuid),public.ratings_received(timestamptz,uuid),public.ratings_public_reviews(uuid,timestamptz,uuid),public.ratings_events(uuid,timestamptz,uuid),public.ratings_summary(uuid),public.ratings_trade(uuid),public.ratings_pending_count() from public,anon,authenticated,service_role;
grant execute on function app_security.impl_ratings_page(text,uuid,timestamptz,uuid),app_security.impl_ratings_summary(uuid),public.ratings_public_reviews(uuid,timestamptz,uuid),public.ratings_summary(uuid) to anon,authenticated;
grant execute on function app_security.impl_ratings_pending_count(),app_security.impl_ratings_trade(uuid),public.ratings_buyer_candidates(uuid,timestamptz,uuid),public.ratings_pending(timestamptz,uuid),public.ratings_given(timestamptz,uuid),public.ratings_received(timestamptz,uuid),public.ratings_events(uuid,timestamptz,uuid),public.ratings_trade(uuid),public.ratings_pending_count() to authenticated;
commit;
