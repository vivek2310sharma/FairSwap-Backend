begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Serialize this bounded domain's writes, including aggregate recomputation.
-- Listing transitions take the listing row lock BEFORE this lock; no Ratings
-- path takes a listing lock after acquiring this lock.
create function app_security.rating_lock() returns void language sql volatile set search_path='' as $$
 select pg_catalog.pg_advisory_xact_lock(726184031201::bigint)
$$;
create function app_security.rating_actor() returns uuid language plpgsql stable security definer set search_path='' as $$
declare u uuid := auth.uid();
begin
 if u is null or app_security.get_account_status(u) is distinct from 'active' then
  raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501';
 end if;
 if not (select enabled from app_security.ratings_settings) then
  raise exception 'RATINGS_DISABLED' using errcode='55000';
 end if;
 return u;
end $$;

create function app_security.rating_recompute(p_users uuid[]) returns void language plpgsql security definer set search_path='' as $$
begin
 -- Called with the domain transaction lock; compute from authoritative rows.
 -- All profiles have a materialized zero baseline, never inferred from sold listings.
 update public.profile_rating_stats s set
 published_review_count=(select count(*) from public.rating_reviews r join public.rating_trades t on t.id=r.trade_id where r.recipient_id=s.user_id and r.published_at is not null and not r.hidden and not r.redacted and not t.voided and t.state<>'disputed'),
 counted_review_count=x.n,
 completed_trades=(select count(*) from public.rating_trades t where s.user_id in (t.seller_id,t.buyer_id) and t.state='confirmed' and t.buyer_confirmed_at is not null and not t.voided and not t.risk_excluded),
 score=case when x.n >= (select min_reviews from app_security.ratings_settings) then x.score end,
 communication_average=case when x.n >= (select min_reviews from app_security.ratings_settings) then x.c end,
 payment_item_average=case when x.n >= (select min_reviews from app_security.ratings_settings) then x.p end,
 meetup_average=case when x.n >= (select min_reviews from app_security.ratings_settings) then x.m end
 from (
  select p.id, count(r.id)::integer n, round(avg(r.score),1) score,
   round(avg(r.communication),2) c,round(avg(r.payment_item),2) p,round(avg(r.meetup),2) m
  from public.profiles p left join (public.rating_reviews r join public.rating_trades t
   on t.id=r.trade_id and t.state='confirmed' and t.buyer_confirmed_at is not null and not t.voided and not t.risk_excluded)
   on r.recipient_id=p.id and r.published_at is not null and not r.hidden and not r.redacted
  where p.id=any(p_users) group by p.id
 ) x where x.id=s.user_id;
end $$;

