-- Five unresolved styles belong only to unresolvedStyles, never explicit navigation mappings.
-- No saved context exists before initial category activation; no listing version upgrade.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
do $$ begin
  if exists(select 1 from public.listing_vehicle_contexts) then raise exception 'Initial unopened contract correction requires zero saved vehicle contexts'; end if;
  if exists(select 1 from public.categories where slug like 'tw-%' and (is_active or new_listing_enabled)) then raise exception 'Initial contract must still be closed'; end if;
end $$;
update public.vehicle_contract_versions v set definition=jsonb_set(definition,'{mappings}',(
  select jsonb_agg(m order by ord) from jsonb_array_elements(v.definition->'mappings') with ordinality t(m,ord) where m->>'leaf' is not null
)) where contract_key='two-wheeler-draft-v1';
do $$ begin
  if (select jsonb_array_length(definition->'mappings') from public.vehicle_contract_versions where contract_key='two-wheeler-draft-v1')<>14 then raise exception 'Exactly 14 explicit mappings required'; end if;
end $$;
commit;
