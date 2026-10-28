begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Historical receipts remain deduplication evidence; never replay them blindly.
alter table app_security.rating_notification_receipts
 add column notification_id uuid references public.notifications(id) on delete set null,
 add column delivery_version integer not null default 0 check(delivery_version in (0,1));
create unique index ratings_notification_delivery_unique
 on app_security.rating_notification_receipts(notification_id) where notification_id is not null;

-- Owner-provisioned, expiring synthetic fixtures only. No API can enroll fixtures.
create table app_security.rating_acceptance_fixtures (
 trade_id uuid primary key references public.rating_trades(id),
 expires_at timestamptz not null check(expires_at<=created_at+interval '1 hour'),
 created_at timestamptz not null default clock_timestamp()
);
alter table app_security.rating_acceptance_fixtures enable row level security;
alter table app_security.rating_acceptance_fixtures force row level security;
revoke all on app_security.rating_acceptance_fixtures from public,anon,authenticated,service_role;

create function app_security.ratings_assert_fixture(p_trade_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare t public.rating_trades;
begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1
 or not exists(select 1 from vault.decrypted_secrets where name='project_url'
 and decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co') then
  raise exception using errcode='42501',message='RATINGS_FIXTURE_ACCESS_DENIED';
 end if;
 perform app_security.rating_lock();
 select * into t from public.rating_trades where id=p_trade_id;
 if not exists(select 1 from app_security.rating_acceptance_fixtures
 where trade_id=p_trade_id and expires_at>pg_catalog.clock_timestamp())
 or t.seller_id is null or t.buyer_id is null or t.seller_id=t.buyer_id
 or t.listing_id is not null or t.conversation_id is not null
 or (select count(*) from auth.users where id in (t.seller_id,t.buyer_id)
 and email like '%@ratings-test.invalid')<>2
 or exists(select 1 from public.staff_roles where user_id in (t.seller_id,t.buyer_id))
 or exists(select 1 from public.rating_trades x where x.id<>p_trade_id
 and (x.seller_id in (t.seller_id,t.buyer_id) or x.buyer_id in (t.seller_id,t.buyer_id))) then
  raise exception using errcode='42501',message='RATINGS_FIXTURE_ACCESS_DENIED';
 end if;
end $$;

create function app_security.rating_notify_scoped(p_trade_id uuid,p_fixture boolean default false) returns void language plpgsql security definer set search_path='' as $$
declare t public.rating_trades; a record; v_kind text; v_inserted integer; v_notification uuid;
begin
 if p_fixture then perform app_security.ratings_assert_fixture(p_trade_id);
 elsif not exists(select 1 from app_security.ratings_settings where enabled and jobs_enabled) then return; end if;
 perform app_security.rating_lock();
 select * into t from public.rating_trades where id=p_trade_id;
 if t.state not in ('pending_buyer','confirmed') or t.voided or t.deadline<=pg_catalog.clock_timestamp() then return; end if;
 for a in select * from app_security.rating_pending where id=t.id and action<>'select_buyer' loop
  if app_security.get_account_status(a.user_id) is distinct from 'active' then continue; end if;
  -- Initial action and reminder have separate, durable idempotency keys.
  v_kind:=case when a.user_id=t.buyer_id then 'buyer_selected_confirm_rate' else 'seller_pending_rating' end;
  insert into app_security.rating_notification_receipts(trade_id,user_id,kind) values(t.id,a.user_id,v_kind) on conflict do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
   v_notification:=app_security.create_notification(a.user_id,'support_reply','Trade rating action',
    case when a.user_id=t.buyer_id then 'You were selected as the buyer. Confirm this purchase to rate the seller, or tell us you did not buy it.' else 'You can rate the buyer for this sold listing.' end,
    '/account/ratings');
   if v_notification is null then raise exception 'RATINGS_NOTIFICATION_NOT_PERSISTED'; end if;
   update app_security.rating_notification_receipts set notification_id=v_notification,delivery_version=1 where trade_id=t.id and user_id=a.user_id and kind=v_kind;
  end if;
  v_kind:=case when pg_catalog.clock_timestamp()>=t.sold_at+interval '10 days' then 'day10'
               when pg_catalog.clock_timestamp()>=t.sold_at+interval '3 days' then 'day3' end;
  if v_kind is not null then
   insert into app_security.rating_notification_receipts(trade_id,user_id,kind) values(t.id,a.user_id,v_kind) on conflict do nothing;
   get diagnostics v_inserted=row_count;
   if v_inserted=1 then
    v_notification:=app_security.create_notification(a.user_id,'support_reply','Trade rating reminder','A trade rating action is waiting. The review window closes 14 days after the listing was sold.','/account/ratings');
   if v_notification is null then raise exception 'RATINGS_NOTIFICATION_NOT_PERSISTED'; end if;
   update app_security.rating_notification_receipts set notification_id=v_notification,delivery_version=1 where trade_id=t.id and user_id=a.user_id and kind=v_kind;
   end if;
  end if;
 end loop;
end $$;


create function app_security.publish_due_reviews_scoped(p_trade_id uuid default null) returns integer language plpgsql volatile security definer set search_path='' as $$
declare t public.rating_trades; n integer:=0;
begin
 if p_trade_id is not null then perform app_security.ratings_assert_fixture(p_trade_id);
 elsif not exists(select 1 from app_security.ratings_settings where enabled and jobs_enabled) then return 0; end if;
 perform app_security.rating_lock();
 for t in select * from public.rating_trades where (p_trade_id is null or id=p_trade_id) and deadline<=pg_catalog.clock_timestamp() and closed_at is null order by deadline,id limit 200 loop
  perform app_security.rating_publish(t.id);
  update public.rating_trades set closed_at=pg_catalog.clock_timestamp(),
   state=case when state in ('pending_selection','pending_buyer') then 'expired_unconfirmed' else state end where id=t.id;
  insert into public.trade_system_events(trade_id,kind) values(t.id,'expired') on conflict do nothing;
  perform app_security.rating_recompute(array[t.seller_id,t.buyer_id]);
  n:=n+1;
 end loop;
 return n;
end $$;



create or replace function app_security.rating_notify(p_trade_id uuid) returns void
language sql security definer set search_path='' as $$select app_security.rating_notify_scoped(p_trade_id,false)$$;
create or replace function app_security.publish_due_reviews() returns integer
language sql volatile security definer set search_path='' as $$select app_security.publish_due_reviews_scoped(null)$$;

-- Notification outages cannot undo mark-sold/confirmation. The reminder scan
-- retries the complete atomic receipt + notification transaction on its next pass.
create or replace function app_security.rating_notify_trigger() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 begin perform app_security.rating_notify(new.id);
 exception when others then null; end;
 return new;
end $$;

create function app_security.impl_ratings_process_fixture(p_trade_id uuid) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform app_security.ratings_assert_fixture(p_trade_id);
 perform app_security.rating_notify_scoped(p_trade_id,true);
 n:=app_security.publish_due_reviews_scoped(p_trade_id);
 return n;
end $$;
create function public.ratings_process_fixture(trade_id uuid) returns integer
language sql security invoker set search_path='' as $$select app_security.impl_ratings_process_fixture(trade_id)$$;

-- Aggregate-only diagnostics; no participant IDs, evidence, cron commands,
-- provider errors, or job return_message may cross this boundary.
create function app_security.ratings_operational_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare codes text[]:='{}'; j record; latest record; v_now timestamptz:=pg_catalog.clock_timestamp();
 s app_security.ratings_settings;
begin
 select * into s from app_security.ratings_settings;
 for j in select e.name,e.schedule,e.command,e.minutes,c.jobid,c.active,c.schedule actual_schedule,c.command actual_command
 from (values ('ratings-v1-publication','*/5 * * * *','select app_security.publish_due_reviews()',10),
 ('ratings-v1-reminders','17 * * * *','select app_security.rating_reminders()',75)) e(name,schedule,command,minutes)
 left join cron.job c on c.jobname=e.name loop
  if j.jobid is null or j.actual_schedule is distinct from j.schedule or j.actual_command is distinct from j.command
   or j.active is distinct from (s.enabled and s.jobs_enabled) then codes:=pg_catalog.array_append(codes,'schedule_drift'); end if;
  if s.enabled and s.jobs_enabled then
   select * into latest from cron.job_run_details where jobid=j.jobid and status in ('succeeded','failed') order by start_time desc,runid desc limit 1;
   if latest.status='failed' then codes:=pg_catalog.array_append(codes,'cron_failed'); end if;
   if exists(select 1 from cron.job_run_details where jobid=j.jobid and end_time is null
    and start_time<v_now-pg_catalog.make_interval(mins=>j.minutes)) then codes:=pg_catalog.array_append(codes,'cron_stalled'); end if;
   if not exists(select 1 from cron.job_run_details where jobid=j.jobid and status='succeeded'
    and end_time>=v_now-pg_catalog.make_interval(mins=>j.minutes)) then codes:=pg_catalog.array_append(codes,
    case when j.minutes=10 then 'publication_missing' else 'reminder_missing' end); end if;
  end if;
 end loop;
 if exists(select 1 from public.rating_trades where closed_at is null and deadline<v_now-interval '10 minutes') then
  codes:=pg_catalog.array_append(codes,'publication_backlog'); end if;
 if exists(select 1 from public.profile_rating_stats where score<0 or score>10
  or counted_review_count<0 or published_review_count<counted_review_count or completed_trades<0
  or (counted_review_count<s.min_reviews and (score is not null or communication_average is not null or payment_item_average is not null or meetup_average is not null))
  or (counted_review_count>=s.min_reviews and (score is null or communication_average is null or payment_item_average is null or meetup_average is null))
  or communication_average not between 1 and 4 or payment_item_average not between 1 and 4 or meetup_average not between 1 and 4) then
  codes:=pg_catalog.array_append(codes,'invalid_reputation'); end if;
 if exists(select 1 from app_security.rating_notification_receipts group by trade_id,user_id,kind having count(*)>1)
  or exists(select 1 from app_security.rating_notification_receipts where notification_id is not null group by notification_id having count(*)>1) then
  codes:=pg_catalog.array_append(codes,'duplicate_notifications'); end if;
 if exists(select 1 from app_security.rating_notification_receipts where delivery_version=1 and notification_id is null) then
  codes:=pg_catalog.array_append(codes,'notification_missing'); end if;
 if exists(select 1 from app_security.rating_pending p where p.action<>'select_buyer'
  and app_security.get_account_status(p.user_id)='active' and not exists(select 1 from app_security.rating_notification_receipts r
   where r.trade_id=p.id and r.user_id=p.user_id and r.kind in ('buyer_selected_confirm_rate','seller_pending_rating'))
  and p.sold_at<v_now-interval '75 minutes') then codes:=pg_catalog.array_append(codes,'notification_missing'); end if;
 if exists(select 1 from app_security.rating_cases where resolved_at is null and created_at<v_now-interval '24 hours') then
  codes:=pg_catalog.array_append(codes,'moderation_unresolved'); end if;
 return pg_catalog.jsonb_build_object('codes',(select coalesce(pg_catalog.jsonb_agg(c order by c),'[]'::jsonb) from (select distinct unnest(codes) c) x));
end $$;

create table app_security.rating_operations_alerts (
 code text primary key, active boolean not null default true,
 lease_token uuid, lease_until timestamptz, delivered_at timestamptz
);
alter table app_security.rating_operations_alerts enable row level security;
alter table app_security.rating_operations_alerts force row level security;
revoke all on app_security.rating_operations_alerts from public,anon,authenticated,service_role;

create function app_security.impl_ratings_operations_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare health jsonb; c text; token uuid; claims jsonb:='[]';
begin
 perform pg_catalog.pg_advisory_xact_lock(28104504);
 health:=app_security.ratings_operational_health();
 update app_security.rating_operations_alerts set active=false,delivered_at=null,lease_token=null,lease_until=null
 where not (health->'codes' ? code);
 for c in select jsonb_array_elements_text(health->'codes') loop
  insert into app_security.rating_operations_alerts(code) values(c) on conflict do nothing;
  token:=gen_random_uuid();
  update app_security.rating_operations_alerts set active=true,lease_token=token,lease_until=pg_catalog.clock_timestamp()+interval '2 minutes'
  where code=c and (lease_until is null or lease_until<=pg_catalog.clock_timestamp())
   and (delivered_at is null or delivered_at<=pg_catalog.clock_timestamp()-interval '1 hour');
  if found then claims:=claims||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('code',c,'token',token)); end if;
 end loop;
 return claims;
end $$;
create function app_security.impl_ratings_operations_ack(p_code text,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update app_security.rating_operations_alerts set delivered_at=pg_catalog.clock_timestamp(),lease_until=null,lease_token=null
 where code=p_code and lease_token=p_token and lease_until>pg_catalog.clock_timestamp() and active;
 return found;
end $$;
create function public.ratings_operations_claim() returns jsonb
language sql security invoker set search_path='' as $$select app_security.impl_ratings_operations_claim()$$;
create function public.ratings_operations_ack(code text,token uuid) returns boolean
language sql security invoker set search_path='' as $$select app_security.impl_ratings_operations_ack(code,token)$$;

revoke all on function app_security.ratings_assert_fixture(uuid),app_security.rating_notify_scoped(uuid,boolean),
 app_security.publish_due_reviews_scoped(uuid),app_security.ratings_operational_health(),
 app_security.impl_ratings_process_fixture(uuid),public.ratings_process_fixture(uuid),
 app_security.impl_ratings_operations_claim(),app_security.impl_ratings_operations_ack(text,uuid),
 public.ratings_operations_claim(),public.ratings_operations_ack(text,uuid)
 from public,anon,authenticated,service_role;
grant execute on function app_security.impl_ratings_process_fixture(uuid),public.ratings_process_fixture(uuid),
 app_security.impl_ratings_operations_claim(),app_security.impl_ratings_operations_ack(text,uuid),
 public.ratings_operations_claim(),public.ratings_operations_ack(text,uuid) to service_role;
commit;
