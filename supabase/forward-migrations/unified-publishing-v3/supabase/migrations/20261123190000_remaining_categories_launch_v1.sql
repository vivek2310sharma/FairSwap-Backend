begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

alter table app_security.ordinary_goods_contracts_v3
  drop constraint goods_v3_draft_check,
  drop constraint goods_v3_flow_check,
  drop constraint goods_v3_macro_check;

update app_security.ordinary_goods_contracts_v3
  set draft_only = false
  where slug in ('v2-commercial-vehicles','v2-electric-cycles-low-speed-evs');

alter table app_security.ordinary_goods_contracts_v3
  add constraint goods_v3_draft_check check (
    draft_only = (slug in ('v2-cars','v2-motorcycles-scooters'))
  ),
  add constraint goods_v3_flow_check check (
    posting_flow in ('generic','accessory')
    or (posting_flow='adoption_rehoming' and macro_category='goods' and slug in ('v2-dogs','v2-other-pets'))
    or (posting_flow='property' and macro_category='property')
    or (macro_category='vehicles' and draft_only and
      ((slug='v2-cars' and posting_flow='specialist:car') or
       (slug='v2-motorcycles-scooters' and posting_flow='specialist:two_wheeler')))
  ),
  add constraint goods_v3_macro_check check (
    macro_category='goods'
    or (macro_category='vehicles' and moderation_mode='staff_intake'
      and (posting_flow='generic' or slug in ('v2-cars','v2-motorcycles-scooters'))
      and slug in ('v2-car-accessories-parts','v2-bicycles','v2-bike-accessories-parts',
        'v2-commercial-vehicles','v2-electric-cycles-low-speed-evs','v2-cars','v2-motorcycles-scooters'))
    or (macro_category='property' and posting_flow='property' and moderation_mode='staff_intake' and slug in
      ('v2-houses-apartments','v2-pg-hostels-guest-houses','v2-flatmates-shared-rooms','v2-shops-offices','v2-land-plots','v2-warehouses-godowns'))
  );

insert into app_security.ordinary_goods_contracts_v3
  (slug,parent_slug,category_id,risk,posting_flow,macro_category,moderation_mode,draft_only,enabled,fields) values
  ('v2-dogs','v2-pets-supplies','6e800b53-63b2-54a6-b153-6ed48a7bb549','general','adoption_rehoming','goods','staff_intake',false,true,
   '[{"key":"pet_type","label":"Adoption type","required":true,"kind":"text","choices":["Dog adoption","Puppy adoption"]},{"key":"breed","label":"Breed or mix","required":true,"kind":"text"},{"key":"age","label":"Age","required":true,"kind":"text"},{"key":"health_status","label":"Vaccination and health status","required":true,"kind":"text"},{"key":"rehoming_reason","label":"Reason for rehoming","required":true,"kind":"text"},{"key":"adoption_terms","label":"Adoption terms","required":true,"kind":"text","choices":["Free adoption to a caring home"]}]'::jsonb),
  ('v2-other-pets','v2-pets-supplies','0eab6fd4-2967-58e4-80a4-983dedd41170','general','adoption_rehoming','goods','staff_intake',false,true,
   '[{"key":"species","label":"Permitted species","required":true,"kind":"text","choices":["Cat / Kitten","Rabbit","Guinea Pig","Hamster"]},{"key":"breed","label":"Breed or description","required":true,"kind":"text"},{"key":"age","label":"Age","required":true,"kind":"text"},{"key":"health_status","label":"Vaccination and health status","required":true,"kind":"text"},{"key":"rehoming_reason","label":"Reason for rehoming","required":true,"kind":"text"},{"key":"adoption_terms","label":"Adoption terms","required":true,"kind":"text","choices":["Free adoption to a caring home"]}]'::jsonb);

update app_security.ordinary_goods_contracts_v3
set enabled = true
where slug in (
  'v2-baby-gear-car-seats',
  'v2-bicycles',
  'v2-bike-accessories-parts',
  'v2-car-accessories-parts',
  'v2-commercial-vehicles',
  'v2-electric-cycles-low-speed-evs',
  'v2-land-plots',
  'v2-other-items',
  'v2-shops-offices',
  'v2-warehouses-godowns'
);

update public.categories
set status = 'live', is_active = true
where slug in (
  'v2-baby-gear-car-seats',
  'v2-bicycles',
  'v2-bike-accessories-parts',
  'v2-car-accessories-parts',
  'v2-commercial-vehicles',
  'v2-electric-cycles-low-speed-evs',
  'v2-land-plots',
  'v2-other-items',
  'v2-shops-offices',
  'v2-warehouses-godowns',
  'v2-dogs',
  'v2-other-pets'
);

