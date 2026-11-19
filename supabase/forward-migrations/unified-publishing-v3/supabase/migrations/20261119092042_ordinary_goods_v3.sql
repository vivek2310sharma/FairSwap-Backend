begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_security.ordinary_goods_contracts_v3 (
  category_id uuid primary key references public.categories(id),
  slug text not null unique,
  parent_slug text not null,
  risk text not null check (risk in ('general','electronics','electrical')),
  fields jsonb not null,
  revision integer not null default 1 check (revision > 0),
  enabled boolean not null default false
);
create table app_security.ordinary_goods_sessions_v3 (
  session_id uuid primary key references public.posting_upload_sessions(id) on delete cascade,
  category_id uuid not null references app_security.ordinary_goods_contracts_v3(category_id),
  revision integer not null,
  frozen_payload jsonb
);
alter table app_security.ordinary_goods_contracts_v3 enable row level security;
alter table app_security.ordinary_goods_sessions_v3 enable row level security;
alter table app_security.ordinary_goods_contracts_v3 force row level security;
alter table app_security.ordinary_goods_sessions_v3 force row level security;
revoke all on app_security.ordinary_goods_contracts_v3, app_security.ordinary_goods_sessions_v3
  from public, anon, authenticated, service_role;

insert into app_security.ordinary_goods_contracts_v3 (slug,parent_slug,category_id,risk,fields) values
  ('v2-laptops','v2-computers-gaming','b73ac36f-878c-5956-bf13-3fb4c8b9aabe','electronics','[{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"processor","label":"Processor","required":false,"kind":"text"},{"key":"ram","label":"RAM (GB)","required":false,"kind":"number","min":1.0,"max":512.0},{"key":"storage","label":"Storage (GB)","required":false,"kind":"number","min":1.0,"max":100000.0}]'::jsonb),
  ('v2-desktops-monitors','v2-computers-gaming','238bf29b-b6c3-5b7d-b6c2-f657ece37320','electronics','[{"key":"item_type","label":"Desktop or monitor","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"screen","label":"Screen size (inches)","required":false,"kind":"number","min":5.0,"max":150.0},{"key":"resolution","label":"Resolution","required":false,"kind":"text"}]'::jsonb),
  ('v2-computer-accessories-storage','v2-computers-gaming','2a6e3c82-ddab-5b8f-a18d-f68cb89c8f9f','electronics','[{"key":"item_type","label":"Accessory type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"interface","label":"Connection type","required":false,"kind":"text"},{"key":"capacity","label":"Storage capacity (GB)","required":false,"kind":"number","min":1.0,"max":100000.0}]'::jsonb),
  ('v2-printers-scanners','v2-computers-gaming','32e07b86-43e7-52db-9bb8-c4f791e6d083','electronics','[{"key":"item_type","label":"Printer or scanner","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"print_type","label":"Print technology","required":false,"kind":"text"}]'::jsonb),
  ('v2-gaming-consoles-games','v2-computers-gaming','c4599d86-da57-5f2a-bd96-21c82c4815dd','electronics','[{"key":"item_type","label":"Console or game","required":true,"kind":"text"},{"key":"platform","label":"Platform","required":false,"kind":"text"},{"key":"model","label":"Model or game title","required":false,"kind":"text"},{"key":"included","label":"Included accessories","required":false,"kind":"text"}]'::jsonb),
  ('v2-tvs','v2-tvs-audio-cameras','331aa914-39c6-5cb1-9b63-49e50a62dd01','electronics','[{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"screen","label":"Screen size (inches)","required":true,"kind":"number","min":5.0,"max":150.0},{"key":"technology","label":"Screen technology","required":false,"kind":"text"},{"key":"resolution","label":"Resolution","required":false,"kind":"text"}]'::jsonb),
  ('v2-projectors','v2-tvs-audio-cameras','cb84e54c-57a8-5e6d-8696-77cc420b2e81','electronics','[{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"resolution","label":"Native resolution","required":false,"kind":"text"},{"key":"brightness","label":"Brightness (lumens)","required":false,"kind":"number","min":1.0,"max":50000.0}]'::jsonb),
  ('v2-speakers-home-theatre','v2-tvs-audio-cameras','9707e78d-f5e2-5d0e-9ee7-352154b7af76','electronics','[{"key":"item_type","label":"Audio equipment type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"channels","label":"Channel layout","required":false,"kind":"text"}]'::jsonb),
  ('v2-cameras-lenses','v2-tvs-audio-cameras','30e64b09-0f8d-5267-b395-95bd3ef3bb2a','electronics','[{"key":"item_type","label":"Camera or lens type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"mount","label":"Lens mount","required":false,"kind":"text"}]'::jsonb),
  ('v2-other-electronics-gadgets','v2-tvs-audio-cameras','e9fa587f-fdbf-515a-8eff-7b0df0babed6','electronics','[{"key":"item_type","label":"Device type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"power","label":"Power source","required":false,"kind":"text"}]'::jsonb),
  ('v2-refrigerators','v2-home-appliances','45e64a25-0b43-56ec-99c9-61f2ff91b394','electrical','[{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"capacity","label":"Capacity (litres)","required":true,"kind":"number","min":1.0,"max":2000.0},{"key":"door_type","label":"Door type","required":false,"kind":"text"}]'::jsonb),
  ('v2-washing-machines','v2-home-appliances','4413f628-e2e9-50b2-aea0-ade25c179d96','electrical','[{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"capacity","label":"Load capacity (kg)","required":true,"kind":"number","min":1.0,"max":100.0},{"key":"load_type","label":"Load type","required":false,"kind":"text"}]'::jsonb),
  ('v2-air-conditioners','v2-home-appliances','fab9ba78-04ea-500c-b4cd-e8790b38b449','electrical','[{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"capacity","label":"Cooling capacity (tonnes)","required":true,"kind":"number","min":0.1,"max":25.0},{"key":"unit_type","label":"Unit type","required":false,"kind":"text"}]'::jsonb),
  ('v2-air-coolers-fans-geysers','v2-home-appliances','fda6a67b-56af-5fbe-bf36-99b34c1cbeff','electrical','[{"key":"item_type","label":"Appliance type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"capacity","label":"Capacity or size","required":false,"kind":"text"}]'::jsonb),
  ('v2-kitchen-appliances','v2-home-appliances','6585523d-0714-54c0-8b81-c7ffdb1fa455','electrical','[{"key":"item_type","label":"Appliance type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"capacity","label":"Capacity or size","required":false,"kind":"text"}]'::jsonb),
  ('v2-power-backup-solar','v2-home-appliances','f0ab774d-f7f5-59c6-b79e-55abeb6f86b8','electrical','[{"key":"item_type","label":"Equipment type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"rating","label":"Rated output or capacity","required":false,"kind":"text"}]'::jsonb),
  ('v2-other-appliances','v2-home-appliances','352804fe-6450-5e28-ad21-7006dca07d7d','electrical','[{"key":"item_type","label":"Appliance type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"rating","label":"Power rating","required":false,"kind":"text"}]'::jsonb),
  ('v2-sofas-dining','v2-furniture-home','c57a87d6-9e3c-5a20-afdc-bda20c7418bb','general','[{"key":"item_type","label":"Sofa or dining furniture type","required":true,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"},{"key":"dimensions","label":"Dimensions (cm)","required":false,"kind":"text"},{"key":"seats","label":"Seats","required":false,"kind":"number","min":1.0,"max":100.0}]'::jsonb),
  ('v2-beds-wardrobes','v2-furniture-home','3ba0ef34-6e04-52b9-ac10-d4a8ff61c714','general','[{"key":"item_type","label":"Bed or wardrobe type","required":true,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"},{"key":"dimensions","label":"Dimensions (cm)","required":false,"kind":"text"}]'::jsonb),
  ('v2-tables-chairs','v2-furniture-home','ec6a3d86-1ce8-574e-9a7b-bef64e1ccf41','general','[{"key":"item_type","label":"Table or chair type","required":true,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"},{"key":"dimensions","label":"Dimensions (cm)","required":false,"kind":"text"},{"key":"quantity","label":"Quantity","required":false,"kind":"number","min":1.0,"max":100.0}]'::jsonb),
  ('v2-home-decor-garden','v2-furniture-home','129afa6d-6deb-5fef-815d-a3be574cebf3','general','[{"key":"item_type","label":"Decor or garden item type","required":true,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"},{"key":"dimensions","label":"Dimensions (cm)","required":false,"kind":"text"}]'::jsonb),
  ('v2-kitchenware-utensils','v2-furniture-home','35c1fe9f-dbf1-5b75-ad8b-9bfea308dd3f','general','[{"key":"item_type","label":"Utensil type","required":true,"kind":"text"},{"key":"material","label":"Food-contact material","required":false,"kind":"text"},{"key":"quantity","label":"Pieces","required":false,"kind":"number","min":1.0,"max":1000.0}]'::jsonb),
  ('v2-other-household-items','v2-furniture-home','b56cb870-093c-5a1b-baf1-ea68f18d4c79','general','[{"key":"item_type","label":"Household item type","required":true,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"},{"key":"dimensions","label":"Dimensions (cm)","required":false,"kind":"text"}]'::jsonb),
  ('v2-men','v2-fashion','e0bdd2a1-dc3c-5a0d-a6a8-fcc6abff74fc','general','[{"key":"item_type","label":"Clothing or footwear type","required":true,"kind":"text"},{"key":"size","label":"Labelled size","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"}]'::jsonb),
  ('v2-women','v2-fashion','b8270acc-966c-5554-bac4-9feb51b7f572','general','[{"key":"item_type","label":"Clothing or footwear type","required":true,"kind":"text"},{"key":"size","label":"Labelled size","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"}]'::jsonb),
  ('v2-kids','v2-fashion','d9b17ca0-a706-5e42-b060-3d6526ae57ca','general','[{"key":"item_type","label":"Clothing or footwear type","required":true,"kind":"text"},{"key":"size","label":"Labelled size or age range","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"}]'::jsonb),
  ('v2-watches','v2-fashion','6cfdf034-9b79-511b-aa74-e56574960477','general','[{"key":"item_type","label":"Watch type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"movement","label":"Movement or power source","required":false,"kind":"text"}]'::jsonb),
  ('v2-bags-luggage','v2-fashion','0ab5049d-e22e-5728-95c5-9dc67b4de96e','general','[{"key":"item_type","label":"Bag or luggage type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"dimensions","label":"Dimensions (cm)","required":false,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"}]'::jsonb),
  ('v2-sunglasses-accessories','v2-fashion','531b5e52-df72-535a-b4b9-07503726161b','general','[{"key":"item_type","label":"Accessory type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"size","label":"Size or fit","required":false,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"}]'::jsonb),
  ('v2-books','v2-books-sports-hobbies','c0ba9c51-8d6a-5c81-99e1-6be9c60a8fc5','general','[{"key":"book_title","label":"Book title","required":true,"kind":"text"},{"key":"author","label":"Author","required":false,"kind":"text"},{"key":"edition","label":"Edition","required":false,"kind":"text"},{"key":"language","label":"Language","required":false,"kind":"text"}]'::jsonb),
  ('v2-textbooks-exam-prep','v2-books-sports-hobbies','0990551a-028c-57d9-8089-e568d1da6c6f','general','[{"key":"book_title","label":"Book title","required":true,"kind":"text"},{"key":"subject","label":"Subject or exam","required":true,"kind":"text"},{"key":"edition","label":"Edition","required":false,"kind":"text"},{"key":"publisher","label":"Publisher","required":false,"kind":"text"}]'::jsonb),
  ('v2-gym-fitness','v2-books-sports-hobbies','ab2eac8e-e20a-54eb-a60f-03b3a636710d','general','[{"key":"item_type","label":"Fitness equipment type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"load_rating","label":"Rated load (kg)","required":false,"kind":"number","min":1.0,"max":1000.0}]'::jsonb),
  ('v2-sports-equipment','v2-books-sports-hobbies','ad008d07-df94-5572-bd8c-1ac5b8d9c64f','general','[{"key":"item_type","label":"Equipment type","required":true,"kind":"text"},{"key":"sport","label":"Sport","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"size","label":"Size","required":false,"kind":"text"}]'::jsonb),
  ('v2-musical-instruments','v2-books-sports-hobbies','58261475-f394-5c18-9d33-0aac8ac4490c','general','[{"key":"item_type","label":"Instrument type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"model","label":"Model","required":false,"kind":"text"},{"key":"included","label":"Included accessories","required":false,"kind":"text"}]'::jsonb),
  ('v2-other-hobbies','v2-books-sports-hobbies','4a30d94c-4408-5184-9021-61f358fb17aa','general','[{"key":"item_type","label":"Hobby item type","required":true,"kind":"text"},{"key":"brand","label":"Brand","required":false,"kind":"text"},{"key":"material","label":"Material","required":false,"kind":"text"},{"key":"included","label":"Included pieces","required":false,"kind":"text"}]'::jsonb);
