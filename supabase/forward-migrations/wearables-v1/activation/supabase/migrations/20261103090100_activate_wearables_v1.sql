-- Activate only after matching Web (POST_AD_WEARABLES_V1_ENABLED) and automated Test verification; no generic writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$begin
 if (select rows_approved from public.wearable_catalogue_revision_v1)<>(select count(*) from public.wearable_models_v1 where status='approved')
  or to_regprocedure('public.submit_wearable_v1(jsonb)') is null or to_regprocedure('public.wearable_v1_session(uuid,text,uuid)') is null
  or to_regprocedure('app_security.impl_posting_session_core_v1(uuid,text,uuid,uuid)') is null
  or not exists(select 1 from pg_catalog.pg_trigger where tgname='zz_wearable_listing_guard_v1' and tgrelid='public.listings'::regclass) then raise exception 'WEARABLES_ACTIVATION_PREREQUISITE_MISSING';end if;
end $$;
update public.categories set is_active=true where id=(select category_id from public.wearable_release_v1);
update public.wearable_release_v1 set enabled=true;
commit;
