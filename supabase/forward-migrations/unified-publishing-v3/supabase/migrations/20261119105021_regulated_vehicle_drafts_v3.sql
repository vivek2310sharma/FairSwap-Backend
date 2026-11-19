begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table app_security.ordinary_goods_contracts_v3
  add column draft_only boolean not null default false,
  drop constraint ordinary_goods_contracts_v3_check1,
  add check (draft_only = (slug in ('v2-commercial-vehicles','v2-electric-cycles-low-speed-evs'))),
  add check (macro_category='goods' or
    (macro_category='vehicles' and posting_flow='generic' and moderation_mode='staff_intake' and slug in
      ('v2-car-accessories-parts','v2-bicycles','v2-bike-accessories-parts','v2-commercial-vehicles','v2-electric-cycles-low-speed-evs'))
    or (macro_category='property' and posting_flow='property' and moderation_mode='staff_intake' and slug in
      ('v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms','v2-shops-offices','v2-land-plots','v2-warehouses-godowns')));

insert into app_security.ordinary_goods_contracts_v3
  (slug,parent_slug,category_id,risk,macro_category,moderation_mode,draft_only,fields) values
  ('v2-commercial-vehicles','v2-cars-commercial-vehicles','fa9832f6-1de7-5530-8564-5202f13c37d3','electrical','vehicles','staff_intake',true,'[{"key":"vehicle_class","label":"Vehicle class","required":true,"kind":"text","choices":["Goods carrier","Passenger transport","Special-purpose vehicle"]},{"key":"brand","label":"Make","required":true,"kind":"text"},{"key":"model","label":"Model","required":true,"kind":"text"},{"key":"registration","label":"Registration status","required":true,"kind":"text","choices":["Registered","Unverified"]},{"key":"permit","label":"Permit status","required":true,"kind":"text","choices":["Available for private verification","Unverified"]},{"key":"fitness","label":"Fitness status","required":true,"kind":"text","choices":["Available for private verification","Unverified"]},{"key":"insurance","label":"Insurance status","required":true,"kind":"text","choices":["Available for private verification","Unverified"]},{"key":"authority","label":"Transfer authority","required":true,"kind":"text","choices":["Registered owner","Authorised representative","Unverified"]}]'::jsonb),
  ('v2-electric-cycles-low-speed-evs','v2-bikes-scooters','f414e99c-8b75-5b95-ae81-9f088ed96fe4','electrical','vehicles','staff_intake',true,'[{"key":"classification","label":"Classification","required":true,"kind":"text","choices":["Unverified","Manufacturer evidence available for private verification"]},{"key":"brand","label":"Make","required":true,"kind":"text"},{"key":"model","label":"Model","required":true,"kind":"text"},{"key":"evidence","label":"Evidence status","required":true,"kind":"text","choices":["No authoritative evidence","Manufacturer or certification evidence available"]}]'::jsonb);

do $$
begin
  if (select count(*) from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug and c.posting_flow=g.posting_flow
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.draft_only and c.macro_category=g.macro_category
      and c.status='coming_soon' and not c.is_active and not c.new_listing_enabled
      and not exists (select 1 from public.listings l where l.category_id=c.id)) <> 2
  then raise exception 'REGULATED_DRAFT_TAXONOMY_DRIFT'; end if;
end $$;

-- The API may allocate an owned media session. Never freeze a draft-only
-- payload, which keeps the common media-copy and submission paths closed.
do $$
declare def text;
  needle text := 'select * into g from app_security.ordinary_goods_contracts_v3 where slug=p_payload->>''slug'' for share;';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_prepare_v3(jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
  then raise exception 'REGULATED_DRAFT_PREPARE_DRIFT'; end if;
  execute replace(def,needle,needle || $guard$
    if g.draft_only then
      raise exception using errcode='42501',message='REGULATED_VEHICLE_DRAFT_ONLY';
    end if;
  $guard$);
end $$;

create function app_security.regulated_vehicle_draft_guard_v3()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists (select 1 from app_security.ordinary_goods_contracts_v3 g
    where g.category_id=new.category_id and g.draft_only)
  then raise exception using errcode='42501',message='REGULATED_VEHICLE_DRAFT_ONLY'; end if;
  return new;
end $$;
revoke all on function app_security.regulated_vehicle_draft_guard_v3() from public,anon,authenticated,service_role;
create trigger regulated_vehicle_draft_guard_v3 before insert or update on public.listings
  for each row execute function app_security.regulated_vehicle_draft_guard_v3();
commit;
