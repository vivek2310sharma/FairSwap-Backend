begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_security.rating_notify(p_trade_id uuid) returns void language plpgsql security definer set search_path='' as $$
declare t public.rating_trades; a record; v_kind text; v_inserted integer;
begin
 if not exists(select 1 from app_security.ratings_settings where enabled and jobs_enabled) then return; end if;
 select * into t from public.rating_trades where id=p_trade_id;
 if t.state not in ('pending_buyer','confirmed') or t.voided or t.deadline<=pg_catalog.clock_timestamp() then return; end if;
 for a in select * from app_security.rating_pending where id=t.id and action<>'select_buyer' loop
  if app_security.get_account_status(a.user_id) is distinct from 'active' then continue; end if;
  -- Initial action and reminder have separate, durable idempotency keys.
  v_kind:=case when a.user_id=t.buyer_id then 'buyer_selected_confirm_rate' else 'seller_pending_rating' end;
  insert into app_security.rating_notification_receipts values(t.id,a.user_id,v_kind) on conflict do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
   perform app_security.create_notification(a.user_id,'support_reply','Trade rating action',
    case when a.user_id=t.buyer_id then 'You were selected as the buyer. Confirm this purchase to rate the seller, or tell us you did not buy it.' else 'You can rate the buyer for this sold listing.' end,
    '/account/ratings');
  end if;
  v_kind:=case when pg_catalog.clock_timestamp()>=t.sold_at+interval '10 days' then 'day10'
               when pg_catalog.clock_timestamp()>=t.sold_at+interval '3 days' then 'day3' end;
  if v_kind is not null then
   insert into app_security.rating_notification_receipts values(t.id,a.user_id,v_kind) on conflict do nothing;
   get diagnostics v_inserted=row_count;
   if v_inserted=1 then
    perform app_security.create_notification(a.user_id,'support_reply','Trade rating reminder','A trade rating action is waiting. The review window closes 14 days after the listing was sold.','/account/ratings');
   end if;
  end if;
 end loop;
end $$;

create function app_security.rating_notify_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin perform app_security.rating_notify(new.id); return new; end $$;
create trigger ratings_notify after insert or update of state on public.rating_trades for each row execute function app_security.rating_notify_trigger();

create function app_security.publish_due_reviews() returns integer language plpgsql volatile security definer set search_path='' as $$
declare t public.rating_trades; n integer:=0;
begin
 if not exists(select 1 from app_security.ratings_settings where enabled and jobs_enabled) then return 0; end if;
 perform app_security.rating_lock();
 for t in select * from public.rating_trades where deadline<=pg_catalog.clock_timestamp() and closed_at is null order by deadline,id limit 200 loop
  perform app_security.rating_publish(t.id);
  update public.rating_trades set closed_at=pg_catalog.clock_timestamp(),
   state=case when state in ('pending_selection','pending_buyer') then 'expired_unconfirmed' else state end where id=t.id;
  insert into public.trade_system_events(trade_id,kind) values(t.id,'expired') on conflict do nothing;
  perform app_security.rating_recompute(array[t.seller_id,t.buyer_id]);
  n:=n+1;
 end loop;
 return n;
end $$;

-- Round-robin cursor avoids starving older outstanding actions in busy installations.
create table app_security.rating_reminder_cursor(singleton boolean primary key default true check(singleton),last_sold_at timestamptz,last_id uuid);
insert into app_security.rating_reminder_cursor default values;
alter table app_security.rating_reminder_cursor enable row level security;
revoke all on app_security.rating_reminder_cursor from public,anon,authenticated,service_role;
create function app_security.rating_reminders() returns integer language plpgsql volatile security definer set search_path='' as $$
declare t record; c record; n integer:=0;
begin
 if not exists(select 1 from app_security.ratings_settings where enabled and jobs_enabled) then return 0; end if;
 perform app_security.rating_lock();
 select * into c from app_security.rating_reminder_cursor;
 for t in select id,sold_at from public.rating_trades where state in ('pending_buyer','confirmed') and not voided and deadline>pg_catalog.clock_timestamp()
 and (c.last_id is null or (sold_at,id)>(c.last_sold_at,c.last_id)) order by sold_at,id limit 200 loop
  perform app_security.rating_notify(t.id); n:=n+1;
  update app_security.rating_reminder_cursor set last_sold_at=t.sold_at,last_id=t.id;
 end loop;
 if n<200 then update app_security.rating_reminder_cursor set last_sold_at=null,last_id=null; end if;
 return n;
end $$;

-- Explicit owner-only provisioning. No jobs are created/activated by migrations.
create function app_security.ratings_provision_inactive_jobs() returns void language plpgsql volatile security definer set search_path='' as $$
declare j bigint;
begin
 if exists(select 1 from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled) then
  raise exception 'RATINGS_FLAGS_MUST_BE_OFF';
 end if;
 j:=cron.schedule('ratings-v1-publication','*/5 * * * *','select app_security.publish_due_reviews()');
 perform cron.alter_job(j,active:=false);
 j:=cron.schedule('ratings-v1-reminders','17 * * * *','select app_security.rating_reminders()');
 perform cron.alter_job(j,active:=false);
end $$;
revoke all on function app_security.rating_notify(uuid),app_security.rating_notify_trigger(),app_security.publish_due_reviews(),app_security.rating_reminders(),app_security.ratings_provision_inactive_jobs() from public,anon,authenticated,service_role;
commit;
