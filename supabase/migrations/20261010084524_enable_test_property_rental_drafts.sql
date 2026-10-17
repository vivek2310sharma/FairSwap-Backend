begin;set local lock_timeout='5s';set local statement_timeout='30s';
do $$begin
 if (select count(*) from public.property_category_contracts p join public.property_contract_versions v on v.id=p.version_id where v.contract_key='property-rental-draft-v1')<>10 or to_regprocedure('public.save_property_draft(uuid,jsonb,uuid,jsonb,text)') is null or (select count(*) from pg_trigger where tgname in ('property_context_guard','zzz_property_listing_guard','property_listing_context_complete','property_context_listing_complete') and tgenabled='O')<>4 then raise exception 'Property activation prerequisites incomplete'; end if;
end $$;
update public.property_contract_versions set new_assignment_enabled=true where contract_key='property-rental-draft-v1';
update public.categories c set is_active=true,new_listing_enabled=true from public.property_category_contracts p join public.property_contract_versions v on v.id=p.version_id where c.id=p.category_id and v.contract_key='property-rental-draft-v1';
commit;
