-- Package 2: canonical seed only. No generic imports or new posting activation.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
-- Serialize against listing assignments first; existing lock order is listing -> category.
lock table public.listings in share row exclusive mode;
lock table public.categories in share row exclusive mode;

-- Single production definition of canonical config. UUIDv5(URL namespace,
-- https://fairswap.in/taxonomy/v2/<slug>); three proven specialist identities
-- retain their existing environment-specific UUID instead of re-keying references.
create or replace function app_security.impl_taxonomy_v2_expected_nodes()
returns table(seed_id uuid,slug text,parent_slug text,name text,posting_flow text,catalogue_mode text,sort_order integer,legacy_slug text)
language sql immutable security definer set search_path='' as $$
 select v.seed_id::uuid,v.slug,v.parent_slug,v.name,v.posting_flow,v.catalogue_mode,v.sort_order,v.legacy_slug
 from (values
 ('eac991ca-5ea3-5ad7-8523-f6435e0f97f3','v2-mobiles-tablets',null,'Mobiles & Tablets',null,null,100,null),
 ('f43e6239-0b3e-5747-8137-a33004953cb2','mobile-phones','v2-mobiles-tablets','Mobile Phones','specialist:phone','brand_model',101,'mobile-phones'),
 ('ef46c6a4-1972-5967-9ba2-3d9135f87424','tablets','v2-mobiles-tablets','Tablets','specialist:tablet','brand_model',102,'tablets'),
 ('ed0a16fb-c28e-51ab-8246-7a592bb151a6','wearables','v2-mobiles-tablets','Smartwatches & Wearables','specialist:wearable','brand_model',103,'wearables'),
 ('a0ec60da-f8ef-5b00-bb77-f9d801022c02','v2-headphones-earbuds','v2-mobiles-tablets','Headphones & Earbuds','accessory','brand_model',104,null),
 ('a190b604-cd48-536e-ab0e-aaf62b263399','v2-mobile-tablet-accessories','v2-mobiles-tablets','Mobile & Tablet Accessories','accessory','brand_model',105,null),
 ('0cafad03-2699-5a7a-aa3a-45b7a165c904','v2-cars-commercial-vehicles',null,'Cars & Commercial Vehicles',null,null,200,null),
 ('3792cc10-5347-5c67-ac98-7f488430abd2','v2-cars','v2-cars-commercial-vehicles','Cars','specialist:car','brand_model',201,null),
 ('393eb1aa-0ad5-55ac-ab45-8fc041e20f2b','v2-car-accessories-parts','v2-cars-commercial-vehicles','Car Accessories & Spare Parts','generic','brand_model',202,null),
 ('fa9832f6-1de7-5530-8564-5202f13c37d3','v2-commercial-vehicles','v2-cars-commercial-vehicles','Commercial & Other Vehicles','generic','brand_model',203,null),
 ('57d21b78-498a-50c9-9fab-bb1d61e4e88b','v2-bikes-scooters',null,'Bikes & Scooters',null,null,300,null),
 ('e31b87f4-08a0-5757-89d7-739f27100021','v2-motorcycles-scooters','v2-bikes-scooters','Motorcycles & Scooters','specialist:two_wheeler','brand_model',301,null),
 ('b97194c0-bb0d-5144-bd17-257bc434215a','v2-bicycles','v2-bikes-scooters','Bicycles','generic','brand_model',302,null),
 ('f414e99c-8b75-5b95-ae81-9f088ed96fe4','v2-electric-cycles-low-speed-evs','v2-bikes-scooters','Electric Cycles & Low-Speed EVs','generic','brand_model',303,null),
 ('0e5281ec-aacb-56cc-a2e8-9661ebda10eb','v2-bike-accessories-parts','v2-bikes-scooters','Bike Accessories & Spare Parts','generic','brand_model',304,null),
 ('3ea15d63-f2b5-5794-b2a5-cec0add66992','v2-property',null,'Property',null,null,400,null),
 ('716838c7-6409-553d-b483-dd58be5316b7','v2-houses-apartments','v2-property','Houses & Apartments','property','none',401,null),
 ('2656328c-97c8-557c-bf53-5d32df0f7832','v2-pg-hostels-guest-houses','v2-property','PG, Hostels & Guest Houses','property','none',402,null),
 ('9e65c169-151c-5f07-ad9e-bd1e0aa90c9b','v2-flatmates-shared-rooms','v2-property','Flatmates & Shared Rooms','property','none',403,null),
 ('8a1346d7-a363-5644-aa36-9a94e078e3e3','v2-shops-offices','v2-property','Shops & Offices','property','none',404,null),
 ('09c78469-c71f-5ccc-86a8-6bf2a63b1a68','v2-land-plots','v2-property','Land & Plots','property','none',405,null),
 ('61353cc1-e006-5309-aa14-692e54806eaf','v2-warehouses-godowns','v2-property','Warehouses & Godowns','property','none',406,null),
 ('1147d7a7-6032-5652-b644-53e3887b68b4','v2-computers-gaming',null,'Computers & Gaming',null,null,500,null),
 ('b73ac36f-878c-5956-bf13-3fb4c8b9aabe','v2-laptops','v2-computers-gaming','Laptops','generic','brand_model',501,null),
 ('238bf29b-b6c3-5b7d-b6c2-f657ece37320','v2-desktops-monitors','v2-computers-gaming','Desktops & Monitors','generic','brand_model',502,null),
 ('2a6e3c82-ddab-5b8f-a18d-f68cb89c8f9f','v2-computer-accessories-storage','v2-computers-gaming','Computer Accessories & Storage','generic','brand_model',503,null),
 ('32e07b86-43e7-52db-9bb8-c4f791e6d083','v2-printers-scanners','v2-computers-gaming','Printers & Scanners','generic','brand_model',504,null),
 ('c4599d86-da57-5f2a-bd96-21c82c4815dd','v2-gaming-consoles-games','v2-computers-gaming','Gaming Consoles & Games','generic','brand_model',505,null),
 ('861fbcbf-095b-5158-9391-6257ab8ae522','v2-tvs-audio-cameras',null,'TVs, Audio & Cameras',null,null,600,null),
 ('331aa914-39c6-5cb1-9b63-49e50a62dd01','v2-tvs','v2-tvs-audio-cameras','TVs','generic','brand_model',601,null),
 ('cb84e54c-57a8-5e6d-8696-77cc420b2e81','v2-projectors','v2-tvs-audio-cameras','Projectors','generic','brand_model',602,null),
 ('9707e78d-f5e2-5d0e-9ee7-352154b7af76','v2-speakers-home-theatre','v2-tvs-audio-cameras','Speakers & Home Theatre','generic','brand_model',603,null),
 ('30e64b09-0f8d-5267-b395-95bd3ef3bb2a','v2-cameras-lenses','v2-tvs-audio-cameras','Cameras & Lenses','generic','brand_model',604,null),
 ('e9fa587f-fdbf-515a-8eff-7b0df0babed6','v2-other-electronics-gadgets','v2-tvs-audio-cameras','Other Electronics & Gadgets','generic','brand_model',605,null),
 ('8a817e18-6fa3-5ea1-9182-434f2a11d6a5','v2-home-appliances',null,'Home Appliances',null,null,700,null),
 ('45e64a25-0b43-56ec-99c9-61f2ff91b394','v2-refrigerators','v2-home-appliances','Refrigerators','generic','brand_model',701,null),
 ('4413f628-e2e9-50b2-aea0-ade25c179d96','v2-washing-machines','v2-home-appliances','Washing Machines','generic','brand_model',702,null),
 ('fab9ba78-04ea-500c-b4cd-e8790b38b449','v2-air-conditioners','v2-home-appliances','Air Conditioners','generic','brand_model',703,null),
 ('fda6a67b-56af-5fbe-bf36-99b34c1cbeff','v2-air-coolers-fans-geysers','v2-home-appliances','Air Coolers, Fans & Geysers','generic','brand_model',704,null),
 ('6585523d-0714-54c0-8b81-c7ffdb1fa455','v2-kitchen-appliances','v2-home-appliances','Kitchen Appliances','generic','brand_model',705,null),
 ('f0ab774d-f7f5-59c6-b79e-55abeb6f86b8','v2-power-backup-solar','v2-home-appliances','Power Backup & Solar','generic','brand_model',706,null),
 ('352804fe-6450-5e28-ad21-7006dca07d7d','v2-other-appliances','v2-home-appliances','Other Appliances','generic','brand_model',707,null),
 ('ce0eb17a-9652-57fe-b534-ab40f258661c','v2-furniture-home',null,'Furniture & Home',null,null,800,null),
 ('c57a87d6-9e3c-5a20-afdc-bda20c7418bb','v2-sofas-dining','v2-furniture-home','Sofas & Dining','generic','brand_only',801,null),
 ('3ba0ef34-6e04-52b9-ac10-d4a8ff61c714','v2-beds-wardrobes','v2-furniture-home','Beds & Wardrobes','generic','brand_only',802,null),
 ('ec6a3d86-1ce8-574e-9a7b-bef64e1ccf41','v2-tables-chairs','v2-furniture-home','Tables & Chairs','generic','brand_only',803,null),
 ('129afa6d-6deb-5fef-815d-a3be574cebf3','v2-home-decor-garden','v2-furniture-home','Home Decor & Garden','generic','brand_only',804,null),
 ('35c1fe9f-dbf1-5b75-ad8b-9bfea308dd3f','v2-kitchenware-utensils','v2-furniture-home','Kitchenware & Utensils','generic','brand_only',805,null),
 ('b56cb870-093c-5a1b-baf1-ea68f18d4c79','v2-other-household-items','v2-furniture-home','Other Household Items','generic','brand_only',806,null),
 ('26482599-d853-52fb-ab56-f06da3ca80c1','v2-fashion',null,'Fashion',null,null,900,null),
 ('e0bdd2a1-dc3c-5a0d-a6a8-fcc6abff74fc','v2-men','v2-fashion','Men','generic','brand_only',901,null),
 ('b8270acc-966c-5554-bac4-9feb51b7f572','v2-women','v2-fashion','Women','generic','brand_only',902,null),
 ('d9b17ca0-a706-5e42-b060-3d6526ae57ca','v2-kids','v2-fashion','Kids','generic','brand_only',903,null),
 ('6cfdf034-9b79-511b-aa74-e56574960477','v2-watches','v2-fashion','Watches','generic','brand_model',904,null),
 ('0ab5049d-e22e-5728-95c5-9dc67b4de96e','v2-bags-luggage','v2-fashion','Bags & Luggage','generic','brand_only',905,null),
 ('531b5e52-df72-535a-b4b9-07503726161b','v2-sunglasses-accessories','v2-fashion','Sunglasses & Accessories','generic','brand_only',906,null),
 ('ca1098fc-3bca-5167-8a73-9983fc31c3af','v2-kids-baby',null,'Kids & Baby',null,null,1000,null),
 ('764c31c7-df3f-5bac-a3f2-1b56e7baabb2','v2-strollers-prams','v2-kids-baby','Strollers & Prams','generic','brand_model',1001,null),
 ('9bfe17ce-5eb0-5d4c-973f-23ad120e24e3','v2-cribs-cots-kids-furniture','v2-kids-baby','Cribs, Cots & Kids Furniture','generic','brand_only',1002,null),
 ('50287b21-0995-5699-94f9-4f2651a94ec5','v2-baby-gear-car-seats','v2-kids-baby','Baby Gear & Car Seats','generic','brand_model',1003,null),
 ('5fd8809e-19aa-5310-851a-707e033e1baa','v2-toys-games','v2-kids-baby','Toys & Games','generic','brand_only',1004,null),
 ('130863d9-8eeb-5e5a-ad1f-b53f33d7da29','v2-school-bags-kids-essentials','v2-kids-baby','School Bags & Kids Essentials','generic','brand_only',1005,null),
 ('cff1fd85-04e3-589f-b90f-8229e2e2e618','v2-books-sports-hobbies',null,'Books, Sports & Hobbies',null,null,1100,null),
 ('c0ba9c51-8d6a-5c81-99e1-6be9c60a8fc5','v2-books','v2-books-sports-hobbies','Books','generic','none',1101,null),
 ('0990551a-028c-57d9-8089-e568d1da6c6f','v2-textbooks-exam-prep','v2-books-sports-hobbies','Textbooks & Exam Prep','generic','none',1102,null),
 ('ab2eac8e-e20a-54eb-a60f-03b3a636710d','v2-gym-fitness','v2-books-sports-hobbies','Gym & Fitness','generic','brand_model',1103,null),
 ('ad008d07-df94-5572-bd8c-1ac5b8d9c64f','v2-sports-equipment','v2-books-sports-hobbies','Sports Equipment','generic','brand_model',1104,null),
 ('58261475-f394-5c18-9d33-0aac8ac4490c','v2-musical-instruments','v2-books-sports-hobbies','Musical Instruments','generic','brand_model',1105,null),
 ('4a30d94c-4408-5184-9021-61f358fb17aa','v2-other-hobbies','v2-books-sports-hobbies','Other Hobbies','generic','brand_only',1106,null),
 ('c0d8c1b9-c0a8-5943-85f8-9ef517bef49b','v2-pets-supplies',null,'Pets & Pet Supplies',null,null,1200,null),
 ('6e800b53-63b2-54a6-b153-6ed48a7bb549','v2-dogs','v2-pets-supplies','Dogs','adoption_rehoming','none',1201,null),
 ('0eab6fd4-2967-58e4-80a4-983dedd41170','v2-other-pets','v2-pets-supplies','Other Pets','adoption_rehoming','none',1202,null),
 ('5402e408-0bc6-5370-979d-6391b03216c3','v2-pet-food-accessories','v2-pets-supplies','Pet Food & Accessories','generic','brand_only',1203,null),
 ('43f09356-8d1c-5a4c-b52d-3ac989a4e034','v2-aquariums-fish-supplies','v2-pets-supplies','Aquariums & Fish Supplies','generic','brand_only',1204,null),
 ('c441466a-af05-57ec-8ff2-732b97fcad16','v2-other',null,'Other',null,null,1300,null),
 ('66ec1796-5103-5c9c-87e1-cfdd3774365b','v2-other-items','v2-other','Other Items','generic','none',1301,null),
 ('688d5be8-b623-5a45-8af7-665e5c56c85d','v2-services',null,'Services',null,null,1400,null),
 ('9a553eed-1bd6-55be-b1ff-b2465b86c1b4','v2-jobs',null,'Jobs',null,null,1500,null)
 ) v(seed_id,slug,parent_slug,name,posting_flow,catalogue_mode,sort_order,legacy_slug);
$$;
revoke all on function app_security.impl_taxonomy_v2_expected_nodes() from public,anon,authenticated,service_role;

-- Preserve the released specialist-only creation boundary: their generic INSERT
-- flag intentionally stays false. No RLS grant, specialist RPC or release flag is changed.
create or replace function app_security.impl_taxonomy_v2_can_post(p_category_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.categories c join public.categories r on r.id=c.parent_id
  where c.id=p_category_id and c.status='live' and c.is_active and r.status='live' and r.is_active
   and (c.new_listing_enabled or
    (c.posting_flow='specialist:phone' and c.slug='mobile-phones'
     and pg_catalog.to_regprocedure('public.submit_mobile_v2(jsonb)') is not null
     and exists(select 1 from public.posting_category_definitions d where d.listing_category_id=c.id
      and d.category_key='mobiles' and d.subcategory_key='mobile-phones' and d.version=2 and d.enabled)) or
    (c.posting_flow='specialist:tablet' and c.slug='tablets'
     and pg_catalog.to_regprocedure('public.submit_tablet_v1(jsonb)') is not null
     and exists(select 1 from public.tablet_release_v1 d where d.category_id=c.id and d.enabled)) or
    (c.posting_flow='specialist:wearable' and c.slug='wearables'
     and pg_catalog.to_regprocedure('public.submit_wearable_v1(jsonb)') is not null
     and exists(select 1 from public.wearable_release_v1 d where d.category_id=c.id and d.enabled))))
$$;
revoke all on function app_security.impl_taxonomy_v2_can_post(uuid) from public,anon,authenticated,service_role;

do $seed$
#variable_conflict use_column
declare e record; c public.categories; parent_uuid uuid; state text; active boolean; expected_id uuid;
begin
 if (select count(*) from public.generic_product_brands)<>0 or (select count(*) from public.generic_product_models)<>0
  or exists(select 1 from public.listing_generic_product_identity) then
  raise exception 'TAXONOMY_V2_PACKAGE2_EXPECTS_EMPTY_GENERIC_TABLES';
 end if;
 if exists(select 1 from public.categories c where c.status is not null and not exists(
  select 1 from app_security.impl_taxonomy_v2_expected_nodes() e where e.slug=c.slug)) then
  raise exception 'TAXONOMY_V2_PACKAGE2_UNREVIEWED_MANAGED_CATEGORY';
 end if;
 -- Proof of exact semantics and binding, not just a label match. Fail on drift.
 if (select count(*) from public.categories c where c.slug='mobile-phones' and c.name='Mobile Phones'
     and c.macro_category='goods' and not c.new_listing_enabled and exists(select 1 from public.posting_category_definitions d
      where d.listing_category_id=c.id and d.category_key='mobiles' and d.subcategory_key='mobile-phones' and d.version=2))<>1
 or (select count(*) from public.categories c where c.slug='tablets' and c.name='Tablets' and c.macro_category='goods'
     and not c.new_listing_enabled and exists(select 1 from public.tablet_release_v1 d where d.category_id=c.id))<>1
 or (select count(*) from public.categories c where c.slug='wearables' and c.name='Smartwatches & Wearables' and c.macro_category='goods'
     and not c.new_listing_enabled and exists(select 1 from public.wearable_release_v1 d where d.category_id=c.id))<>1 then
  raise exception 'TAXONOMY_V2_PACKAGE2_SPECIALIST_BINDING_DRIFT';
 end if;
 for e in select * from app_security.impl_taxonomy_v2_expected_nodes() order by sort_order loop
  select * into c from public.categories where slug=e.slug;
  if found and c.status is null and e.legacy_slug is null then
   raise exception 'TAXONOMY_V2_PACKAGE2_SLUG_CONFLICT: %',e.slug;
  end if;
  expected_id:=case when e.legacy_slug is not null then c.id else e.seed_id end;
  parent_uuid:=null;
  if e.parent_slug is not null then select id into strict parent_uuid from public.categories where slug=e.parent_slug; end if;
  active:=case when e.legacy_slug is not null then c.is_active else e.parent_slug is null and e.slug not in ('v2-services','v2-jobs') end;
  state:=case when e.parent_slug is null and e.slug not in ('v2-services','v2-jobs') then 'live'
   when e.slug='mobile-phones' and active and exists(select 1 from public.posting_category_definitions where listing_category_id=c.id and enabled and version=2) then 'live'
   when e.slug='tablets' and active and exists(select 1 from public.tablet_release_v1 where category_id=c.id and enabled) then 'live'
   when e.slug='wearables' and active and exists(select 1 from public.wearable_release_v1 where category_id=c.id and enabled) then 'live'
   else 'coming_soon' end;
  if c.id is not null and c.status is not null then
   -- Idempotent replay checks the installed config; never rewrites later activation/drift.
   if row(c.id,c.parent_id,c.name,c.status,c.posting_flow,c.catalogue_mode,c.sort_order,c.is_active,c.new_listing_enabled)
    is distinct from row(expected_id,parent_uuid,e.name,state,e.posting_flow,e.catalogue_mode,e.sort_order,active,false) then
    raise exception 'TAXONOMY_V2_PACKAGE2_EXISTING_CONFIG_DRIFT: %',e.slug;
   end if;
  elsif c.id is not null then
   update public.categories set parent_id=parent_uuid,status=state,posting_flow=e.posting_flow,
    catalogue_mode=e.catalogue_mode,sort_order=e.sort_order where id=c.id;
  else
   insert into public.categories(id,slug,name,parent_id,status,posting_flow,catalogue_mode,sort_order,is_active,new_listing_enabled,macro_category)
   values(expected_id,e.slug,e.name,parent_uuid,state,e.posting_flow,e.catalogue_mode,e.sort_order,active,false,
    case when e.parent_slug is null then null when e.posting_flow='property' then 'property'
     when e.posting_flow in ('specialist:car','specialist:two_wheeler') or e.slug in ('v2-commercial-vehicles','v2-car-accessories-parts','v2-bike-accessories-parts','v2-bicycles','v2-electric-cycles-low-speed-evs') then 'vehicles' else 'goods' end);
  end if;
 end loop;
 if (select count(*) from public.categories where status is not null)<>78 then raise exception 'TAXONOMY_V2_PACKAGE2_NODE_COUNT';end if;
end;
$seed$;

-- Replace only the V2 foundation guard, preserving its signature, owner and ACL.
-- AFTER UPDATE observes final lifecycle transitions, including implicit submission.
create or replace function app_security.impl_taxonomy_v2_listing_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare c public.categories; r public.categories; assignment boolean;
begin
 assignment:=tg_op='INSERT';
 if tg_op='UPDATE' then
  assignment:=new.category_id is distinct from old.category_id;
  if not assignment and new.status is not distinct from old.status then return new;end if;
 end if;
 select * into c from public.categories where id=new.category_id for share;
 if c.status is null then return new;end if;
 if c.parent_id is null then raise exception using errcode='23514',message='TAXONOMY_V2_ROOT_NOT_POSTABLE';end if;
 select * into r from public.categories where id=c.parent_id for share;
 if (assignment or new.status in ('pending_review','active','reserved')) and not app_security.impl_taxonomy_v2_can_post(c.id) then
  raise exception using errcode='23514',message='TAXONOMY_V2_CATEGORY_UNAVAILABLE';
 end if;
 return new;
end;
$$;

-- Visible Coming Soon leaves stay inactive for old discovery/RLS clients. Only
-- the explicit V2 definer projection exposes their non-postable catalogue labels.
-- Legacy rows retain flags/attributes/references and remain absent from this API.
create or replace function app_security.impl_get_category_catalogue_v2()
returns jsonb language sql stable security definer set search_path='' as $$
 with visible as (
  select c.id,c.parent_id,c.slug,c.name,c.status,c.posting_flow,c.catalogue_mode,c.sort_order,
   app_security.impl_taxonomy_v2_can_post(c.id) as posting_enabled
  from public.categories c join app_security.impl_taxonomy_v2_expected_nodes() e on e.slug=c.slug
  left join public.categories r on r.id=c.parent_id
  where c.status in ('live','coming_soon') and (c.is_active or c.status='coming_soon')
   and (c.parent_id is null or (r.status in ('live','coming_soon') and (r.is_active or r.status='coming_soon')))
 ), payload as (
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(v) order by v.sort_order,v.slug),'[]'::jsonb) nodes from visible v
 ), configuration as (
  select pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(c.slug,e.parent_slug,c.name,c.posting_flow,c.catalogue_mode,c.sort_order)
   order by c.sort_order,c.slug)::text) revision
  from public.categories c join app_security.impl_taxonomy_v2_expected_nodes() e on e.slug=c.slug
 ) select pg_catalog.jsonb_build_object('api_version',2,'taxonomy_revision','catalogue-2',
  'revision',pg_catalog.md5(nodes::text),'configuration_revision',configuration.revision,'nodes',nodes) from payload cross join configuration;
