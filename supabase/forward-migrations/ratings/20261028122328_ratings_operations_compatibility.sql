begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Additive compatibility hardening; all existing migrations and gates are preserved.
-- Existing private tables retain RLS/ACLs. No new table, policy, grant or job is added.
create or replace function app_security.rating_notify_scoped(p_trade_id uuid,p_fixture boolean default false) returns void language plpgsql security definer set search_path='' as $$
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
   if v_notification is null or not exists(select 1 from public.notifications
    where id=v_notification and user_id=a.user_id and link='/account/ratings') then
    raise exception 'RATINGS_NOTIFICATION_NOT_PERSISTED'; end if;
   update app_security.rating_notification_receipts set notification_id=v_notification,delivery_version=1 where trade_id=t.id and user_id=a.user_id and kind=v_kind;
  end if;
  v_kind:=case when pg_catalog.clock_timestamp()>=t.sold_at+interval '10 days' then 'day10'
               when pg_catalog.clock_timestamp()>=t.sold_at+interval '3 days' then 'day3' end;
  if v_kind is not null then
   insert into app_security.rating_notification_receipts(trade_id,user_id,kind) values(t.id,a.user_id,v_kind) on conflict do nothing;
   get diagnostics v_inserted=row_count;
   if v_inserted=1 then
    v_notification:=app_security.create_notification(a.user_id,'support_reply','Trade rating reminder','A trade rating action is waiting. The review window closes 14 days after the listing was sold.','/account/ratings');
   if v_notification is null or not exists(select 1 from public.notifications
    where id=v_notification and user_id=a.user_id and link='/account/ratings') then
    raise exception 'RATINGS_NOTIFICATION_NOT_PERSISTED'; end if;
   update app_security.rating_notification_receipts set notification_id=v_notification,delivery_version=1 where trade_id=t.id and user_id=a.user_id and kind=v_kind;
   end if;
  end if;
 end loop;
end $$;
create or replace function app_security.ratings_operational_health() returns jsonb
language plpgsql security definer set search_path='' as $$
declare codes text[]:='{}'; j record; latest record; v_now timestamptz:=pg_catalog.clock_timestamp();
 s app_security.ratings_settings;
begin
 select * into s from app_security.ratings_settings;
 if s.min_reviews is distinct from 3 then codes:=pg_catalog.array_append(codes,'invalid_reputation'); end if;
 if pg_catalog.current_setting('cron.log_run',true)='off' then codes:=pg_catalog.array_append(codes,'schedule_drift'); end if;
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
 if exists(select 1 from app_security.rating_notification_receipts r left join public.notifications n on n.id=r.notification_id
 where r.delivery_version=1 and (n.id is null or n.user_id is distinct from r.user_id or n.link is distinct from '/account/ratings')) then
  codes:=pg_catalog.array_append(codes,'notification_missing'); end if;
 if exists(select 1 from app_security.rating_pending p where p.action<>'select_buyer'
  and app_security.get_account_status(p.user_id)='active' and not exists(select 1 from app_security.rating_notification_receipts r
   where r.trade_id=p.id and r.user_id=p.user_id and r.kind in ('buyer_selected_confirm_rate','seller_pending_rating'))
  and p.sold_at<v_now-interval '75 minutes') then codes:=pg_catalog.array_append(codes,'notification_missing'); end if;
 if exists(select 1 from app_security.rating_cases where resolved_at is null and created_at<v_now-interval '24 hours') then
  codes:=pg_catalog.array_append(codes,'moderation_unresolved'); end if;
 return pg_catalog.jsonb_build_object('codes',(select coalesce(pg_catalog.jsonb_agg(c order by c),'[]'::jsonb) from (select distinct unnest(codes) c) x));
end $$;
revoke all on function app_security.rating_notify_scoped(uuid,boolean),app_security.ratings_operational_health()
 from public,anon,authenticated,service_role;
commit;
