-- Activate only after matching Web and automated Test verification; no generic writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$begin
 if (select count(*) from public.accessory_types_v1)<>21 or to_regprocedure('public.submit_accessory_v1(jsonb)') is null then raise exception 'Accessories prerequisites missing';end if;
end $$;
update public.categories set is_active=true where id=(select category_id from public.accessory_release_v1);
update public.accessory_release_v1 set enabled=true;
commit;
