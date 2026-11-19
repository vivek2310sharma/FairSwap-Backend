begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_security.ordinary_goods_contracts_v3
  add column macro_category text not null default 'goods'
  check (macro_category='goods' or (macro_category='vehicles'
    and posting_flow='generic' and moderation_mode='staff_intake' and slug in ('v2-car-accessories-parts','v2-bike-accessories-parts','v2-bicycles')));

insert into app_security.ordinary_goods_contracts_v3 (slug,parent_slug,category_id,risk,macro_category,moderation_mode,fields) values
  ('v2-car-accessories-parts','v2-cars-commercial-vehicles','393eb1aa-0ad5-55ac-ab45-8fc041e20f2b','general','vehicles','staff_intake','[{"key":"part_type","label":"Part type","kind":"text","required":true,"choices":["Floor mat","Seat cover","Storage organiser","Weather cover","Trim"]},{"key":"compatibility","label":"Compatible makes and models","kind":"text","required":true},{"key":"authenticity","label":"Source","kind":"text","required":true,"choices":["Original manufacturer","Third-party compatible"]}]'::jsonb),
  ('v2-bicycles','v2-bikes-scooters','b97194c0-bb0d-5144-bd17-257bc434215a','general','vehicles','staff_intake','[{"key":"cycle_type","label":"Cycle type","kind":"text","required":true,"choices":["Road","Mountain","Hybrid","City","Folding"]},{"key":"propulsion","label":"Propulsion","kind":"text","required":true,"choices":["Pedal only, no motor"]},{"key":"frame_size","label":"Frame size or rider fit","kind":"text","required":true},{"key":"brakes","label":"Brakes","kind":"text","required":true,"choices":["Working and tested"]},{"key":"frame","label":"Frame condition","kind":"text","required":true,"choices":["Intact, no cracks"]}]'::jsonb),
  ('v2-bike-accessories-parts','v2-bikes-scooters','0e5281ec-aacb-56cc-a2e8-9661ebda10eb','general','vehicles','staff_intake','[{"key":"part_type","label":"Part type","kind":"text","required":true,"choices":["Weather cover","Luggage bag","Decorative trim","Seat cover"]},{"key":"compatibility","label":"Compatible makes and models","kind":"text","required":true},{"key":"authenticity","label":"Source","kind":"text","required":true,"choices":["Original manufacturer","Third-party compatible"]}]'::jsonb);

do $$
begin
  if (select count(*) from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug and c.posting_flow=g.posting_flow
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.macro_category='vehicles' and c.macro_category=g.macro_category
      and c.status='coming_soon' and not c.is_active and not c.new_listing_enabled) <> 3
  then raise exception 'PEDAL_AND_PARTS_TAXONOMY_DRIFT'; end if;
end $$;

do $$
declare def text; needle text := 'c.macro_category=''goods''';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_available_v3(uuid)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'PEDAL_AND_PARTS_AVAILABILITY_DRIFT'; end if;
  execute replace(def,needle,'c.macro_category=g.macro_category');
end $$;

do $$
declare def text; needle text := 'perform app_security.phone_content_guard(t);';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'PEDAL_AND_PARTS_VALIDATOR_DRIFT'; end if;
  execute replace(def,needle,needle || $patch$
    if g.slug='v2-bicycles' and t ~* '(electric|battery|throttle|engine|motor[ -]?assist|conversion kit|e[- ]?bike|e[- ]?cycle)'
    then raise exception using errcode='22023',message='ORDINARY_GOODS_PEDAL_ONLY'; end if;
  $patch$);
end $$;
commit;
