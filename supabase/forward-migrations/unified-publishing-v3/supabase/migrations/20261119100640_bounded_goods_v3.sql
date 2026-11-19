begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table app_security.ordinary_goods_contracts_v3
  add column posting_flow text not null default 'generic' check (posting_flow in ('generic','accessory')),
  add column moderation_mode text not null default 'five_check' check (moderation_mode in ('five_check','staff_intake'));

insert into app_security.ordinary_goods_contracts_v3 (slug,parent_slug,category_id,risk,posting_flow,fields) values
  ('v2-headphones-earbuds','v2-mobiles-tablets','a0ec60da-f8ef-5b00-bb77-f9d801022c02','electronics','accessory','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Wired headphones","Wireless headphones","Wired earbuds","Wireless earbuds"]},{"key":"brand","label":"Brand","required":true,"kind":"text"},{"key":"model","label":"Model","required":true,"kind":"text"},{"key":"compatibility","label":"Connection and compatible devices","required":true,"kind":"text"}]'::jsonb),
  ('v2-mobile-tablet-accessories','v2-mobiles-tablets','a190b604-cd48-536e-ab0e-aaf62b263399','electrical','accessory','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Case","Screen protector","Stand","Cable","Charger","Power bank"]},{"key":"brand","label":"Brand","required":true,"kind":"text"},{"key":"model","label":"Model","required":true,"kind":"text"},{"key":"compatibility","label":"Compatible phone or tablet models","required":true,"kind":"text"},{"key":"authenticity","label":"Authenticity","required":true,"kind":"text","choices":["Original manufacturer","Third-party compatible"]}]'::jsonb),
  ('v2-strollers-prams','v2-kids-baby','764c31c7-df3f-5bac-a3f2-1b56e7baabb2','general','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Stroller","Pram"]},{"key":"model","label":"Make and model","required":true,"kind":"text"},{"key":"brakes","label":"Brakes","required":true,"kind":"text","choices":["Working"]},{"key":"folding","label":"Folding","required":true,"kind":"text","choices":["Locks securely"]},{"key":"included","label":"Included parts and wear","required":true,"kind":"text"}]'::jsonb),
  ('v2-cribs-cots-kids-furniture','v2-kids-baby','9bfe17ce-5eb0-5d4c-973f-23ad120e24e3','general','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Crib","Cot","Kids table","Kids chair"]},{"key":"model","label":"Make and model","required":true,"kind":"text"},{"key":"structure","label":"Structure","required":true,"kind":"text","choices":["Stable and complete"]},{"key":"included","label":"Included parts and fixings","required":true,"kind":"text"}]'::jsonb),
  ('v2-baby-gear-car-seats','v2-kids-baby','50287b21-0995-5699-94f9-4f2651a94ec5','general','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Baby bath","Changing mat"]},{"key":"model","label":"Make and model","required":true,"kind":"text"},{"key":"included","label":"Included parts","required":true,"kind":"text"}]'::jsonb),
  ('v2-toys-games','v2-kids-baby','5fd8809e-19aa-5310-851a-707e033e1baa','general','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Board game","Puzzle","Building toy","Soft toy"]},{"key":"age","label":"Manufacturer age guidance","required":true,"kind":"text"},{"key":"included","label":"Included parts","required":true,"kind":"text"},{"key":"safety","label":"Safety","required":true,"kind":"text","choices":["Complete and undamaged"]}]'::jsonb),
  ('v2-school-bags-kids-essentials','v2-kids-baby','130863d9-8eeb-5e5a-ad1f-b53f33d7da29','general','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["School bag","Pencil case","Lunch bag"]},{"key":"size","label":"Size or capacity","required":true,"kind":"text"},{"key":"included","label":"Included contents","required":true,"kind":"text"}]'::jsonb),
  ('v2-pet-food-accessories','v2-pets-supplies','5402e408-0bc6-5370-979d-6391b03216c3','general','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Leash","Collar","Pet bed","Bowl","Carrier"]},{"key":"size","label":"Size and intended pet","required":true,"kind":"text"}]'::jsonb),
  ('v2-aquariums-fish-supplies','v2-pets-supplies','43f09356-8d1c-5a4c-b52d-3ac989a4e034','electrical','generic','[{"key":"item_type","label":"Item type","required":true,"kind":"text","choices":["Empty tank","Filter","Pump","Tank light","Tank decoration"]},{"key":"model","label":"Make and model","required":true,"kind":"text"},{"key":"capacity","label":"Dimensions or rated capacity","required":true,"kind":"text"}]'::jsonb),
  ('v2-other-items','v2-other','66ec1796-5103-5c9c-87e1-cfdd3774365b','general','generic','[{"key":"item_type","label":"Specific item name","required":true,"kind":"text"},{"key":"purpose","label":"Intended ordinary household use","required":true,"kind":"text"}]'::jsonb);

