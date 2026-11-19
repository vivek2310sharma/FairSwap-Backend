begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- Extend the contract only for these two fixed, draft-only specialist flows.
alter table app_security.ordinary_goods_contracts_v3
  drop constraint ordinary_goods_contracts_v3_check,
  drop constraint ordinary_goods_contracts_v3_check1,
  drop constraint ordinary_goods_contracts_v3_check2,
  add constraint goods_v3_flow_check check (
    posting_flow in ('generic','accessory')
    or (posting_flow='property' and macro_category='property')
    or (macro_category='vehicles' and draft_only and
      ((slug='v2-cars' and posting_flow='specialist:car') or
       (slug='v2-motorcycles-scooters' and posting_flow='specialist:two_wheeler')))),
  add constraint goods_v3_draft_check check (draft_only = (slug in
    ('v2-commercial-vehicles','v2-electric-cycles-low-speed-evs','v2-cars','v2-motorcycles-scooters'))),
  add constraint goods_v3_macro_check check (macro_category='goods' or
    (macro_category='vehicles' and moderation_mode='staff_intake'
      and (posting_flow='generic' or slug in ('v2-cars','v2-motorcycles-scooters'))
      and slug in ('v2-car-accessories-parts','v2-bicycles','v2-bike-accessories-parts',
        'v2-commercial-vehicles','v2-electric-cycles-low-speed-evs','v2-cars','v2-motorcycles-scooters'))
    or (macro_category='property' and posting_flow='property' and moderation_mode='staff_intake' and slug in
      ('v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms','v2-shops-offices','v2-land-plots','v2-warehouses-godowns')));

insert into app_security.ordinary_goods_contracts_v3
  (slug,parent_slug,category_id,risk,posting_flow,macro_category,moderation_mode,draft_only,fields) values
  ('v2-cars','v2-cars-commercial-vehicles','3792cc10-5347-5c67-ac98-7f488430abd2','general','specialist:car','vehicles','staff_intake',true,'[{"key":"subtype","label":"Supported draft subtype","required":true,"kind":"text","choices":["Hatchback"]},{"key":"brand","label":"Make","required":true,"kind":"text"},{"key":"model","label":"Model","required":true,"kind":"text"},{"key":"registration","label":"Registration status","required":true,"kind":"text","choices":["Registered in India","Unverified"]},{"key":"authority","label":"Transfer authority","required":true,"kind":"text","choices":["Registered owner","Authorised representative","Unverified"]},{"key":"year","label":"Model year","required":true,"kind":"number","min":1900,"max":2099},{"key":"odometer","label":"Odometer (km)","required":true,"kind":"number","min":0,"max":2000000}]'::jsonb),
  ('v2-motorcycles-scooters','v2-bikes-scooters','e31b87f4-08a0-5757-89d7-739f27100021','general','specialist:two_wheeler','vehicles','staff_intake',true,'[{"key":"subtype","label":"Supported draft subtype","required":true,"kind":"text","choices":["Commuter motorcycle"]},{"key":"brand","label":"Make","required":true,"kind":"text"},{"key":"model","label":"Model","required":true,"kind":"text"},{"key":"registration","label":"Registration status","required":true,"kind":"text","choices":["Registered in India","Unverified"]},{"key":"authority","label":"Transfer authority","required":true,"kind":"text","choices":["Registered owner","Authorised representative","Unverified"]},{"key":"year","label":"Model year","required":true,"kind":"number","min":1900,"max":2099},{"key":"odometer","label":"Odometer (km)","required":true,"kind":"number","min":0,"max":2000000}]'::jsonb);

create table app_security.specialist_vehicle_draft_refs_v3 (
  canonical_id uuid not null references app_security.ordinary_goods_contracts_v3(category_id),
  subtype_id uuid not null,
  version_id uuid not null,
  subtype_slug text not null,
  source_path jsonb not null,
  fields jsonb not null,
  primary key (canonical_id,subtype_id,version_id)
);
alter table app_security.specialist_vehicle_draft_refs_v3 enable row level security;
alter table app_security.specialist_vehicle_draft_refs_v3 force row level security;
revoke all on app_security.specialist_vehicle_draft_refs_v3 from public,anon,authenticated,service_role;
insert into app_security.specialist_vehicle_draft_refs_v3 values
  ('3792cc10-5347-5c67-ac98-7f488430abd2','1c888722-9e3a-4001-b8f7-22d5781fa1df','7b71b6fd-0b82-4881-8db4-ccaa847bab8e','car-hatchback','["Vehicles", "Cars", "Hatchback"]','["brand", "model", "variant", "year", "fuel_type", "transmission", "km_driven", "owner_number", "registration_state", "insurance_valid_till", "color", "price", "negotiable"]'),
  ('3792cc10-5347-5c67-ac98-7f488430abd2','acf85172-02f4-41c6-ba0f-4e664dcce4c7','0e97b06a-197a-4007-9453-14fad19902cf','car-hatchback','["Vehicles", "Cars", "Hatchback"]','["brand", "model", "variant", "year", "fuel_type", "transmission", "km_driven", "owner_number", "registration_state", "insurance_valid_till", "color", "price", "negotiable"]'),
  ('e31b87f4-08a0-5757-89d7-739f27100021','94969a67-4d44-4e2a-81e3-0ece8d6de153','0506a02a-b66a-4abe-b168-db58eb87c43d','tw-commuter-bikes','["Vehicles", "Motorcycles", "Commuter Bikes"]','["brand", "model", "variant", "year", "engine_cc", "km_driven", "owner_number", "registration_state", "insurance_valid_till", "color", "price", "negotiable"]'),
  ('e31b87f4-08a0-5757-89d7-739f27100021','597a08f7-7b8c-474a-8585-7597295b418a','1a9af5e9-ad28-4dd6-9ffa-37727b273a03','tw-commuter-bikes','["Vehicles", "Motorcycles", "Commuter Bikes"]','["brand", "model", "variant", "year", "engine_cc", "km_driven", "owner_number", "registration_state", "insurance_valid_till", "color", "price", "negotiable"]');