create function app_security.rating_publish(p_trade uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.rating_reviews r set published_at=coalesce(r.published_at,pg_catalog.clock_timestamp())
 from public.rating_trades t where t.id=p_trade and r.trade_id=t.id and not t.voided and t.state<>'disputed'
 and (t.deadline<=pg_catalog.clock_timestamp() or (select count(*) from public.rating_reviews x where x.trade_id=t.id)=2);
end $$;

create function app_security.rating_sold_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not (select enabled from app_security.ratings_settings) then return new; end if;
 perform app_security.rating_lock();
 insert into public.rating_trades(listing_id,seller_id,state,sold_at,deadline)
 values(new.id,new.seller_id,'pending_selection',new.sold_at,new.sold_at+interval '14 days') on conflict(listing_id) do nothing;
 return new;
end $$;
create trigger ratings_listing_sold after update of status on public.listings for each row
 when (new.status='sold' and old.status is distinct from new.status) execute function app_security.rating_sold_trigger();

create function app_security.impl_ratings_sell(p_listing_id uuid,p_choice text,p_conversation_id uuid) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; l record; t public.rating_trades; c record;
begin
 u:=app_security.rating_actor();
 if p_choice is null or p_choice not in ('select','pending','none') or (p_choice='select') <> (p_conversation_id is not null) then
  raise exception 'RATINGS_INVALID_CHOICE' using errcode='22023';
 end if;
 select * into l from public.listings where id=p_listing_id for update;
 if not found or l.seller_id is distinct from u then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 -- Calls the existing policy/status/audit implementation without replacing it.
 if l.status<>'sold' then perform app_security.impl_seller_transition_listing(p_listing_id,'mark_sold'); end if;
 perform app_security.rating_lock();
 select * into t from public.rating_trades where listing_id=p_listing_id for update;
 if not found then raise exception 'RATINGS_LEGACY_SOLD' using errcode='55000'; end if;
 if t.state<>'pending_selection' then
  if (p_choice='pending') or (p_choice='none' and t.state='unattributed') or (p_choice='select' and t.conversation_id=p_conversation_id) then
   return pg_catalog.jsonb_build_object('trade_id',t.id,'state',t.state,'deadline',t.deadline);
  end if;
  raise exception 'RATINGS_TRADE_CONFLICT' using errcode='23505';
 end if;
 if t.deadline<=pg_catalog.clock_timestamp() then raise exception 'RATINGS_WINDOW_CLOSED' using errcode='55000'; end if;
 if p_choice='select' then
  select * into c from public.conversations where id=p_conversation_id and listing_id=p_listing_id and seller_id=u;
  if not found or c.buyer_id is null or c.buyer_id=u or app_security.get_account_status(c.buyer_id) is distinct from 'active' then
   raise exception 'RATINGS_INVALID_BUYER' using errcode='22023';
  end if;
  update public.rating_trades set buyer_id=c.buyer_id,conversation_id=c.id,state='pending_buyer' where id=t.id returning * into t;
  insert into public.trade_system_events(trade_id,kind) values(t.id,'buyer_selected'),(t.id,'pending_buyer') on conflict do nothing;
 elsif p_choice='none' then
  update public.rating_trades set state='unattributed',closed_at=pg_catalog.clock_timestamp() where id=t.id returning * into t;
 end if;
 return pg_catalog.jsonb_build_object('trade_id',t.id,'state',t.state,'deadline',t.deadline);
end $$;

create function app_security.impl_ratings_buyer_action(p_trade_id uuid,p_action text) returns jsonb
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; t public.rating_trades; v_case uuid; v_ticket uuid;
begin
 u:=app_security.rating_actor(); perform app_security.rating_lock();
 select * into t from public.rating_trades where id=p_trade_id for update;
 if not found or t.buyer_id is distinct from u then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 if p_action is null or p_action not in ('confirm','dispute') then raise exception 'RATINGS_INVALID_ACTION' using errcode='22023'; end if;
 if t.deadline<=pg_catalog.clock_timestamp() then raise exception 'RATINGS_WINDOW_CLOSED' using errcode='55000'; end if;
 if t.voided or t.state not in ('pending_buyer','confirmed','disputed') then raise exception 'RATINGS_TRADE_FROZEN' using errcode='55000'; end if;
 if p_action='confirm' then
  if t.state='disputed' then raise exception 'RATINGS_TRADE_FROZEN' using errcode='55000'; end if;
  update public.rating_trades set state='confirmed',buyer_confirmed_at=coalesce(buyer_confirmed_at,pg_catalog.clock_timestamp()) where id=t.id;
  insert into public.trade_system_events(trade_id,kind) values(t.id,'confirmed') on conflict do nothing;
 else
  if t.state<>'disputed' then
   update public.rating_trades set state='disputed' where id=t.id;
   insert into public.trade_system_events(trade_id,kind) values(t.id,'disputed') on conflict do nothing;
   insert into public.support_tickets(user_id,category,subject,priority) values(u,'safety','Ratings trade disputed','high') returning id into v_ticket;
   insert into app_security.rating_cases(trade_id,reporter_id,support_ticket_id,kind,reason)
   values(t.id,u,v_ticket,'dispute','Buyer denied purchase') returning id into v_case;
  end if;
 end if;
 perform app_security.rating_recompute(array[t.seller_id,t.buyer_id]);
 return pg_catalog.jsonb_build_object('trade_id',t.id,'state',case when p_action='confirm' then 'confirmed' else 'disputed' end);
end $$;

create function app_security.impl_ratings_submit(p_trade_id uuid,p_communication integer,p_payment_item integer,p_meetup integer,p_body text,p_tags text[]) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; t public.rating_trades; v_role text; v_id uuid; v_body text;
begin
 u:=app_security.rating_actor(); perform app_security.rating_lock();
 select * into t from public.rating_trades where id=p_trade_id for update;
 if not found or (u is distinct from t.seller_id and u is distinct from t.buyer_id) then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 if t.deadline<=pg_catalog.clock_timestamp() then raise exception 'RATINGS_WINDOW_CLOSED' using errcode='55000'; end if;
 if t.voided or t.state not in ('pending_buyer','confirmed') or t.seller_id is null or t.buyer_id is null
  or app_security.get_account_status(t.seller_id) is distinct from 'active'
  or app_security.get_account_status(t.buyer_id) is distinct from 'active' then raise exception 'RATINGS_TRADE_FROZEN' using errcode='55000'; end if;
 if u=t.buyer_id and t.buyer_confirmed_at is null then raise exception 'RATINGS_CONFIRM_FIRST' using errcode='55000'; end if;
 v_role:=case when u=t.seller_id then 'seller' else 'buyer' end;
 if p_communication is null or p_payment_item is null or p_meetup is null or p_communication not between 1 and 4 or p_payment_item not between 1 and 4 or p_meetup not between 1 and 4 then
  raise exception 'RATINGS_INVALID_FACES' using errcode='22023';
 end if;
 v_body:=app_security.rating_text(p_body);
 if p_tags is null or cardinality(p_tags)>5 or cardinality(p_tags)<>(select count(distinct x) from unnest(p_tags) x)
  or exists(select 1 from unnest(p_tags) x where not exists(select 1 from app_security.rating_tags g where g.code=x and g.enabled and g.reviewer_role in (v_role,'both'))) then
  raise exception 'RATINGS_INVALID_TAGS' using errcode='22023';
 end if;
 select id into v_id from public.rating_reviews where trade_id=t.id and reviewer_role=v_role;
 if found then
  if exists(select 1 from public.rating_reviews where id=v_id and communication=p_communication and payment_item=p_payment_item and meetup=p_meetup and body is not distinct from v_body and tags=p_tags) then return v_id; end if;
  raise exception 'RATINGS_REVIEW_IMMUTABLE' using errcode='23505';
 end if;
 insert into public.rating_reviews(trade_id,author_id,recipient_id,reviewer_role,communication,payment_item,meetup,body,tags)
 values(t.id,u,case when v_role='seller' then t.buyer_id else t.seller_id end,v_role,p_communication,p_payment_item,p_meetup,v_body,p_tags) returning id into v_id;
 insert into public.trade_system_events(trade_id,kind) values(t.id,'rated_'||v_role) on conflict do nothing;
 perform app_security.rating_publish(t.id); perform app_security.rating_recompute(array[t.seller_id,t.buyer_id]);
 return v_id;
end $$;

create function app_security.impl_ratings_reply(p_review_id uuid,p_body text) returns uuid
language plpgsql volatile security definer set search_path='' as $$
declare u uuid; v_body text;
begin
 u:=app_security.rating_actor(); perform app_security.rating_lock(); v_body:=app_security.rating_text(p_body);
 if v_body is null then raise exception 'RATINGS_INVALID_TEXT' using errcode='22023'; end if;
 if not exists(select 1 from public.rating_reviews r join public.rating_trades t on t.id=r.trade_id where r.id=p_review_id and r.recipient_id=u and r.body is not null and r.published_at is not null and not r.hidden and not r.redacted and not t.voided and t.state<>'disputed') then
  raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501';
 end if;
 if exists(select 1 from public.rating_replies where review_id=p_review_id) then
  if exists(select 1 from public.rating_replies where review_id=p_review_id and body=v_body) then return p_review_id; end if;
  raise exception 'RATINGS_REPLY_IMMUTABLE' using errcode='23505';
 end if;
 insert into public.rating_replies(review_id,author_id,body) values(p_review_id,u,v_body);
 return p_review_id;
end $$;

create function public.ratings_sell(listing_id uuid,choice text default 'pending',conversation_id uuid default null) returns jsonb language sql volatile security invoker set search_path='' as $$select app_security.impl_ratings_sell(listing_id,choice,conversation_id)$$;
create function public.ratings_buyer_action(trade_id uuid,action text) returns jsonb language sql volatile security invoker set search_path='' as $$select app_security.impl_ratings_buyer_action(trade_id,action)$$;
create function public.ratings_submit(trade_id uuid,communication integer,payment_item integer,meetup integer,body text default null,tags text[] default '{}') returns uuid language sql volatile security invoker set search_path='' as $$select app_security.impl_ratings_submit(trade_id,communication,payment_item,meetup,body,tags)$$;
create function public.ratings_reply(review_id uuid,body text) returns uuid language sql volatile security invoker set search_path='' as $$select app_security.impl_ratings_reply(review_id,body)$$;

revoke all on function app_security.rating_lock(),app_security.rating_actor(),app_security.rating_recompute(uuid[]),app_security.rating_publish(uuid),app_security.rating_sold_trigger() from public,anon,authenticated,service_role;
revoke all on function app_security.impl_ratings_sell(uuid,text,uuid),app_security.impl_ratings_buyer_action(uuid,text),app_security.impl_ratings_submit(uuid,integer,integer,integer,text,text[]),app_security.impl_ratings_reply(uuid,text),public.ratings_sell(uuid,text,uuid),public.ratings_buyer_action(uuid,text),public.ratings_submit(uuid,integer,integer,integer,text,text[]),public.ratings_reply(uuid,text) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_ratings_sell(uuid,text,uuid),app_security.impl_ratings_buyer_action(uuid,text),app_security.impl_ratings_submit(uuid,integer,integer,integer,text,text[]),app_security.impl_ratings_reply(uuid,text),public.ratings_sell(uuid,text,uuid),public.ratings_buyer_action(uuid,text),public.ratings_submit(uuid,integer,integer,integer,text,text[]),public.ratings_reply(uuid,text) to authenticated;
commit;