do $$
begin
  if (select count(*) from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug and c.posting_flow=g.posting_flow
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.slug in ('v2-headphones-earbuds','v2-mobile-tablet-accessories','v2-strollers-prams','v2-cribs-cots-kids-furniture','v2-baby-gear-car-seats','v2-toys-games','v2-school-bags-kids-essentials','v2-pet-food-accessories','v2-aquariums-fish-supplies','v2-other-items')
      and not c.is_active and c.status='coming_soon' and not c.new_listing_enabled and c.macro_category='goods') <> 10
  then raise exception 'BOUNDED_GOODS_TAXONOMY_DRIFT'; end if;
end $$;

create or replace function app_security.ordinary_goods_available_v3(p_category uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.category_id=p_category and g.enabled and c.posting_flow=g.posting_flow
      and g.slug not in ('v2-baby-gear-car-seats','v2-other-items')
      and c.macro_category='goods' and c.status='live' and c.is_active
      and not c.new_listing_enabled and p.status='live' and p.is_active
  )
$$;

-- Preserve the existing receipt gate. Intake-only leaves cannot publish even
-- if a provider is subsequently enabled or a staff approval is attempted.
create function app_security.bounded_goods_staff_intake_guard_v3()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('active','reserved') and exists (
    select 1 from app_security.ordinary_goods_contracts_v3 g where g.category_id=new.category_id
      and g.moderation_mode='staff_intake'
  ) then raise exception using errcode='42501',message='GOODS_STAFF_INTAKE_PUBLICATION_DISABLED'; end if;
  return new;
end $$;
revoke all on function app_security.bounded_goods_staff_intake_guard_v3() from public,anon,authenticated,service_role;
create trigger bounded_goods_staff_intake_guard_v3 after insert or update of status,category_id on public.listings
  for each row execute function app_security.bounded_goods_staff_intake_guard_v3();

do $$
declare def text;
  needle text := 'NOT v_is_five_check OR NOT app_security.ordinary_goods_available_v3(v_listing.category_id)';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'BOUNDED_GOODS_FINALIZER_DRIFT'; end if;
  execute replace(def,needle,needle || ' OR EXISTS (SELECT 1 FROM app_security.ordinary_goods_contracts_v3 g
    WHERE g.category_id=v_listing.category_id AND g.moderation_mode=''staff_intake'')');
end $$;

do $$
declare def text;
  needle text := 'v := p_answers->(f->>''key'');';
begin
  def := pg_catalog.pg_get_functiondef(
    'app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle)
    then raise exception 'BOUNDED_GOODS_VALIDATOR_DRIFT'; end if;
  execute replace(def,needle,needle || $patch$
    if f ? 'choices' and v is not null and not ((f->'choices') @> jsonb_build_array(v)) then
      raise exception using errcode='22023',message='ORDINARY_GOODS_INVALID_FIELD';
    end if;
  $patch$);
end $$;
commit;
