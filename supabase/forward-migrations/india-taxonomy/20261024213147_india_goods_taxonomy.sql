-- Forward-only candidate for Test and Production; never add to the immutable 58.
-- Disabled seed only. Deploy compatible Web before the separate activation.
-- No family release gates, existing category IDs, attributes or listings change.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

do $taxonomy$
declare
  item record;
  category_id uuid;
begin
  lock table public.categories in share row exclusive mode;
  lock table public.category_attributes in share row exclusive mode;
  -- Stop on drift rather than creating a parallel identity or adopting an
  -- unknown contract. The operator must reconcile any existing equivalent.
  for item in select * from (values
    ('fashion-men','Men — Clothing & Footwear','Clothing and footwear for men','shirt',110),
    ('fashion-women','Women — Clothing & Footwear','Clothing and footwear for women','shirt',111),
    ('fashion-kids','Kids — Clothing & Footwear','Children’s clothing and footwear; not baby equipment','shirt',112),
    ('fashion-watches','Watches','Analog, digital and branded watches','watch',113),
    ('fashion-accessories','Sunglasses & Accessories','Sunglasses, belts, wallets, bags and caps','shirt',114),
    ('strollers-prams','Strollers & Prams','Strollers, prams and pushchairs','baby',120),
    ('baby-furniture','Cribs, Cots & Baby Furniture','Cribs, cots, cradles and baby furniture','armchair',121),
    ('baby-gear','Baby Gear & Accessories','Baby carriers and accessories; excludes car seats','baby',122),
    ('toys-games','Toys & Games','Children’s toys, board games and puzzles','puzzle',123),
    ('school-essentials','School Bags & Kids Essentials','School bags, lunch boxes and children’s essentials; clothing belongs in Fashion','backpack',124),
    ('tvs-video','TVs & Video','Televisions and video equipment','tv',130),
    ('audio-home-theatre','Audio & Home Theatre','Headphones, earbuds, speakers, soundbars and amplifiers','speaker',131),
    ('power-backup-solar','Power Backup & Solar','Inverters, UPS, batteries and solar equipment','battery',132),
    ('other-home-appliances','Other Home Appliances','Fans, geysers, water purifiers, RO systems and sewing machines','refrigerator',133),
    ('kitchenware-utensils','Kitchenware & Utensils','Cookware, steel utensils, dishes, storage containers and non-electrical kitchen goods','utensils',140)
  ) as v(slug,name,description,icon,sort_order)
  loop
    if exists(select 1 from public.categories c where c.slug=item.slug or lower(c.name)=lower(item.name)) then
      raise exception 'INDIA_TAXONOMY_IDENTITY_CONFLICT: %; reconcile existing category before release',item.slug;
    end if;
    insert into public.categories(slug,name,description,icon,sort_order,macro_category,new_listing_enabled,is_active)
      values(item.slug,item.name,item.description,item.icon,item.sort_order,'goods',false,false)
      returning id into category_id;
    insert into public.category_attributes(category_id,name,label,value_type,is_required,is_filterable,validation_rules,sort_order)
      values(category_id,'item_type','Item type / वस्तु का प्रकार','text',true,false,'{"contract":"india_goods_v1","max_length":100}',1),
            (category_id,'brand','Brand / ब्रांड','text',false,false,'{"contract":"india_goods_v1","max_length":100}',2);
  end loop;
end $taxonomy$;

-- AFTER ROW observes the final row from ALL BEFORE triggers, regardless of
-- their names/order on Test or Production. Exceptions roll back the statement,
-- including transactional moderation/transition side effects. Never rewrite NEW
-- or disable lifecycle/moderation triggers to make validation pass.
-- Runs for direct writes, seller RPCs, staff decisions and worker publication.
-- Existing RLS/column grants still authorize the actor; this never grants access.
create function app_security.india_goods_listing_guard()
returns trigger language plpgsql security definer set search_path='' as $guard$
declare
  category public.categories%rowtype;
  answer record;
  assigning boolean;
begin
  select * into category from public.categories where id=new.category_id and slug in (
    'fashion-men','fashion-women','fashion-kids','fashion-watches','fashion-accessories',
    'strollers-prams','baby-furniture','baby-gear','toys-games','school-essentials',
    'tvs-video','audio-home-theatre','power-backup-solar','other-home-appliances','kitchenware-utensils'
  ) for share;
  if not found then return null; end if;
  assigning := tg_op='INSERT';
  if tg_op='UPDATE' then assigning := new.category_id is distinct from old.category_id; end if;
  if (assigning or new.status::text in ('pending_review','active','reserved')) and
     (not category.is_active or not category.new_listing_enabled or category.macro_category is distinct from 'goods') then
    raise exception using errcode='23514',message='INDIA_GOODS_CATEGORY_UNAVAILABLE';
  end if;
  if pg_catalog.jsonb_typeof(new.category_attributes) is distinct from 'object' then
    raise exception using errcode='23514',message='INDIA_GOODS_INVALID_ANSWERS';
  end if;
  for answer in select key,value from pg_catalog.jsonb_each(new.category_attributes) loop
    if answer.key not in ('item_type','brand') or pg_catalog.jsonb_typeof(answer.value)<>'string'
       or pg_catalog.length(answer.value #>> '{}')>100 then
      raise exception using errcode='23514',message='INDIA_GOODS_INVALID_ANSWERS';
    end if;
  end loop;
  -- Drafts may be incomplete. Publication/review require a meaningful item type.
  if new.status::text in ('pending_review','active','reserved') and
     pg_catalog.length(pg_catalog.btrim(coalesce(new.category_attributes->>'item_type','')))=0 then
    raise exception using errcode='23514',message='INDIA_GOODS_ITEM_TYPE_REQUIRED';
  end if;
  return null;
end $guard$;
revoke all on function app_security.india_goods_listing_guard() from public,anon,authenticated,service_role;
create trigger india_goods_listing_guard after insert or update on public.listings
  for each row execute function app_security.india_goods_listing_guard();

-- No Other, car-seat, exempt-EV or commercial-property identities are enabled:
-- their authoritative safety/reclassification/form contracts are not ready.
-- Existing categories/attributes SELECT RLS and denied client DML remain intact.
commit;
