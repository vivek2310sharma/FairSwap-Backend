begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table app_security.ordinary_goods_contracts_v3
  drop constraint ordinary_goods_contracts_v3_posting_flow_check,
  add check (posting_flow in ('generic','accessory') or (posting_flow='property' and macro_category='property')),
  drop constraint ordinary_goods_contracts_v3_check,
  add check (macro_category='goods' or (macro_category='vehicles'
    and posting_flow='generic' and moderation_mode='staff_intake'
    and slug in ('v2-car-accessories-parts','v2-bicycles','v2-bike-accessories-parts'))
    or (macro_category='property' and posting_flow='property' and moderation_mode='staff_intake'
      and slug in ('v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms','v2-shops-offices','v2-land-plots','v2-warehouses-godowns')));

insert into app_security.ordinary_goods_contracts_v3 (slug,parent_slug,category_id,risk,posting_flow,macro_category,moderation_mode,fields) values
  ('v2-houses-apartments','v2-property','716838c7-6409-553d-b483-dd58be5316b7','general','property','property','staff_intake','[{"key":"item_type","label":"Property type","required":true,"kind":"text","choices":["House","Apartment"]},{"key":"bedrooms","label":"Bedrooms","required":true,"kind":"number","min":0,"max":30},{"key":"floor","label":"Floor","required":true,"kind":"number","min":-5,"max":200},{"key":"area","label":"Carpet area (sq ft)","required":true,"kind":"number","min":1,"max":1000000},{"key":"furnishing","label":"Furnishing","required":true,"kind":"text","choices":["Unfurnished","Semi-furnished","Furnished"]},{"key":"amenities","label":"Facilities and amenities","required":true,"kind":"text"},{"key":"authority","label":"Authority to offer","required":true,"kind":"text","choices":["Owner","Authorised operator or representative"]},{"key":"offer","label":"Offer","required":true,"kind":"text","choices":["Rent","Sale"]},{"key":"amount_paise","label":"Asking amount in paise","required":true,"kind":"number","min":100,"max":1000000000000},{"key":"deposit_paise","label":"Security deposit in paise","required":true,"kind":"number","min":0,"max":1000000000000},{"key":"charges_paise","label":"Monthly charges in paise","required":true,"kind":"number","min":0,"max":1000000000000}]'::jsonb),
  ('v2-pg-hostels-guest-houses','v2-property','2656328c-97c8-557c-bf53-5d32df0f7832','general','property','property','staff_intake','[{"key":"item_type","label":"Accommodation type","required":true,"kind":"text","choices":["PG","Hostel","Guest house"]},{"key":"basis","label":"Monthly rent basis","required":true,"kind":"text","choices":["Per bed","Per room"]},{"key":"occupancy","label":"Occupants per room","required":true,"kind":"number","min":1,"max":30},{"key":"amenities","label":"Included facilities","required":true,"kind":"text"},{"key":"authority","label":"Authority to offer","required":true,"kind":"text","choices":["Owner","Authorised operator or representative"]},{"key":"offer","label":"Offer","required":true,"kind":"text","choices":["Rent"]},{"key":"amount_paise","label":"Asking amount in paise","required":true,"kind":"number","min":100,"max":1000000000000},{"key":"deposit_paise","label":"Security deposit in paise","required":true,"kind":"number","min":0,"max":1000000000000},{"key":"charges_paise","label":"Monthly charges in paise","required":true,"kind":"number","min":0,"max":1000000000000}]'::jsonb),
  ('v2-flatmates-shared-rooms','v2-property','9e65c169-151c-5f07-ad9e-bd1e0aa90c9b','general','property','property','staff_intake','[{"key":"item_type","label":"Room arrangement","required":true,"kind":"text","choices":["Private room","Shared room"]},{"key":"basis","label":"Monthly rent basis","required":true,"kind":"text","choices":["Per person","Per room"]},{"key":"occupancy","label":"Occupants per room","required":true,"kind":"number","min":1,"max":30},{"key":"amenities","label":"Included facilities","required":true,"kind":"text"},{"key":"authority","label":"Authority to offer","required":true,"kind":"text","choices":["Owner","Tenant with written permission"]},{"key":"offer","label":"Offer","required":true,"kind":"text","choices":["Rent"]},{"key":"amount_paise","label":"Asking amount in paise","required":true,"kind":"number","min":100,"max":1000000000000},{"key":"deposit_paise","label":"Security deposit in paise","required":true,"kind":"number","min":0,"max":1000000000000},{"key":"charges_paise","label":"Monthly charges in paise","required":true,"kind":"number","min":0,"max":1000000000000}]'::jsonb),
  ('v2-shops-offices','v2-property','8a1346d7-a363-5644-aa36-9a94e078e3e3','general','property','property','staff_intake','[{"key":"item_type","label":"Premises type","required":true,"kind":"text","choices":["Shop","Office"]},{"key":"usage","label":"Permitted use","required":true,"kind":"text"},{"key":"floor","label":"Floor","required":true,"kind":"number","min":-5,"max":200},{"key":"area","label":"Carpet area (sq ft)","required":true,"kind":"number","min":1,"max":10000000},{"key":"authority","label":"Authority to offer","required":true,"kind":"text","choices":["Owner","Authorised operator or representative"]},{"key":"offer","label":"Offer","required":true,"kind":"text","choices":["Rent","Sale"]},{"key":"amount_paise","label":"Asking amount in paise","required":true,"kind":"number","min":100,"max":1000000000000},{"key":"deposit_paise","label":"Security deposit in paise","required":true,"kind":"number","min":0,"max":1000000000000},{"key":"charges_paise","label":"Monthly charges in paise","required":true,"kind":"number","min":0,"max":1000000000000}]'::jsonb),
  ('v2-land-plots','v2-property','09c78469-c71f-5ccc-86a8-6bf2a63b1a68','general','property','property','staff_intake','[{"key":"item_type","label":"Land classification","required":true,"kind":"text","choices":["Residential plot","Commercial plot","Industrial plot"]},{"key":"area","label":"Plot area (sq ft)","required":true,"kind":"number","min":1,"max":100000000},{"key":"tenure","label":"Documented tenure","required":true,"kind":"text","choices":["Freehold","Leasehold"]},{"key":"restrictions","label":"Permitted use and restrictions","required":true,"kind":"text"},{"key":"authority","label":"Authority to offer","required":true,"kind":"text","choices":["Owner","Authorised operator or representative"]},{"key":"offer","label":"Offer","required":true,"kind":"text","choices":["Sale"]},{"key":"amount_paise","label":"Asking amount in paise","required":true,"kind":"number","min":100,"max":1000000000000},{"key":"deposit_paise","label":"Security deposit in paise","required":true,"kind":"number","min":0,"max":1000000000000},{"key":"charges_paise","label":"Monthly charges in paise","required":true,"kind":"number","min":0,"max":1000000000000}]'::jsonb),
  ('v2-warehouses-godowns','v2-property','61353cc1-e006-5309-aa14-692e54806eaf','general','property','property','staff_intake','[{"key":"item_type","label":"Premises type","required":true,"kind":"text","choices":["Warehouse","Godown"]},{"key":"usage","label":"Permitted storage use","required":true,"kind":"text"},{"key":"area","label":"Floor area (sq ft)","required":true,"kind":"number","min":1,"max":10000000},{"key":"loading","label":"Loading and access","required":true,"kind":"text"},{"key":"authority","label":"Authority to offer","required":true,"kind":"text","choices":["Owner","Authorised operator or representative"]},{"key":"offer","label":"Offer","required":true,"kind":"text","choices":["Rent","Sale"]},{"key":"amount_paise","label":"Asking amount in paise","required":true,"kind":"number","min":100,"max":1000000000000},{"key":"deposit_paise","label":"Security deposit in paise","required":true,"kind":"number","min":0,"max":1000000000000},{"key":"charges_paise","label":"Monthly charges in paise","required":true,"kind":"number","min":0,"max":1000000000000}]'::jsonb);

