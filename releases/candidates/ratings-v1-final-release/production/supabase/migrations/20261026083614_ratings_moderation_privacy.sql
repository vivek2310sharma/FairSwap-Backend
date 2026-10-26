begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function app_security.impl_ratings_report(p_review_id uuid,p_reason text) returns uuid language plpgsql volatile security definer set search_path='' as $$
declare u uuid; r public.rating_reviews; v_id uuid; v_ticket uuid; v_reason text;
begin
 u:=app_security.rating_actor(); perform app_security.rating_lock(); v_reason:=app_security.rating_text(p_reason);
 if v_reason is null or length(v_reason)<3 then raise exception 'RATINGS_REASON_REQUIRED' using errcode='22023'; end if;
 select * into r from public.rating_reviews where id=p_review_id;
 if not found or r.author_id=u or app_security.rating_review_json(r.id,false) is null then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 select id into v_id from app_security.rating_cases where review_id=r.id and reporter_id=u and kind='review_report';
 if found then return v_id; end if;
 if (select count(*) from app_security.rating_cases where reporter_id=u and created_at>pg_catalog.clock_timestamp()-interval '1 day')>=10 then
  raise exception 'RATINGS_REPORT_LIMIT' using errcode='54000';
 end if;
 insert into public.support_tickets(user_id,category,subject,priority) values(u,'safety','Reported Ratings review','normal') returning id into v_ticket;
 insert into app_security.rating_cases(trade_id,review_id,reporter_id,support_ticket_id,kind,reason) values(r.trade_id,r.id,u,v_ticket,'review_report',v_reason) returning id into v_id;
 return v_id;
end $$;

create function app_security.impl_admin_ratings_case(p_case_id uuid,p_action text,p_reason text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c app_security.rating_cases; t public.rating_trades; v_reason text;
begin
 if auth.uid() is null or not app_security.is_active_staff_aal2('moderator') then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 if not (select staff_enabled from app_security.ratings_settings) then raise exception 'RATINGS_STAFF_DISABLED' using errcode='55000'; end if;
 v_reason:=app_security.rating_text(p_reason);
 if v_reason is null or length(v_reason)<3 then raise exception 'RATINGS_REASON_REQUIRED' using errcode='22023'; end if;
 if p_action is null or p_action not in ('evidence','hide','restore','resolve','void','exclude','clear_exclusion') then raise exception 'RATINGS_INVALID_ACTION' using errcode='22023'; end if;
 perform app_security.rating_lock();
 select * into c from app_security.rating_cases where id=p_case_id for update;
 if not found then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 select * into t from public.rating_trades where id=c.trade_id for update;
 if auth.uid() in (t.buyer_id,t.seller_id,c.reporter_id) then raise exception 'RATINGS_STAFF_CONFLICT' using errcode='42501'; end if;
 if p_action in ('hide','restore') then
  if c.review_id is null then raise exception 'RATINGS_CASE_MISMATCH' using errcode='22023'; end if;
  update public.rating_reviews set hidden=(p_action='hide') where id=c.review_id;
 elsif p_action='resolve' then
  if c.kind<>'dispute' or t.state<>'disputed' or t.voided then raise exception 'RATINGS_CASE_MISMATCH' using errcode='22023'; end if;
  update public.rating_trades set state=case when buyer_confirmed_at is not null then 'confirmed' when deadline>pg_catalog.clock_timestamp() then 'pending_buyer' else 'expired_unconfirmed' end where id=t.id;
  update app_security.rating_cases set resolved_at=pg_catalog.clock_timestamp() where id=c.id;
  perform app_security.rating_publish(t.id);
 elsif p_action='void' then
  update public.rating_trades set voided=true where id=t.id;
  update app_security.rating_cases set resolved_at=pg_catalog.clock_timestamp() where id=c.id;
 elsif p_action in ('exclude','clear_exclusion') then
  update public.rating_trades set risk_excluded=(p_action='exclude') where id=t.id;
 end if;
 insert into app_security.rating_moderation_audit(case_id,actor_id,action,reason) values(c.id,auth.uid(),p_action,v_reason);
 if p_action<>'evidence' then perform app_security.rating_recompute(array[t.seller_id,t.buyer_id]); return jsonb_build_object('case_id',c.id,'action',p_action); end if;
 -- This is the sole evidence boundary. No unscoped search or direct table grants.
 return jsonb_build_object('case',to_jsonb(c),'trade',to_jsonb(t),
  'reviews',coalesce((select jsonb_agg(to_jsonb(r)) from public.rating_reviews r where r.trade_id=t.id),'[]'::jsonb),
  'replies',coalesce((select jsonb_agg(to_jsonb(q)) from public.rating_replies q join public.rating_reviews r on r.id=q.review_id where r.trade_id=t.id),'[]'::jsonb));
end $$;

create function public.ratings_report(review_id uuid,reason text) returns uuid language sql volatile security invoker set search_path='' as $$select app_security.impl_ratings_report(review_id,reason)$$;
create function public.admin_ratings_case(case_id uuid,action text,reason text) returns jsonb language sql volatile security invoker set search_path='' as $$select app_security.impl_admin_ratings_case(case_id,action,reason)$$;
create function app_security.impl_admin_ratings_ticket(p_ticket_id uuid,p_action text,p_reason text) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare c uuid;
begin
 if auth.uid() is null or not app_security.is_active_staff_aal2('moderator') then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 select id into c from app_security.rating_cases where support_ticket_id=p_ticket_id;
 if c is null then raise exception 'RATINGS_ACCESS_DENIED' using errcode='42501'; end if;
 return app_security.impl_admin_ratings_case(c,p_action,p_reason);
end $$;
create function public.admin_ratings_ticket(ticket_id uuid,action text,reason text) returns jsonb language sql volatile security invoker set search_path='' as $$select app_security.impl_admin_ratings_ticket(ticket_id,action,reason)$$;
revoke all on function app_security.impl_admin_ratings_ticket(uuid,text,text),public.admin_ratings_ticket(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_admin_ratings_ticket(uuid,text,text),public.admin_ratings_ticket(uuid,text,text) to authenticated;
revoke all on function app_security.impl_ratings_report(uuid,text),app_security.impl_admin_ratings_case(uuid,text,text),public.ratings_report(uuid,text),public.admin_ratings_case(uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_ratings_report(uuid,text),app_security.impl_admin_ratings_case(uuid,text,text),public.ratings_report(uuid,text),public.admin_ratings_case(uuid,text,text) to authenticated;

-- Wrap whichever authorized privacy implementation is installed, preserving its
-- exact authorization/audit semantics and optional onboarding fields.
alter function app_security.impl_fulfill_data_export(uuid) rename to ratings_export_base;
create function app_security.impl_fulfill_data_export(p_request_id uuid) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v jsonb; u uuid;
begin
 v:=app_security.ratings_export_base(p_request_id);
 select user_id into u from public.privacy_requests where id=p_request_id and request_type='export_data';
 return v||jsonb_build_object('ratings',jsonb_build_object(
  'given',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'trade_id',r.trade_id,'reviewer_role',r.reviewer_role,'communication',r.communication,'payment_item',r.payment_item,'meetup',r.meetup,'score',r.score,'body',r.body,'tags',r.tags,'submitted_at',r.submitted_at,'published_at',r.published_at)) from public.rating_reviews r where r.author_id=u),'[]'::jsonb),
  'received',coalesce((select jsonb_agg(app_security.rating_review_json(r.id,false)) from public.rating_reviews r where r.recipient_id=u and app_security.rating_review_json(r.id,false) is not null),'[]'::jsonb),
  'replies',coalesce((select jsonb_agg(jsonb_build_object('review_id',q.review_id,'body',q.body,'created_at',q.created_at)) from public.rating_replies q where q.author_id=u),'[]'::jsonb),
  'trades',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'listing_id',t.listing_id,'state',t.state,'sold_at',t.sold_at,'deadline',t.deadline,'buyer_confirmed_at',t.buyer_confirmed_at)) from public.rating_trades t where u in (t.seller_id,t.buyer_id)),'[]'::jsonb)));