do $$
begin
  if (select count(*) from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where c.posting_flow='generic' and c.macro_category='goods'
      and c.status='coming_soon' and not c.is_active and not c.new_listing_enabled) <> 35 then
    raise exception 'ORDINARY_GOODS_TAXONOMY_DRIFT';
  end if;
end $$;

create function app_security.ordinary_goods_available_v3(p_category uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.category_id=p_category and g.enabled and c.posting_flow='generic'
      and c.macro_category='goods' and c.status='live' and c.is_active
      and not c.new_listing_enabled and p.status='live' and p.is_active
  )
$$;

-- Extend the installed taxonomy predicate without replacing its specialist branches.
do $$
declare def text; needle text := 'select exists(select 1 from public.categories';
begin
  def := pg_catalog.pg_get_functiondef('app_security.impl_taxonomy_v2_can_post(uuid)'::regprocedure);
  if pg_catalog.strpos(def,needle)=0 then raise exception 'TAXONOMY_PREDICATE_DRIFT'; end if;
  execute pg_catalog.replace(def,needle,'select app_security.ordinary_goods_available_v3(p_category_id) or exists(select 1 from public.categories');
end $$;

create function app_security.ordinary_goods_read_v3(p_slug text)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when p_slug is null then coalesce((
    select jsonb_object_agg(g.slug,g.category_id) from app_security.ordinary_goods_contracts_v3 g
    where app_security.ordinary_goods_available_v3(g.category_id)
  ),'{}'::jsonb) else (
    select jsonb_build_object('slug',g.slug,'category_id',g.category_id,'revision',g.revision,'risk',g.risk,'fields',g.fields)
    from app_security.ordinary_goods_contracts_v3 g
    where g.slug=p_slug and app_security.ordinary_goods_available_v3(g.category_id)
  ) end