do $$
begin
  if (select count(*) from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug and c.posting_flow=g.posting_flow
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.macro_category='property' and c.macro_category=g.macro_category
      and c.status='coming_soon' and not c.is_active and not c.new_listing_enabled) <> 6
  then raise exception 'PROPERTY_TAXONOMY_DRIFT'; end if;
end $$;

-- Keep item columns null, including on insert and subsequent updates.
do $$
declare def text; needle text := 'select * into strict g from app_security.ordinary_goods_contracts_v3 where category_id=p_category;';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then raise exception 'PROPERTY_VALIDATOR_DRIFT'; end if;
  execute replace(def,needle,needle || $patch$
    if g.macro_category='property' then
      if p_condition is not null or p_price_type is not null or p_price is not null then
        raise exception using errcode='22023',message='PROPERTY_ITEM_TERMS_FORBIDDEN';
      end if;
      -- Normalize only local validation variables so common text and safety
      -- checks still apply. Persisted listing columns remain NULL.
      p_condition := 'good';
      p_price_type := 'fixed';
      p_price := 100;
      if p_answers->>'offer'='Sale' and
        (p_answers->'deposit_paise' is distinct from '0'::jsonb or p_answers->'charges_paise' is distinct from '0'::jsonb)
      then raise exception using errcode='22023',message='PROPERTY_SALE_RENT_TERMS_FORBIDDEN'; end if;
      if exists(select 1 from jsonb_each(p_answers) e where e.key in ('amount_paise','deposit_paise','charges_paise','bedrooms','floor','occupancy')
        and e.value::text !~ '^-?[0-9]+$') then
        raise exception using errcode='22023',message='PROPERTY_INTEGER_TERMS_REQUIRED';
      end if;
    end if;
  $patch$);