-- Resolve by authoritative installed identity and contract contents. Never
-- infer environment via client flags, allow zero matches, or pick between
-- ambiguous matches. This does not change legacy write permissions.
create function app_security.specialist_vehicle_draft_binding_v3(p_category uuid)
returns uuid[] language sql stable security definer set search_path='' as $$
  with candidates as (
    select r.subtype_id,r.version_id
    from app_security.specialist_vehicle_draft_refs_v3 r
    join public.categories c on c.id=r.subtype_id and c.slug=r.subtype_slug and c.macro_category='vehicles'
    join public.car_category_contracts p on p.category_id=c.id and p.version_id=r.version_id
      and p.source_path=r.source_path and p.fields=r.fields
    join public.car_contract_versions v on v.id=p.version_id and v.contract_key='cars-draft-v1'
    where r.canonical_id=p_category
    union all
    select r.subtype_id,r.version_id
    from app_security.specialist_vehicle_draft_refs_v3 r
    join public.categories c on c.id=r.subtype_id and c.slug=r.subtype_slug and c.macro_category='vehicles'
    join public.vehicle_category_contracts p on p.category_id=c.id and p.version_id=r.version_id
      and p.source_path=r.source_path and p.fields=r.fields
    join public.vehicle_contract_versions v on v.id=p.version_id and v.contract_key='two-wheeler-draft-v1'
    where r.canonical_id=p_category
  )
  select array[c.subtype_id,c.version_id] from candidates c where (select count(*) from candidates)=1;
$$;
revoke all on function app_security.specialist_vehicle_draft_binding_v3(uuid) from public,anon,authenticated,service_role;

do $$
begin
  if (select count(*) from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug and c.posting_flow=g.posting_flow
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.slug in ('v2-cars','v2-motorcycles-scooters') and c.macro_category=g.macro_category
      and c.status='coming_soon' and not c.is_active and not c.new_listing_enabled
      and not exists (select 1 from public.listings l where l.category_id=c.id)) <> 2
  then raise exception 'SPECIALIST_VEHICLE_TAXONOMY_DRIFT'; end if;
end $$;

alter table app_security.ordinary_goods_sessions_v3 add column specialist_binding uuid[];
create function app_security.pin_specialist_vehicle_draft_v3()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists (select 1 from app_security.specialist_vehicle_draft_refs_v3 r where r.canonical_id=new.category_id) then
    new.specialist_binding := app_security.specialist_vehicle_draft_binding_v3(new.category_id);
    if new.specialist_binding is null then raise exception 'SPECIALIST_VEHICLE_BINDING_UNAVAILABLE'; end if;
  end if;
  return new;
end $$;
revoke all on function app_security.pin_specialist_vehicle_draft_v3() from public,anon,authenticated,service_role;
create trigger pin_specialist_vehicle_draft_v3 before insert on app_security.ordinary_goods_sessions_v3
  for each row execute function app_security.pin_specialist_vehicle_draft_v3();

do $$
declare def text; needle text := 'where g.category_id=p_category and g.enabled';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_available_v3(uuid)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'SPECIALIST_VEHICLE_AVAILABILITY_DRIFT'; end if;
  execute replace(def,needle,needle || $guard$
    and (not exists (select 1 from app_security.specialist_vehicle_draft_refs_v3 r where r.canonical_id=p_category)
         or app_security.specialist_vehicle_draft_binding_v3(p_category) is not null)$guard$);
end $$;

do $$
declare def text; needle text := 'and b.revision=g.revision and s.owner_id=u';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_session_v3(text,uuid,text,uuid)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'SPECIALIST_VEHICLE_SESSION_DRIFT'; end if;
  execute replace(def,needle,needle || $guard$
    and b.specialist_binding is not distinct from app_security.specialist_vehicle_draft_binding_v3(g.category_id)$guard$);
end $$;
commit;
