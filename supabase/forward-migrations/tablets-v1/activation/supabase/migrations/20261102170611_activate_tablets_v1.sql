-- Apply only after foundation and matching Web candidate; no generic listing writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$begin
 if to_regprocedure('public.submit_tablet_v1(jsonb)') is null or (select count(*) from public.tablet_models_v1)<17 or not exists(select 1 from public.posting_category_definitions where category_key='mobiles' and subcategory_key='mobile-phones' and version=2 and enabled) then raise exception 'Tablet release prerequisites missing';end if;
end $$;
update public.categories set is_active=true where id=(select category_id from public.tablet_release_v1);
update public.tablet_release_v1 set enabled=true;
commit;