$$;

create function public.ordinary_goods_v3(slug text default null)
returns jsonb language sql stable security invoker set search_path='' as $$
  select app_security.ordinary_goods_read_v3(slug)
$$;

-- The existing session core retains owner checks, capacity, leases and cleanup.
-- Bind new sessions at allocation and include Goods in the core's partition check.
do $$
declare def text; i integer;
  before_parts text[] := array[
    '(select b.category_id from public.wearable_session_bindings_v1 b where b.session_id=candidate.id)',
    '(select b.category_id from public.wearable_session_bindings_v1 b where b.session_id=s.id)',
    'elsif not exists(select 1 from public.wearable_release_v1',
    'if new_id is not null and p_binding is not null then insert into public.wearable_session_bindings_v1(session_id,category_id) values(new_id,p_binding); end if;'
  ];
  after_parts text[] := array[
    'coalesce((select g.category_id from app_security.ordinary_goods_sessions_v3 g where g.session_id=candidate.id),(select b.category_id from public.wearable_session_bindings_v1 b where b.session_id=candidate.id))',
    'coalesce((select g.category_id from app_security.ordinary_goods_sessions_v3 g where g.session_id=s.id),(select b.category_id from public.wearable_session_bindings_v1 b where b.session_id=s.id))',
    'elsif not app_security.ordinary_goods_available_v3(p_binding) and not exists(select 1 from public.wearable_release_v1',
    'if new_id is not null and p_binding is not null then
       if app_security.ordinary_goods_available_v3(p_binding) then
         insert into app_security.ordinary_goods_sessions_v3(session_id,category_id,revision)
           select new_id,g.category_id,g.revision from app_security.ordinary_goods_contracts_v3 g where g.category_id=p_binding;
       else
         insert into public.wearable_session_bindings_v1(session_id,category_id) values(new_id,p_binding);
       end if;
     end if;'
  ];