create or replace function app_security.ordinary_goods_available_v3(p_category uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists (
    select 1 from app_security.ordinary_goods_contracts_v3 g
    join public.categories c on c.id=g.category_id and c.slug=g.slug
    join public.categories p on p.id=c.parent_id and p.slug=g.parent_slug
    where g.category_id=p_category and g.enabled and not g.draft_only
      and c.posting_flow=g.posting_flow and c.macro_category=g.macro_category
      and c.status='live' and c.is_active and not c.new_listing_enabled
      and p.status='live' and p.is_active
      and (
        (g.macro_category='goods')
        or app_security.v3_seller_identity_enforced()
      )
  );
$$;
revoke all on function app_security.ordinary_goods_available_v3(uuid) from public,anon,authenticated,service_role;

create or replace function app_security.bounded_goods_staff_intake_guard_v3()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status in ('active','reserved') and exists (
    select 1 from app_security.ordinary_goods_contracts_v3 g where g.category_id=new.category_id
      and g.moderation_mode='staff_intake'
  ) and not app_security.is_active_staff_aal2('moderator') then
    raise exception using errcode='42501',message='GOODS_STAFF_INTAKE_PUBLICATION_DISABLED';
  end if;
  return new;
end $$;
revoke all on function app_security.bounded_goods_staff_intake_guard_v3() from public,anon,authenticated,service_role;

do $$
declare def text;
  needle text := 'g.macro_category=''goods'' and g.slug not in (''v2-baby-gear-car-seats'',''v2-other-items'')';
  review_needle text := $rn$r.decision='auto_approved'
      and r.outcome='no_review_flags'$rn$;
begin
  def := pg_catalog.pg_get_functiondef('app_security.ordinary_goods_listing_guard_v3()'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then
    raise exception 'V3_LISTING_GUARD_NEEDLE_DRIFT';
  end if;
  if (length(def)-length(replace(def,review_needle,''))) <> length(review_needle) then
    raise exception 'V3_LISTING_GUARD_REVIEW_NEEDLE_DRIFT';
  end if;
  def := replace(def, needle, 'g.macro_category=''goods''');
  def := replace(def, review_needle,
    '((g.moderation_mode is distinct from ''staff_intake'' and r.decision=''auto_approved'' and r.outcome=''no_review_flags'')' ||
    ' or (g.moderation_mode=''staff_intake'' and app_security.is_active_staff_aal2(''moderator'')))');
  execute def;
end $$;

do $$
declare def text;
  needle text := 'select * into strict g from app_security.ordinary_goods_contracts_v3 where category_id=p_category;';
begin
  def := pg_catalog.pg_get_functiondef('app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then
    raise exception 'V3_VALIDATOR_NEEDLE_DRIFT';
  end if;
  execute replace(def, needle, needle || $pet_patch$
    if g.posting_flow='adoption_rehoming' then
      if p_price_type is distinct from 'free' or p_price is distinct from 0 then
        raise exception using errcode='22023',message='PET_REHOMING_FREE_ONLY';
      end if;
      p_condition := 'good';
    end if;
  $pet_patch$);
end $$;

do $$
declare def text;
  needle text := 'perform app_security.phone_content_guard(t);';
begin
  def := pg_catalog.pg_get_functiondef('app_security.validate_ordinary_goods_v3(uuid,text,text,text,text,integer,jsonb)'::regprocedure);
  if (length(def)-length(replace(def,needle,''))) <> length(needle) then
    raise exception 'V3_VALIDATOR_CONTENT_GUARD_DRIFT';
  end if;
  execute replace(def, needle, needle || $content_guard_patch$
    if g.posting_flow='adoption_rehoming' then
      if t ~* '(\m(sale|selling|price|stud|breeder|breeding|charge|fee|cost|paid)\M|for[[:space:]]+sale|paid[[:space:]]+(transfer|adoption)|pupp(y|ies).{0,15}for sale|kittens?.{0,15}for sale)' then
        raise exception using errcode='22023',message='PET_REHOMING_COMMERCIAL_FORBIDDEN';
      end if;
      if t ~* '(\m(snake|reptile|lizard|turtle|tortoise|parrot|macaw|cockatoo|owl|eagle|falcon|monkey|primate|wildlife|exotic|cites|schedule[[:space:]]+(i|ii))\M)' then
        raise exception using errcode='22023',message='PET_REHOMING_SPECIES_FORBIDDEN';
      end if;
    elsif t ~* '(live[[:space:]]+(animals?|dogs?|cats?|fish)|pupp(y|ies).{0,15}for sale)' then
      raise exception using errcode='22023',message='ORDINARY_GOODS_BLOCKED_CONTENT';
    end if;
    if g.macro_category='property' and t ~* '(\m(verified owner|verified landlord|government approved|rera approved|approved by rera|verified title|verified property|clear title guaranteed)\M|(flat|unit|door|house|shop|office|plot|godown|warehouse|building|khasra|survey)[[:space:]]*(no[.]?|number|#)[[:space:]]*[a-z0-9]+)' then
      raise exception using errcode='22023',message='PROPERTY_PRIVATE_OR_UNVERIFIED_CONTENT';
    end if;
    if g.slug='v2-baby-gear-car-seats' and t ~* '(child.{0,10}car seats?|recalled|drop-side|drop side crib)' then
      raise exception using errcode='22023',message='ORDINARY_GOODS_BLOCKED_CONTENT';
    end if;
  $content_guard_patch$);
end $$;

commit;