end $$;
revoke all on function app_security.impl_fulfill_data_export(uuid) from public,anon,authenticated,service_role;
-- Preserve installed export ACLs (including restricted environments) rather than
-- broadening privileges. Public wrapper ACLs are never changed.
do $$ begin
 if pg_catalog.has_function_privilege('authenticated','app_security.ratings_export_base(uuid)','EXECUTE') then
  grant execute on function app_security.impl_fulfill_data_export(uuid) to authenticated;
 end if;
 if pg_catalog.has_function_privilege('service_role','app_security.ratings_export_base(uuid)','EXECUTE') then
  grant execute on function app_security.impl_fulfill_data_export(uuid) to service_role;
 end if;
end $$;
revoke all on function app_security.ratings_export_base(uuid) from public,anon,authenticated,service_role;

create function app_security.rating_erase(p_user uuid) returns void language plpgsql security definer set search_path='' as $$
declare affected uuid[];
begin
 perform app_security.rating_lock();
 select array_agg(distinct x.u) into affected from public.rating_trades t cross join lateral (values(t.seller_id),(t.buyer_id)) x(u) where p_user in (t.seller_id,t.buyer_id);
 -- Free text is erased, numeric history remains private and void. Compliance
 -- case/audit rows follow the existing retained evidence model, without new copies.
 update public.rating_replies q set body='[redacted]',author_id=null where q.author_id=p_user or exists(select 1 from public.rating_reviews r where r.id=q.review_id and p_user in (r.author_id,r.recipient_id));
 update public.rating_reviews set body=null,tags='{}',redacted=true,author_id=case when author_id=p_user then null else author_id end,recipient_id=case when recipient_id=p_user then null else recipient_id end where p_user in (author_id,recipient_id);
 update public.rating_trades set voided=true,seller_id=case when seller_id=p_user then null else seller_id end,buyer_id=case when buyer_id=p_user then null else buyer_id end where p_user in (seller_id,buyer_id);
 update app_security.rating_cases set reason='[redacted]',reporter_id=null where reporter_id=p_user;
 delete from app_security.rating_notification_receipts where user_id=p_user;
 perform app_security.rating_recompute(affected);
end $$;
create function app_security.rating_deletion_trigger() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' then perform app_security.rating_erase(old.id); return old; end if;
 if new.account_status in ('deletion_pending','deleted') and old.account_status is distinct from new.account_status then perform app_security.rating_erase(new.user_id); end if;
 return new;
end $$;
create trigger ratings_account_erasure after update of account_status on public.user_accounts for each row execute function app_security.rating_deletion_trigger();
create trigger ratings_auth_erasure before delete on auth.users for each row execute function app_security.rating_deletion_trigger();
revoke all on function app_security.rating_erase(uuid),app_security.rating_deletion_trigger() from public,anon,authenticated,service_role;
commit;