begin
  def := pg_catalog.pg_get_functiondef('app_security.impl_posting_session_core_v1(uuid,text,uuid,uuid)'::regprocedure);
  for i in 1..array_length(before_parts,1) loop
    if (length(def)-length(replace(def,before_parts[i],''))) <> length(before_parts[i]) then
      raise exception 'POSTING_SESSION_CORE_DRIFT';
    end if;
    def := replace(def,before_parts[i],after_parts[i]);
  end loop;
  execute def;
end $$;

create function app_security.ordinary_goods_actor_v3()
returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := app_security.posting_v2_actor();
begin
  if pg_catalog.to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') is null then
    raise exception using errcode='42501',message='ORDINARY_GOODS_CONTRACT_UNAVAILABLE';
  end if;
  perform app_security.enforce_verified_actor(u,true);
  return u;
end $$;

create function app_security.ordinary_goods_session_v3(p_slug text,p_id uuid,p_operation text,p_media uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare g app_security.ordinary_goods_contracts_v3; u uuid := app_security.ordinary_goods_actor_v3();
begin
  select * into g from app_security.ordinary_goods_contracts_v3 where slug=p_slug for share;
  if not app_security.ordinary_goods_available_v3(g.category_id)
    or p_operation is null or p_operation not in ('create','read','reserve','remove','abandon_empty')
    or p_id is null then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
  if (p_operation <> 'create' or exists(select 1 from public.posting_upload_sessions where id=p_id and owner_id=u)) and not exists (
    select 1 from app_security.ordinary_goods_sessions_v3 b join public.posting_upload_sessions s on s.id=b.session_id
    where b.session_id=p_id and b.category_id=g.category_id and b.revision=g.revision and s.owner_id=u
  ) then raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE'; end if;
  return app_security.impl_posting_session_core_v1(p_id,p_operation,p_media,g.category_id);
end $$;

create function public.ordinary_goods_session_v3(slug text,session_id uuid,operation text,media_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$
  select app_security.ordinary_goods_session_v3(slug,session_id,operation,media_id)
$$;

create function app_security.validate_ordinary_goods_v3(
  p_category uuid,p_title text,p_description text,p_condition text,p_price_type text,p_price integer,p_answers jsonb
) returns void language plpgsql security definer set search_path='' as $$
declare g app_security.ordinary_goods_contracts_v3; f jsonb; k text; v jsonb; t text;
begin
  select * into strict g from app_security.ordinary_goods_contracts_v3 where category_id=p_category;
  if length(btrim(coalesce(p_title,''))) not between 3 and 120
    or length(btrim(coalesce(p_description,''))) not between 10 and 2000
    or p_condition is null or p_condition not in ('new','like_new','good','fair','poor')
    or p_price_type is null or p_price_type not in ('fixed','negotiable','free')
    or p_price is null or (p_price_type='free' and p_price<>0)
    or (p_price_type<>'free' and p_price not between 100 and 100000000)
    or jsonb_typeof(p_answers) is distinct from 'object'
    or p_answers->'safety_confirmed' is distinct from 'true'::jsonb
    or p_answers->'power_safe' is distinct from 'true'::jsonb
    or jsonb_typeof(p_answers->'defects') is distinct from 'string'
    or length(p_answers->>'defects')>500
    or (p_condition in ('fair','poor') and length(btrim(p_answers->>'defects'))<5)
  then raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_DETAILS'; end if;

  for k,v in select * from jsonb_each(p_answers) loop
    if k in ('safety_confirmed','power_safe','defects') then continue; end if;
    if not exists(select 1 from jsonb_array_elements(g.fields) x where x->>'key'=k) then
      raise exception using errcode='22023',message='ORDINARY_GOODS_UNKNOWN_FIELD';
    end if;
  end loop;
  for f in select * from jsonb_array_elements(g.fields) loop
    v := p_answers->(f->>'key');
    if v is null and not (f->>'required')::boolean then continue; end if;
    if f->>'kind'='number' then
      if jsonb_typeof(v) is distinct from 'number' or (v #>> '{}')::numeric not between (f->>'min')::numeric and (f->>'max')::numeric then
        raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_FIELD';
      end if;
    elsif jsonb_typeof(v) is distinct from 'string' or length(btrim(v #>> '{}')) not between 1 and 100 then
      raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_FIELD';
    end if;
  end loop;

  t := pg_catalog.normalize(concat_ws(' ',p_title,p_description,
    (select string_agg(value,' ') from jsonb_each_text(p_answers))), 'NFKC');
  perform app_security.phone_content_guard(t);
  if t ~* '(https?://|www\.|scan.{0,25}qr|upi[[:space:]]+pin|share.{0,15}otp|\m(firearms?|ammunition|explosives?|narcotics?|counterfeit|stolen|recalled|vape|prescription|ivory|pesticide|fireworks?|liquor)\M|live[[:space:]]+(animals?|dogs?|cats?|fish)|pupp(y|ies).{0,15}for sale|child.{0,10}car seats?|swollen.{0,15}batter|batter.{0,15}swollen|exposed.{0,15}wir|electric.{0,15}shock|leak.{0,15}batter)' then
    raise exception using errcode='22023',message='ORDINARY_GOODS_BLOCKED_CONTENT';
  end if;
end $$;

-- The validated request is frozen before objects are copied. Retries must
-- present the same JSON and can only promote the matching owned session.
create function app_security.ordinary_goods_prepare_v3(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_security.ordinary_goods_actor_v3(); g app_security.ordinary_goods_contracts_v3;
  s public.posting_upload_sessions; b app_security.ordinary_goods_sessions_v3; ids uuid[];
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or not (p_payload ?&
    array['slug','category_id','revision','session_id','title','description','condition','price_type','price_paise','answers','pin_code','city_id','locality_id','media_ids'])
    or p_payload-array['slug','category_id','revision','session_id','title','description','condition','price_type','price_paise','answers','pin_code','city_id','locality_id','media_ids'] <> '{}'::jsonb
    or jsonb_typeof(p_payload->'revision') is distinct from 'number'
    or jsonb_typeof(p_payload->'price_paise') is distinct from 'number'
    or jsonb_typeof(p_payload->'media_ids') is distinct from 'array'
    or exists(select 1 from unnest(array['slug','category_id','session_id','title','description','condition','price_type','pin_code','city_id','locality_id']) k
      where jsonb_typeof(p_payload->k) is distinct from 'string')
  then raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_REQUEST'; end if;
  select * into g from app_security.ordinary_goods_contracts_v3 where slug=p_payload->>'slug' for share;
  if not app_security.ordinary_goods_available_v3(g.category_id)
    or g.category_id is distinct from (p_payload->>'category_id')::uuid
    or g.revision is distinct from (p_payload->>'revision')::integer
  then raise exception using errcode='42501',message='ORDINARY_GOODS_CONTRACT_UNAVAILABLE'; end if;

  select * into s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
  select * into b from app_security.ordinary_goods_sessions_v3 where session_id=s.id for update;
  if b.category_id is distinct from g.category_id or b.revision is distinct from g.revision then
    raise exception using errcode='42501',message='UPLOAD_SESSION_UNAVAILABLE';
  end if;
  if b.frozen_payload is not null and b.frozen_payload is distinct from p_payload then
    raise exception using errcode='PT409',message='ORDINARY_GOODS_FROZEN_CONFLICT';
  end if;
  if s.state='submitted' then return jsonb_build_object('session',to_jsonb(s),'media','[]'::jsonb); end if;

  perform app_security.validate_ordinary_goods_v3(g.category_id,p_payload->>'title',p_payload->>'description',
    p_payload->>'condition',p_payload->>'price_type',(p_payload->>'price_paise')::integer,p_payload->'answers');
  if p_payload->>'pin_code' !~ '^[1-9][0-9]{5}$' or not exists (
    select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id
    join public.cities c on c.id=l.city_id where p.pincode=p_payload->>'pin_code'
    and l.id=(p_payload->>'locality_id')::uuid and c.id=(p_payload->>'city_id')::uuid and l.is_active and c.is_active
  ) then raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_LOCATION'; end if;
  if jsonb_array_length(p_payload->'media_ids') not between 1 and 8 then
    raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_MEDIA';
  end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(p_payload->'media_ids');
  if (select count(distinct x) from unnest(ids) x) <> cardinality(ids)
    or (select count(*) from public.posting_staged_media m where m.session_id=s.id and m.state<>'removed') <> cardinality(ids)
    or (select count(*) from public.posting_staged_media m where m.session_id=s.id and m.state='ready' and m.id=any(ids)) <> cardinality(ids)
  then raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_MEDIA'; end if;
  update app_security.ordinary_goods_sessions_v3 set frozen_payload=p_payload where session_id=s.id;
  return app_security.impl_posting_session_core_v1(s.id,'prepare',null,g.category_id);
end $$;

create function public.ordinary_goods_prepare_v3(payload jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select app_security.ordinary_goods_prepare_v3(payload)
$$;

create function app_security.ordinary_goods_submit_v3(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=app_security.ordinary_goods_actor_v3(); s public.posting_upload_sessions;
  m public.posting_staged_media; photo_id uuid; base text; pos integer:=0; result jsonb;
begin
  perform app_security.ordinary_goods_prepare_v3(p_payload);
  select * into strict s from public.posting_upload_sessions where id=(p_payload->>'session_id')::uuid and owner_id=u for update;
  if s.state='submitted' then return jsonb_build_object('success',true,'listing_id',s.listing_id); end if;
  if s.state<>'finalizing' or s.expires_at<=now() then raise exception 'UPLOAD_SESSION_UNAVAILABLE'; end if;
  insert into public.listings(id,seller_id,category_id,city_id,locality_id,pin_code,title,description,condition,price_type,price_paise,category_attributes)
  values(s.listing_id,u,(p_payload->>'category_id')::uuid,(p_payload->>'city_id')::uuid,(p_payload->>'locality_id')::uuid,
    p_payload->>'pin_code',btrim(p_payload->>'title'),btrim(p_payload->>'description'),
    (p_payload->>'condition')::public.listing_condition_enum,(p_payload->>'price_type')::public.listing_price_type_enum,
    (p_payload->>'price_paise')::integer,p_payload->'answers');
  for photo_id in select value::uuid from jsonb_array_elements_text(p_payload->'media_ids') loop
    select * into strict m from public.posting_staged_media where id=photo_id and session_id=s.id and state='ready' for update;
    base := s.listing_id::text||'/'||m.id::text||'/';
    if (select count(*) from storage.objects where (bucket_id='listing-originals' and name=base||'original.webp')
      or (bucket_id='listing-derivatives' and name in (base||'thumb.webp',base||'medium.webp',base||'large.webp'))) <> 4 then
      raise exception 'ORDINARY_GOODS_MEDIA_NOT_PREPARED';
    end if;
    insert into public.listing_media(id,listing_id,uploader_id,original_filename,content_type,file_size_bytes,display_order)
      values(m.id,s.listing_id,u,'photo.webp','image/webp',m.file_size,pos);
    update public.listing_media set original_storage_path=base||'original.webp',thumbnail_storage_path=base||'thumb.webp',
      medium_storage_path=base||'medium.webp',large_storage_path=base||'large.webp',width=m.width,height=m.height,processing_status='ready'
      where id=m.id;
    pos := pos+1;
  end loop;
  result := public.seller_submit_listing(s.listing_id);
  if result->>'success' is distinct from 'true' then raise exception 'ORDINARY_GOODS_SUBMISSION_UNACKNOWLEDGED'; end if;
  update public.posting_upload_sessions set state='submitted',submitted_at=now() where id=s.id;
  return jsonb_build_object('success',true,'listing_id',s.listing_id);
end $$;

create function public.ordinary_goods_submit_v3(payload jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select app_security.ordinary_goods_submit_v3(payload)
$$;

-- Preserve the Wearables wrapper and the installed provider-switching body.
-- A two-check result can still complete as staff review, but cannot publish Goods.
do $$
declare def text; needle text := 'IF v_is_restricted_category THEN';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'::regprocedure
  );
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    or pg_catalog.strpos(def,'v_is_five_check boolean')=0 then
    raise exception 'ORDINARY_GOODS_MODERATION_FINALIZER_DRIFT';
  end if;
  execute replace(def,needle,$patch$
  IF p_outcome='no_review_flags'
     AND EXISTS (SELECT 1 FROM app_security.ordinary_goods_contracts_v3 g WHERE g.category_id=v_listing.category_id)
     AND (NOT v_is_five_check OR NOT app_security.ordinary_goods_available_v3(v_listing.category_id)) THEN
    p_outcome := 'needs_review';
  END IF;

  IF v_is_restricted_category THEN$patch$);
end $$;

-- Runs after lifecycle triggers. Ordinary Goods cannot be assigned through
-- generic inserts/category swaps, or become public without a current clean scan.
create function app_security.ordinary_goods_listing_guard_v3()
returns trigger language plpgsql security definer set search_path='' as $$
declare g app_security.ordinary_goods_contracts_v3; b app_security.ordinary_goods_sessions_v3;
begin
  select * into g from app_security.ordinary_goods_contracts_v3 where category_id=new.category_id;
  if tg_op='INSERT' then
    select q.* into b from app_security.ordinary_goods_sessions_v3 q
      join public.posting_upload_sessions s on s.id=q.session_id where s.listing_id=new.id;
    if g.category_id is null and b.session_id is null then return new; end if;
    if g.category_id is null or b.category_id is distinct from g.category_id or b.revision is distinct from g.revision
      or b.frozen_payload is null or not exists(select 1 from public.posting_upload_sessions s
        where s.id=b.session_id and s.owner_id=new.seller_id and s.state='finalizing' and s.expires_at>now())
      or new.status <> 'draft'
      or row(new.title,new.description,new.city_id::text,new.locality_id::text,new.pin_code,new.condition::text,new.price_type::text,new.price_paise::text,new.category_attributes)
        is distinct from row(btrim(b.frozen_payload->>'title'),btrim(b.frozen_payload->>'description'),
          b.frozen_payload->>'city_id',b.frozen_payload->>'locality_id',b.frozen_payload->>'pin_code',
          b.frozen_payload->>'condition',b.frozen_payload->>'price_type',b.frozen_payload->>'price_paise',b.frozen_payload->'answers')
    then raise exception using errcode='42501',message='ORDINARY_GOODS_BOUND_SESSION_REQUIRED'; end if;
  else
    if new.category_id is distinct from old.category_id and (g.category_id is not null or exists (
      select 1 from app_security.ordinary_goods_contracts_v3 where category_id=old.category_id
    )) then raise exception using errcode='42501',message='ORDINARY_GOODS_CATEGORY_IMMUTABLE'; end if;
    if g.category_id is null then return new; end if;
    if new.seller_id is distinct from old.seller_id and new.seller_id is not null then
      raise exception using errcode='42501',message='ORDINARY_GOODS_OWNER_IMMUTABLE';
    end if;
    if row(new.status,new.revision,new.title,new.description,new.city_id,new.locality_id,new.pin_code,new.landmark,new.condition,new.price_type,new.price_paise,new.category_attributes)
      is not distinct from row(old.status,old.revision,old.title,old.description,old.city_id,old.locality_id,old.pin_code,old.landmark,old.condition,old.price_type,old.price_paise,old.category_attributes)
    then return new; end if;
    if new.status not in ('draft','pending_review','active','reserved') then return new; end if;
  end if;

  if not app_security.ordinary_goods_available_v3(g.category_id) then
    raise exception using errcode='42501',message='ORDINARY_GOODS_CONTRACT_UNAVAILABLE';
  end if;
  perform app_security.validate_ordinary_goods_v3(g.category_id,new.title,new.description,new.condition::text,
    new.price_type::text,new.price_paise,new.category_attributes);
  if new.pin_code is null or new.pin_code !~ '^[1-9][0-9]{5}$' or not exists (
    select 1 from public.postal_pincode_localities p join public.localities l on l.id=p.locality_id
    join public.cities c on c.id=l.city_id where p.pincode=new.pin_code
      and l.id=new.locality_id and c.id=new.city_id and l.is_active and c.is_active
  ) or new.landmark is not null then
    raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_LOCATION';
  end if;
  if new.status in ('active','reserved') and not exists (
    select 1 from public.listing_moderation_results r
    join app_security.listing_moderation_scan_receipts s on s.request_id=r.request_id
      and s.listing_id=r.listing_id and s.listing_revision=r.listing_revision and s.generation_id=r.generation_id
    where r.listing_id=new.id and r.listing_revision=new.revision and r.decision='auto_approved'
      and r.outcome='no_review_flags' and cardinality(r.failed_rules)=0
      and s.verdict='APPROVE' and s.consumed and cardinality(s.failed_checks)=0
      and jsonb_array_length(s.flags)=0
      and s.completed_checks @> array['check_india_fraud_rules','check_openai_moderation','check_vision_nsfw','check_vision_category','check_ocr_qr']
      and s.scanned_media_count>0
      and s.scanned_media_count=(select count(*) from public.listing_media where listing_id=new.id)
      and not exists(select 1 from public.listing_media m where m.listing_id=new.id and
        (m.processing_status is distinct from 'ready' or not exists (
          select 1 from jsonb_array_elements(s.manifest) j
          where j->>'id'=m.id::text and j->>'path'=m.original_storage_path
            and exists(select 1 from app_security.listing_media_verified_hashes h
              where h.media_id=m.id and h.listing_id=new.id and h.generation_id=s.generation_id
                and h.content_sha256=j->>'sha256')
        )))
  ) then raise exception using errcode='42501',message='ORDINARY_GOODS_CURRENT_CLEAN_SCAN_REQUIRED'; end if;
  return new;
end $$;

create trigger ordinary_goods_listing_guard_v3 after insert or update on public.listings
for each row execute function app_security.ordinary_goods_listing_guard_v3();

revoke all on function app_security.ordinary_goods_available_v3(uuid),
  app_security.ordinary_goods_actor_v3(),
  app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb),
  app_security.ordinary_goods_listing_guard_v3(),
  app_security.ordinary_goods_read_v3(text),public.ordinary_goods_v3(text),
  app_security.ordinary_goods_session_v3(text,uuid,text,uuid),public.ordinary_goods_session_v3(text,uuid,text,uuid),
  app_security.ordinary_goods_prepare_v3(jsonb),public.ordinary_goods_prepare_v3(jsonb),
  app_security.ordinary_goods_submit_v3(jsonb),public.ordinary_goods_submit_v3(jsonb)
from public,anon,authenticated,service_role;
grant execute on function app_security.ordinary_goods_read_v3(text),public.ordinary_goods_v3(text),
  app_security.ordinary_goods_session_v3(text,uuid,text,uuid),public.ordinary_goods_session_v3(text,uuid,text,uuid),
  app_security.ordinary_goods_prepare_v3(jsonb),public.ordinary_goods_prepare_v3(jsonb),
  app_security.ordinary_goods_submit_v3(jsonb),public.ordinary_goods_submit_v3(jsonb)
to authenticated;
commit;
