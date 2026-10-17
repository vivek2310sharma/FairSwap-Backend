-- FairSwapTest only, CLI --project-ref wpppxlnbzqynvhpeuavd.
-- Opens exactly nine draft assignments after installed guards/pure contract tests.
-- Does not enable review or publication; z_vehicle_listing_guard rejects both.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
do $$ declare v uuid; n integer; begin
  select id into strict v from public.vehicle_contract_versions where contract_key='two-wheeler-draft-v1' and not new_assignment_enabled and jsonb_array_length(definition->'mappings')=14;
  if (select count(*) from public.vehicle_category_contracts where version_id=v)<>9 or (select count(*) from public.vehicle_catalogue_rows r join public.vehicle_contract_versions c on c.snapshot_id=r.snapshot_id where c.id=v)<>830 then raise exception 'Source import prerequisite differs'; end if;
  if (select count(*) from public.vehicle_registration_states)<>36 then raise exception 'State reference prerequisite differs'; end if;
  if to_regprocedure('public.save_two_wheeler_draft(uuid,jsonb,uuid,jsonb)') is null or to_regprocedure('public.lookup_two_wheeler_catalogue(uuid,uuid,uuid,text,integer,integer,text,uuid)') is null then raise exception 'Draft/lookup path missing'; end if;
  if not exists(select 1 from pg_trigger where tgrelid='public.listings'::regclass and tgname='z_vehicle_listing_guard' and tgenabled='O') or not exists(select 1 from pg_trigger where tgrelid='public.listings'::regclass and tgname='vehicle_listing_context_complete' and tgdeferrable and tginitdeferred and tgenabled='O') then raise exception 'Authoritative guards missing'; end if;
  update public.categories c set is_active=true,new_listing_enabled=true from public.vehicle_category_contracts p where p.version_id=v and p.category_id=c.id and c.macro_category='vehicles' and not c.is_active and not c.new_listing_enabled;
  get diagnostics n=row_count; if n<>9 then raise exception 'Exactly nine unopened Test categories expected'; end if;
  update public.vehicle_contract_versions set new_assignment_enabled=true where id=v;
end $$;
commit;