$$;
-- Legacy staff RPCs must not silently rename/reparent canonical configuration.
-- Existing safety deactivation flags remain operable. Future config changes need
-- a reviewed forward migration that deliberately replaces this immutable contract.
create or replace function app_security.impl_taxonomy_v2_config_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.status is not null and exists(select 1 from app_security.impl_taxonomy_v2_expected_nodes() e where e.slug=old.slug)
  and row(new.id,new.slug,new.name,new.parent_id,new.posting_flow,new.catalogue_mode,new.sort_order)
   is distinct from row(old.id,old.slug,old.name,old.parent_id,old.posting_flow,old.catalogue_mode,old.sort_order) then
  raise exception using errcode='23514',message='TAXONOMY_V2_CANONICAL_CONFIG_IMMUTABLE';
 end if;
 return new;
end;
$$;
revoke all on function app_security.impl_taxonomy_v2_config_guard() from public,anon,authenticated,service_role;
do $$ begin
 if not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.categories'::regclass and tgname='taxonomy_v2_config_guard') then
  create trigger taxonomy_v2_config_guard before update on public.categories for each row execute function app_security.impl_taxonomy_v2_config_guard();
 elsif not exists(select 1 from pg_catalog.pg_trigger where tgrelid='public.categories'::regclass and tgname='taxonomy_v2_config_guard'
  and tgfoid='app_security.impl_taxonomy_v2_config_guard()'::regprocedure and tgenabled='O') then
  raise exception 'TAXONOMY_V2_PACKAGE2_CONFIG_GUARD_DRIFT';
 end if;
end $$;
commit;