end $$;

do $$
declare def text; needle text := 'perform app_security.phone_content_guard(t);';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then raise exception 'PROPERTY_CONTENT_GUARD_DRIFT'; end if;
  execute replace(def,needle,needle || $patch$
    if g.macro_category='property' and t ~* '(verified owner|verified landlord|(flat|unit|door|house)[[:space:]]*(no[.]?|number|#)[[:space:]]*[a-z0-9]+|aadhaar|aadhar|advance.{0,25}(rent|deposit|payment)|payment.{0,25}(before|upfront))'
    then raise exception using errcode='22023',message='PROPERTY_PRIVATE_OR_UNVERIFIED_CONTENT'; end if;
  $patch$);
end $$;

do $$
declare def text;
  needle text := 'or jsonb_typeof(p_payload->''price_paise'') is distinct from ''number''';
  strings text := 'unnest(array[''slug'',''category_id'',''session_id'',''title'',''description'',''condition'',''price_type'',''pin_code''';
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_prepare_v3(jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
     or (length(def)-length(replace(def,strings,''))) <> length(strings)
  then raise exception 'PROPERTY_PREPARE_DRIFT'; end if;
  -- Keep the exact key allowlist and validate item/property terms by the
  -- selected contract after the binding has been checked.
  def := replace(def,needle,$shape$
    or jsonb_typeof(p_payload->'price_paise') not in ('number','null')
    or jsonb_typeof(p_payload->'condition') not in ('string','null')
    or jsonb_typeof(p_payload->'price_type') not in ('string','null')$shape$);
  def := replace(def,'unnest(array[''slug'',''category_id'',''session_id'',''title'',''description'',''condition'',''price_type'',''pin_code''',
    'unnest(array[''slug'',''category_id'',''session_id'',''title'',''description'',''pin_code''');
  execute def;
end $$;
-- Preserve the installed seller lifecycle, including the environment-specific
-- specialist branch. Only the owned, frozen canonical property submit can
-- take the no-item-terms branch.
do $$
declare def text; item_terms text := $terms$IF v_listing.condition IS NULL THEN
    RAISE EXCEPTION 'condition is required';
  END IF;

  IF v_listing.price_type IS NULL THEN
    RAISE EXCEPTION 'price type is required';
  END IF;

  IF v_listing.price_type != 'free' AND (v_listing.price_paise IS NULL OR v_listing.price_paise <= 0) THEN
    RAISE EXCEPTION 'price in paise is required for non-free listings';
  END IF;$terms$;
begin
  def := pg_catalog.pg_get_functiondef('app_security.impl_seller_submit_listing(uuid)'::regprocedure);
  if (length(def)-length(replace(def,item_terms,''))) <> length(item_terms)
    then raise exception 'PROPERTY_SELLER_LIFECYCLE_DRIFT'; end if;
  execute replace(def,item_terms,$branch$IF NOT EXISTS (
    SELECT 1 FROM app_security.ordinary_goods_contracts_v3 g
    JOIN app_security.ordinary_goods_sessions_v3 b ON b.category_id=g.category_id AND b.revision=g.revision
    JOIN public.posting_upload_sessions s ON s.id=b.session_id
    WHERE g.category_id=v_listing.category_id AND g.macro_category='property'
      AND app_security.ordinary_goods_available_v3(g.category_id)
      AND s.listing_id=v_listing.id AND s.owner_id=v_caller_id AND s.state='finalizing'
      AND s.expires_at>now() AND b.frozen_payload IS NOT NULL
  ) THEN
    $branch$ || item_terms || E'\n  END IF;');
end $$;
commit;
