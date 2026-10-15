-- FairSwapTest submission V1. Source contracts remain immutable; Goods is untouched.
-- Activation is separate and defaults OFF. No public approval permission is granted.
begin;
create table app_security.test_submission_policies (
  family text primary key check (family in ('two-wheelers','cars','property')),
  policy_key text not null default 'test-submission-v1',
  contract_key text not null,
  definition_hash text not null,
  requirements jsonb not null,
  enabled boolean not null default false,
  maintenance boolean not null default false
);
alter table app_security.test_submission_policies enable row level security;
revoke all on app_security.test_submission_policies from public,anon,authenticated,service_role;
create function app_security.test_submission_policy_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if (to_jsonb(new)-'enabled'-'maintenance') is distinct from (to_jsonb(old)-'enabled'-'maintenance') then raise exception 'Test submission policy/version facts are immutable'; end if;
 return new;
end $$;
revoke all on function app_security.test_submission_policy_immutable() from public,anon,authenticated,service_role;
create trigger test_submission_policy_immutable before update on app_security.test_submission_policies for each row execute function app_security.test_submission_policy_immutable();
insert into app_security.test_submission_policies(family,contract_key,definition_hash,requirements)
select 'two-wheelers',contract_key,md5(definition::text),'{"model":"catalogue/unresolved/not_listed; no Upcoming or incompatible fallback","year":"known/unknown","km_driven":"known/unknown; zero valid","photos":"at least one ready; maximum eight","publication":"blocked","amounts":"existing Test item constraints only"}'::jsonb from public.vehicle_contract_versions where contract_key='two-wheeler-draft-v1'
union all select 'cars',contract_key,md5(definition::text),'{"model":"catalogue/unresolved/not_listed; import_only allowed into review","year":"known/unknown","km_driven":"known/unknown; zero valid","applicable_declarations":"fuel_type/transmission/powertrain known/unknown","photos":"at least one ready; maximum eight","publication":"blocked","amounts":"existing Test item constraints only"}'::jsonb from public.car_contract_versions where contract_key='cars-draft-v1'
union all select 'property',contract_key,md5(definition::text),'{"rent":"known positive monthly INR, compatible explicit basis; no rent on request","deposit":"optional; explicit zero valid","maintenance":"optional; separate amount/period/basis preserved","photos":"at least one ready; maximum eight","publication":"blocked","amounts":"existing exact paise technical constraints only"}'::jsonb from public.property_contract_versions where contract_key='property-rental-draft-v1';
do $$ begin if (select count(*) from app_security.test_submission_policies)<>3 then raise exception 'Supported submission contracts missing'; end if; end $$;

-- A private transaction-scoped permit, never a caller-settable session flag.
create table app_security.test_submission_permits (
  listing_id uuid not null, transaction_id bigint not null, operation text not null check(operation in ('submit','worker')),
  primary key(listing_id,transaction_id)
);
alter table app_security.test_submission_permits enable row level security;
revoke all on app_security.test_submission_permits from public,anon,authenticated,service_role;

create function app_security.submission_family(lid uuid,cid uuid) returns text
language sql stable security definer set search_path='' as $$
 select case
 when exists(select 1 from public.property_category_contracts where category_id=cid) or exists(select 1 from public.listing_property_contexts where listing_id=lid) then 'property'
 when exists(select 1 from public.car_category_contracts where category_id=cid) or exists(select 1 from public.listing_car_contexts where listing_id=lid) then 'cars'
 when exists(select 1 from public.vehicle_category_contracts where category_id=cid) or exists(select 1 from public.listing_vehicle_contexts where listing_id=lid) then 'two-wheelers' end
$$;
revoke all on function app_security.submission_family(uuid,uuid) from public,anon,authenticated,service_role;

create function app_security.test_submission_lifecycle() returns trigger
language plpgsql security definer set search_path='' as $$
declare family text; permitted text;
begin
 family:=app_security.submission_family(case when tg_op='DELETE' then old.id else new.id end,case when tg_op='DELETE' then old.category_id else new.category_id end);
 if family is null then return case when tg_op='DELETE' then old else new end; end if;
 if tg_op='DELETE' then
  if old.status<>'draft' then raise exception using errcode='42501',message='Awaiting review is read-only'; end if;
  return old;
 end if;
 if tg_op='INSERT' then
  if new.status<>'draft' then raise exception using errcode='42501',message='New-family listings must start as drafts'; end if;
  return new;
 end if;
 select operation into permitted from app_security.test_submission_permits where listing_id=old.id and transaction_id=txid_current();
 if old.status='draft' and new.status='draft' then
  -- Every listing/context/media change advances this scoped saved identity.
  new.revision:=old.revision+1;
 elsif old.status='draft' and new.status='pending_review' and permitted='submit' then
  new.revision:=old.revision+1;
 elsif old.status='pending_review' and new.status='pending_review' and permitted='worker'
  and (to_jsonb(new)-'revision'-'updated_at'-'search_vector')=(to_jsonb(old)-'revision'-'updated_at'-'search_vector') then
  new.revision:=old.revision+1;
 else
  raise exception using errcode='42501',message='New-family pending edits, approval and publication are disabled';
 end if;
 return new;
end $$;
revoke all on function app_security.test_submission_lifecycle() from public,anon,authenticated,service_role;
create trigger z_0_test_submission_lifecycle before insert or update or delete on public.listings for each row execute function app_security.test_submission_lifecycle();

create function app_security.test_submission_child_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare lid uuid;l public.listings;permit text;
begin
 lid:=case when tg_op='DELETE' then old.listing_id else new.listing_id end;
 select * into l from public.listings where id=lid for update;
 if not found then return case when tg_op='DELETE' then old else new end; end if;
 if app_security.submission_family(l.id,l.category_id) is null then return case when tg_op='DELETE' then old else new end; end if;
 select operation into permit from app_security.test_submission_permits where listing_id=lid and transaction_id=txid_current();
 if l.status<>'draft' then
  if tg_table_name<>'listing_media' or tg_op<>'UPDATE' or permit is distinct from 'worker' then
   raise exception using errcode='42501',message='Awaiting review content and photos are read-only';
  end if;
  if (to_jsonb(new)-'processing_status'-'processing_error'-'original_storage_path'-'thumbnail_storage_path'-'medium_storage_path'-'large_storage_path'-'width'-'height')
    is distinct from (to_jsonb(old)-'processing_status'-'processing_error'-'original_storage_path'-'thumbnail_storage_path'-'medium_storage_path'-'large_storage_path'-'width'-'height')
    or old.processing_status not in ('uploading','processing') or new.processing_status not in ('processing','ready','failed') then
   raise exception using errcode='42501',message='Worker may only complete an accepted pending attachment';
  end if;
 end if;
 update public.listings set revision=revision+1 where id=lid;
 return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function app_security.test_submission_child_change() from public,anon,authenticated,service_role;
create trigger zz_test_submission_child before insert or update or delete on public.listing_vehicle_contexts for each row execute function app_security.test_submission_child_change();
create trigger zz_test_submission_child before insert or update or delete on public.listing_car_contexts for each row execute function app_security.test_submission_child_change();
create trigger zz_test_submission_child before insert or update or delete on public.listing_property_contexts for each row execute function app_security.test_submission_child_change();
create trigger zz_test_submission_child before insert or update or delete on public.listing_media for each row execute function app_security.test_submission_child_change();

-- Context updates use existing owner-checked save RPCs, which take the parent
-- lock first. Direct child UPDATE cannot take a child lock ahead of the parent.
revoke update on public.listing_vehicle_contexts,public.listing_car_contexts,public.listing_property_contexts from authenticated;
create policy test_family_direct_media_update on public.listing_media as restrictive for update to authenticated
using (not exists(select 1 from public.listings l where l.id=listing_id and (
 exists(select 1 from public.vehicle_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.car_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.property_category_contracts where category_id=l.category_id))))
with check (not exists(select 1 from public.listings l where l.id=listing_id and (
 exists(select 1 from public.vehicle_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.car_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.property_category_contracts where category_id=l.category_id))));

create function app_security.impl_submit_test_family(lid uuid,expected_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare l public.listings;c jsonb;p jsonb;definition jsonb;snapshot uuid;family text;policy app_security.test_submission_policies;fields jsonb;k text;raw jsonb;kind text;total integer;ready integer;cover uuid;
begin
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text is distinct from 'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
 select * into l from public.listings where id=lid for update;
 if not found or l.seller_id<>auth.uid() then raise exception using errcode='42501',message='Owned listing required'; end if;
 family:=app_security.submission_family(l.id,l.category_id);
 if family is null then raise exception using errcode='22023',message='Unsupported Test submission family'; end if;
 if l.status='pending_review' then return jsonb_build_object('success',true,'result','already_pending','listing_id',lid,'status','pending_review'); end if;
 if l.status<>'draft' then raise exception using errcode='42501',message='Saved draft required'; end if;
 select * into policy from app_security.test_submission_policies where test_submission_policies.family=family for share;
 if not found or not policy.enabled then raise exception using errcode='42501',message='Test submission is disabled'; end if;
 if policy.maintenance then raise exception using errcode='42501',message='Listing maintenance is active'; end if;
 if expected_revision is null or expected_revision<>l.revision then raise exception using errcode='PT409',message='Saved content or photos changed. Save and reload before submitting; no automatic retry.'; end if;
 if family='property' then
  select to_jsonb(x) into c from public.listing_property_contexts x where listing_id=lid;
  select to_jsonb(x),v.definition into p,definition from public.property_category_contracts x join public.property_contract_versions v on v.id=x.version_id where x.category_id=l.category_id and x.version_id=(c->>'version_id')::uuid and v.contract_key=policy.contract_key;
 elsif family='cars' then
  select to_jsonb(x) into c from public.listing_car_contexts x where listing_id=lid;
  select to_jsonb(x),v.definition,v.snapshot_id into p,definition,snapshot from public.car_category_contracts x join public.car_contract_versions v on v.id=x.version_id where x.category_id=l.category_id and x.version_id=(c->>'version_id')::uuid and v.contract_key=policy.contract_key;
 else
  select to_jsonb(x) into c from public.listing_vehicle_contexts x where listing_id=lid;
  select to_jsonb(x),v.definition,v.snapshot_id into p,definition,snapshot from public.vehicle_category_contracts x join public.vehicle_contract_versions v on v.id=x.version_id where x.category_id=l.category_id and x.version_id=(c->>'version_id')::uuid and v.contract_key=policy.contract_key;
 end if;
 if c is null or p is null or c->>'category_id' is distinct from l.category_id::text or md5(definition::text) is distinct from policy.definition_hash then raise exception using errcode='22023',message='Saved contract/context is missing, mismatched or unsupported'; end if;
 if not exists(select 1 from jsonb_array_elements(definition->'paths') x where x->'path'=p->'source_path' and x->'fields'=p->'fields' and (family<>'property' or x=p->'definition')) then raise exception using errcode='22023',message='Unsupported saved category definition'; end if;
 fields:=p->'fields';
 if length(btrim(l.title))<3 or l.description is null or length(btrim(l.description))<10 then raise exception using errcode='22023',message='Complete a title and description of at least 10 characters'; end if;
 if l.city_id is null or not exists(select 1 from public.cities where id=l.city_id and is_active) or l.pin_code is null or l.pin_code !~ '^\d{6}$' then raise exception using errcode='22023',message='Choose an available city and valid six-digit PIN'; end if;
 if l.locality_id is not null and not exists(select 1 from public.postal_pincode_localities m join public.localities t on t.id=m.locality_id where m.pincode=l.pin_code and t.id=l.locality_id and t.city_id=l.city_id) then raise exception using errcode='22023',message='INVALID_PIN_LOCALITY_MAPPING'; end if;
 if family='property' then
  if l.condition is not null or l.price_type is not null or l.price_paise is not null then raise exception using errcode='22023',message='Property item fields must remain NULL'; end if;
  perform app_security.validate_property_components(l.category_attributes,c->'financial',c->>'society_name',p->'definition');
  if c->'financial'->'rent'->>'state' is distinct from 'known' then raise exception using errcode='22023',message='Enter Known positive monthly rent and its compatible basis'; end if;
 else
  if l.condition is null or l.price_type is null or (l.price_type='free' and l.price_paise is distinct from 0) or (l.price_type<>'free' and (l.price_paise is null or l.price_paise<=0)) then raise exception using errcode='22023',message='Complete item condition and valid item price'; end if;
  if family='cars' then perform app_security.validate_car_answers(l.category_attributes,fields,l.category_attributes); else perform app_security.validate_vehicle_answers(l.category_attributes,fields,l.category_attributes); end if;
  for k in select distinct x from (select 'year' x union all select 'km_driven' union all select value from jsonb_array_elements_text(fields) where family='cars' and value in ('fuel_type','transmission','powertrain') union all select 'powertrain' where family='cars' and fields ? 'battery_capacity_kwh') required loop
   if (l.category_attributes->k->>'state') is null or (l.category_attributes->k->>'state') not in ('known','unknown') then raise exception using errcode='22023',message='Declare '||k||' as Known or Unknown before submission'; end if;
  end loop;
  if c->>'mode' in ('catalogue','unresolved') then
   if family='cars' then select r.raw into raw from public.car_catalogue_rows r join public.car_models m on m.id=r.model_id where r.snapshot_id=snapshot and r.model_id=(c->>'model_id')::uuid and m.brand_id=(c->>'brand_id')::uuid;
    if raw is not null then kind:=app_security.car_compatibility(raw,p->'source_path',definition); end if;
   else select r.raw into raw from public.vehicle_catalogue_rows r join public.vehicle_models m on m.id=r.model_id where r.snapshot_id=snapshot and r.model_id=(c->>'model_id')::uuid and m.brand_id=(c->>'brand_id')::uuid;
    if raw is not null then kind:=app_security.vehicle_compatibility(raw,p->'source_path',definition); end if;
   end if;
   if raw is null or kind='incompatible' or (c->>'mode'='catalogue' and not (family='cars' and kind in ('exact','grouped') or family='two-wheelers' and kind='mapped')) or (c->>'mode'='unresolved' and kind<>'unresolved') then raise exception using errcode='22023',message='Saved catalogue selection is incompatible or unavailable'; end if;
   if raw->>'status'='Upcoming' then raise exception using errcode='22023',message='Upcoming catalogue entries remain draft-only'; end if;
  elsif c->>'mode'='not_listed' then
   if length(btrim(c->>'brand_text')) not between 1 and 100 or length(btrim(c->>'model_text')) not between 1 and 150 then raise exception using errcode='22023',message='Complete Not listed Brand and Model'; end if;
   if family='cars' then
    if exists(select 1 from public.car_catalogue_rows r where r.snapshot_id=snapshot and lower(btrim(r.raw->>'brand'))=lower(btrim(c->>'brand_text')) and lower(btrim(r.raw->>'model'))=lower(btrim(c->>'model_text'))) then raise exception using errcode='22023',message='Use the known catalogue/unresolved route'; end if;
   else
    if exists(select 1 from public.vehicle_catalogue_rows r where r.snapshot_id=snapshot and lower(btrim(r.raw->>'brand'))=lower(btrim(c->>'brand_text')) and lower(btrim(r.raw->>'model'))=lower(btrim(c->>'model_text'))) then raise exception using errcode='22023',message='Use the known catalogue/unresolved route'; end if;
   end if;
  else raise exception using errcode='22023',message='Complete Brand and Model information'; end if;
 end if;
 select count(*),count(*) filter(where processing_status='ready') into total,ready from public.listing_media where listing_id=lid;
 if total>8 or ready<1 then raise exception using errcode='22023',message='Submit with at least one ready photo and no more than eight photos'; end if;
 cover:=l.cover_photo_id;
 if cover is not null and not exists(select 1 from public.listing_media where id=cover and listing_id=lid and processing_status='ready') then raise exception using errcode='22023',message='Choose a ready cover photo belonging to this listing'; end if;
 if cover is null then select id into cover from public.listing_media where listing_id=lid and processing_status='ready' order by display_order,created_at limit 1; end if;
 insert into app_security.test_submission_permits values(lid,txid_current(),'submit');
 update public.listings set status='pending_review',cover_photo_id=cover,submitted_at=clock_timestamp(),updated_at=clock_timestamp() where id=lid;
 delete from app_security.test_submission_permits where listing_id=lid and transaction_id=txid_current();
 return jsonb_build_object('success',true,'result','submitted','listing_id',lid,'status','pending_review');
end $$;
revoke all on function app_security.impl_submit_test_family(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_test_family(uuid,integer) to authenticated;
create function public.seller_submit_listing(listing_id uuid,expected_revision integer) returns jsonb
language sql security invoker set search_path='' as $$ select app_security.impl_submit_test_family(listing_id,expected_revision) $$;
revoke all on function public.seller_submit_listing(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.seller_submit_listing(uuid,integer) to authenticated;

-- Existing functions are replaced below with narrowly scoped integration deltas.

CREATE OR REPLACE FUNCTION app_security.vehicle_listing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare fields jsonb; previous jsonb:='{}';
begin
  if tg_op='UPDATE' then
    previous:=old.category_attributes;
    if exists(select 1 from public.listing_vehicle_contexts where listing_id=old.id) and new.category_id<>old.category_id and not exists(select 1 from public.vehicle_category_contracts where category_id=new.category_id) then raise exception 'Vehicle contract cannot be removed through another category'; end if;
  end if;
  if not exists(select 1 from public.vehicle_category_contracts where category_id=new.category_id) then return new; end if;
  if new.status not in ('draft','pending_review') then raise exception 'Two-wheeler review/publication is disabled for this milestone'; end if;
  select p.fields into fields from public.vehicle_category_contracts p join public.listing_vehicle_contexts c on c.category_id=p.category_id and c.version_id=p.version_id where c.listing_id=new.id and c.category_id=new.category_id;
  if fields is null then select p.fields into fields from public.vehicle_category_contracts p join public.vehicle_contract_versions v on v.id=p.version_id where p.category_id=new.category_id and v.contract_key='two-wheeler-draft-v1'; end if;
  new.category_attributes:=app_security.validate_vehicle_answers(new.category_attributes,fields,previous);
  if new.price_type='free' and new.price_paise is distinct from 0 then raise exception 'Free price must be zero'; end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION app_security.car_listing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare fields jsonb; previous jsonb:='{}';
begin
  if tg_op='UPDATE' then
    previous:=old.category_attributes;
    if exists(select 1 from public.listing_car_contexts where listing_id=old.id) and new.category_id<>old.category_id and not exists(select 1 from public.car_category_contracts where category_id=new.category_id) then raise exception 'Car contract cannot be removed through another category'; end if;
  end if;
  if not exists(select 1 from public.car_category_contracts where category_id=new.category_id) then return new; end if;
  if new.status not in ('draft','pending_review') then raise exception 'Car review/publication is disabled for this milestone'; end if;
  select p.fields into fields from public.car_category_contracts p join public.listing_car_contexts c on c.category_id=p.category_id and c.version_id=p.version_id where c.listing_id=new.id and c.category_id=new.category_id;
  if fields is null then select p.fields into fields from public.car_category_contracts p join public.car_contract_versions v on v.id=p.version_id where p.category_id=new.category_id and v.contract_key='cars-draft-v1'; end if;
  new.category_attributes:=app_security.validate_car_answers(new.category_attributes,fields,previous);
  if new.price_type='free' and new.price_paise is distinct from 0 then raise exception 'Free price must be zero'; end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION app_security.property_listing_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if exists(select 1 from public.property_category_contracts where category_id=new.category_id) or exists(select 1 from public.listing_property_contexts where listing_id=new.id) then
  if not exists(select 1 from public.property_category_contracts where category_id=new.category_id) then raise exception using errcode='22023',message='Property draft must retain a Property category'; end if;
  if new.status not in ('draft','pending_review') then raise exception using errcode='22023',message='Property review/publication disabled'; end if;
  if new.price_paise is not null or new.price_type is not null or new.condition is not null then raise exception using errcode='22023',message='Property item price/type/condition must be NULL'; end if;
 end if;
 return new;
end $function$
;
CREATE OR REPLACE FUNCTION app_security.vehicle_context_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare listing uuid; l public.listings; c public.listing_vehicle_contexts; fields jsonb;
begin
  if tg_table_name='listings' then listing:=new.id; else listing:=new.listing_id; end if;
  select * into l from public.listings where id=listing;
  if not found then return null; end if;
  select * into c from public.listing_vehicle_contexts where listing_id=listing;
  if exists(select 1 from public.vehicle_category_contracts where category_id=l.category_id) then
    if c.listing_id is null or c.category_id<>l.category_id or l.status not in ('draft','pending_review') then raise exception 'Atomic vehicle context/category required; submission disabled'; end if;
    select p.fields into strict fields from public.vehicle_category_contracts p where p.category_id=c.category_id and p.version_id=c.version_id;
    perform app_security.validate_vehicle_answers(l.category_attributes,fields,l.category_attributes);
  elsif c.listing_id is not null then raise exception 'Vehicle context cannot attach to unrelated category'; end if;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION app_security.car_context_complete()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare listing uuid; l public.listings; c public.listing_car_contexts; fields jsonb;
begin
  if tg_table_name='listings' then listing:=new.id; else listing:=new.listing_id; end if;
  select * into l from public.listings where id=listing;
  if not found then return null; end if;
  select * into c from public.listing_car_contexts where listing_id=listing;
  if exists(select 1 from public.car_category_contracts where category_id=l.category_id) then
    if c.listing_id is null or c.category_id<>l.category_id or l.status not in ('draft','pending_review') then raise exception 'Atomic car context/category required; submission disabled'; end if;
    select p.fields into fields from public.car_category_contracts p where p.category_id=c.category_id and p.version_id=c.version_id;
    if not found then raise exception using errcode='22023',message='Car category/version reference unavailable'; end if;
    perform app_security.validate_car_answers(l.category_attributes,fields,l.category_attributes);
  elsif c.listing_id is not null then raise exception 'Car context cannot attach to unrelated category'; end if;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION app_security.impl_save_two_wheeler_draft(p_listing_id uuid, p_listing jsonb, p_version_id uuid, p_resolution jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare id uuid; common public.listings; mode text:=p_resolution->>'mode'; brand uuid; model uuid; brand_text text; model_text text;
begin
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text is distinct from 'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if jsonb_typeof(p_listing) is distinct from 'object' or jsonb_typeof(p_resolution) is distinct from 'object' then raise exception 'Malformed draft payload'; end if;
  if exists(select 1 from jsonb_object_keys(p_listing) x where x not in ('title','description','category_id','city_id','locality_id','condition','price_type','price_paise','pin_code','landmark','category_attributes')) then raise exception 'Unexpected common field'; end if;
  if mode is null or mode not in ('unanswered','catalogue','unresolved','not_listed') then raise exception 'Invalid resolution mode'; end if;
  if exists(select 1 from jsonb_object_keys(p_resolution) x where x not in (select unnest(case when mode='unanswered' then array['mode','brand_id'] when mode='not_listed' then array['mode','brand_text','model_text'] else array['mode','brand_id','model_id'] end))) then raise exception 'Unexpected/forged resolution field'; end if;
  select * into common from jsonb_populate_record(null::public.listings,p_listing);
  if length(btrim(common.title))<3 or length(common.title)>150 then raise exception 'Title must be 3–150 characters'; end if;
  if jsonb_typeof(p_listing->'price_paise')='number' and (p_listing->>'price_paise')::numeric<>trunc((p_listing->>'price_paise')::numeric) then raise exception 'Price paise must be whole'; end if;
  brand:=nullif(p_resolution->>'brand_id','')::uuid; model:=nullif(p_resolution->>'model_id','')::uuid;
  brand_text:=p_resolution->>'brand_text'; model_text:=p_resolution->>'model_text';
  if p_listing_id is null then
    insert into public.listings(title,description,category_id,city_id,locality_id,condition,price_type,price_paise,pin_code,landmark,category_attributes)
    values(common.title,common.description,common.category_id,common.city_id,common.locality_id,common.condition,common.price_type,common.price_paise,common.pin_code,common.landmark,coalesce(common.category_attributes,'{}')) returning listings.id into id;
  else
    -- Row lock serializes same-ID updates, and prevents non-owner and non-vehicle conversion.
    perform 1 from public.listings l join public.listing_vehicle_contexts c on c.listing_id=l.id where l.id=p_listing_id and l.seller_id=auth.uid() and l.status='draft' for update of l;
    if not found then raise exception 'Owned vehicle draft required'; end if;
    update public.listings set title=common.title,description=common.description,category_id=common.category_id,city_id=common.city_id,locality_id=common.locality_id,condition=common.condition,price_type=common.price_type,price_paise=common.price_paise,pin_code=common.pin_code,landmark=common.landmark,category_attributes=coalesce(common.category_attributes,'{}') where listings.id=p_listing_id returning listings.id into id;
    if id is null then raise exception 'Draft update denied'; end if;
  end if;
  if p_listing_id is null then
    insert into public.listing_vehicle_contexts(listing_id,category_id,version_id,mode,brand_id,model_id,brand_text,model_text)
    values(id,common.category_id,p_version_id,mode,brand,model,brand_text,model_text);
  else
    update public.listing_vehicle_contexts set category_id=common.category_id,version_id=p_version_id,mode=mode,brand_id=brand,model_id=model,brand_text=brand_text,model_text=model_text where listing_id=id;
  end if;
  return id;
end $function$
;
revoke all on function app_security.impl_save_two_wheeler_draft(uuid,jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_save_two_wheeler_draft(uuid,jsonb,uuid,jsonb) to authenticated;
create or replace function public.save_two_wheeler_draft(p_listing_id uuid,p_listing jsonb,p_version_id uuid,p_resolution jsonb) returns uuid language sql security invoker set search_path='' as $$select app_security.impl_save_two_wheeler_draft(p_listing_id,p_listing,p_version_id,p_resolution)$$;
CREATE OR REPLACE FUNCTION app_security.impl_save_car_draft(p_listing_id uuid, p_listing jsonb, p_version_id uuid, p_resolution jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_variable
declare id uuid; common public.listings; mode text:=p_resolution->>'mode'; brand uuid; model uuid; brand_text text; model_text text;
begin
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text is distinct from 'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if jsonb_typeof(p_listing) is distinct from 'object' or jsonb_typeof(p_resolution) is distinct from 'object' then raise exception 'Malformed draft payload'; end if;
  if exists(select 1 from jsonb_object_keys(p_listing) x where x not in ('title','description','category_id','city_id','locality_id','condition','price_type','price_paise','pin_code','landmark','category_attributes')) then raise exception 'Unexpected common field'; end if;
  if mode is null or mode not in ('unanswered','catalogue','unresolved','not_listed') then raise exception 'Invalid resolution mode'; end if;
  if exists(select 1 from jsonb_object_keys(p_resolution) x where x not in (select unnest(case when mode='unanswered' then array['mode','brand_id'] when mode='not_listed' then array['mode','brand_text','model_text'] else array['mode','brand_id','model_id'] end))) then raise exception 'Unexpected/forged resolution field'; end if;
  select * into common from jsonb_populate_record(null::public.listings,p_listing);
  if length(btrim(common.title))<3 or length(common.title)>150 then raise exception 'Title must be 3–150 characters'; end if;
  if jsonb_typeof(p_listing->'price_paise')='number' and (p_listing->>'price_paise')::numeric<>trunc((p_listing->>'price_paise')::numeric) then raise exception 'Price paise must be whole'; end if;
  brand:=nullif(p_resolution->>'brand_id','')::uuid; model:=nullif(p_resolution->>'model_id','')::uuid;
  brand_text:=p_resolution->>'brand_text'; model_text:=p_resolution->>'model_text';
  if p_listing_id is null then
    insert into public.listings(title,description,category_id,city_id,locality_id,condition,price_type,price_paise,pin_code,landmark,category_attributes)
    values(common.title,common.description,common.category_id,common.city_id,common.locality_id,common.condition,common.price_type,common.price_paise,common.pin_code,common.landmark,coalesce(common.category_attributes,'{}')) returning listings.id into id;
  else
    -- Row lock serializes same-ID updates, and prevents non-owner and non-vehicle conversion.
    perform 1 from public.listings l join public.listing_car_contexts c on c.listing_id=l.id where l.id=p_listing_id and l.seller_id=auth.uid() and l.status='draft' for update of l;
    if not found then raise exception 'Owned car draft required'; end if;
    update public.listings set title=common.title,description=common.description,category_id=common.category_id,city_id=common.city_id,locality_id=common.locality_id,condition=common.condition,price_type=common.price_type,price_paise=common.price_paise,pin_code=common.pin_code,landmark=common.landmark,category_attributes=coalesce(common.category_attributes,'{}') where listings.id=p_listing_id returning listings.id into id;
    if id is null then raise exception 'Draft update denied'; end if;
  end if;
  if p_listing_id is null then
    insert into public.listing_car_contexts(listing_id,category_id,version_id,mode,brand_id,model_id,brand_text,model_text)
    values(id,common.category_id,p_version_id,mode,brand,model,brand_text,model_text);
  else
    update public.listing_car_contexts set category_id=common.category_id,version_id=p_version_id,mode=mode,brand_id=brand,model_id=model,brand_text=brand_text,model_text=model_text where listing_id=id;
  end if;
  return id;
end $function$
;
revoke all on function app_security.impl_save_car_draft(uuid,jsonb,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_save_car_draft(uuid,jsonb,uuid,jsonb) to authenticated;
create or replace function public.save_car_draft(p_listing_id uuid,p_listing jsonb,p_version_id uuid,p_resolution jsonb) returns uuid language sql security invoker set search_path='' as $$select app_security.impl_save_car_draft(p_listing_id,p_listing,p_version_id,p_resolution)$$;
CREATE OR REPLACE FUNCTION app_security.impl_save_property_draft(p_listing_id uuid, p_listing jsonb, p_version_id uuid, p_financial jsonb, p_society_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare lid uuid;p public.property_category_contracts%rowtype;l public.listings%rowtype;cid uuid;
begin
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text is distinct from 'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text<>'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
 if p_listing is null or jsonb_typeof(p_listing)<>'object' or p_listing-'title'-'category_id'-'city_id'-'locality_id'-'description'-'condition'-'price_type'-'price_paise'-'pin_code'-'landmark'-'category_attributes'<>'{}' then raise exception using errcode='22023',message='Unexpected Property draft metadata'; end if;
 if p_listing->>'price_paise' is not null or p_listing->>'price_type' is not null or p_listing->>'condition' is not null then raise exception using errcode='22023',message='Property item price/type/condition must be NULL'; end if;
 begin cid:=(p_listing->>'category_id')::uuid; exception when invalid_text_representation then raise exception using errcode='22023',message='Property category reference unavailable'; end;
 select * into p from public.property_category_contracts where category_id=cid and version_id=p_version_id;
 if not found then raise exception using errcode='22023',message='Property category/version reference unavailable'; end if;
 if p_listing_id is not null then
  perform 1 from public.listings where id=p_listing_id and seller_id=auth.uid() and status='draft' for update;
  if not found or not exists(select 1 from public.listing_property_contexts where listing_id=p_listing_id) then raise exception using errcode='42501',message='Owned Property draft required'; end if;
  lid:=p_listing_id;
  update public.listings set title=p_listing->>'title',category_id=cid,city_id=(p_listing->>'city_id')::uuid,locality_id=(p_listing->>'locality_id')::uuid,description=p_listing->>'description',condition=null,price_type=null,price_paise=null,pin_code=p_listing->>'pin_code',landmark=p_listing->>'landmark',category_attributes=coalesce(p_listing->'category_attributes','{}') where id=lid;
 else
  insert into public.listings(title,category_id,city_id,locality_id,description,condition,price_type,price_paise,pin_code,landmark,category_attributes) values(p_listing->>'title',cid,(p_listing->>'city_id')::uuid,(p_listing->>'locality_id')::uuid,p_listing->>'description',null,null,null,p_listing->>'pin_code',p_listing->>'landmark',coalesce(p_listing->'category_attributes','{}')) returning id into lid;
 end if;
 insert into public.listing_property_contexts(listing_id,category_id,version_id,financial,society_name) values(lid,cid,p_version_id,p_financial,p_society_name) on conflict(listing_id) do update set category_id=excluded.category_id,version_id=excluded.version_id,financial=excluded.financial,society_name=excluded.society_name;
 return lid;
end $function$
;
revoke all on function app_security.impl_save_property_draft(uuid,jsonb,uuid,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_save_property_draft(uuid,jsonb,uuid,jsonb,text) to authenticated;
create or replace function public.save_property_draft(p_listing_id uuid,p_listing jsonb,p_version_id uuid,p_financial jsonb,p_society_name text) returns uuid language sql security invoker set search_path='' as $$select app_security.impl_save_property_draft(p_listing_id,p_listing,p_version_id,p_financial,p_society_name)$$;
CREATE OR REPLACE FUNCTION app_security.impl_seller_submit_listing(p_listing_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_id uuid;
  v_listing record;
  v_media_count integer;
  v_attr record;
  v_cover_id uuid;
  v_loc_city_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) != 'active' THEN
    RAISE EXCEPTION 'account is not active';
  END IF;

  IF NOT app_security.has_current_policy_acceptance(v_caller_id) THEN
    RAISE EXCEPTION 'POLICY_ACCEPTANCE_REQUIRED: Re-acceptance of Public Beta policies is required';
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  IF v_listing.id IS NULL THEN
    RAISE EXCEPTION 'listing not found';
  END IF;

  IF v_listing.seller_id != v_caller_id THEN
    RAISE EXCEPTION 'caller does not own this listing';
  END IF;

  IF app_security.submission_family(v_listing.id,v_listing.category_id) is not null THEN
    RETURN app_security.impl_submit_test_family(p_listing_id,null);
  END IF;

  IF v_listing.status NOT IN ('draft', 'rejected') THEN
    RAISE EXCEPTION 'listing status % cannot be submitted for review', v_listing.status;
  END IF;

  -- Validate required fields
  IF length(trim(v_listing.title)) < 3 THEN
    RAISE EXCEPTION 'title must be at least 3 characters';
  END IF;

  IF v_listing.description IS NULL OR length(trim(v_listing.description)) < 10 THEN
    RAISE EXCEPTION 'description must be at least 10 characters';
  END IF;

  IF v_listing.category_id IS NULL THEN
    RAISE EXCEPTION 'category is required';
  END IF;

  IF v_listing.city_id IS NULL THEN
    RAISE EXCEPTION 'city is required';
  END IF;

  IF v_listing.condition IS NULL THEN
    RAISE EXCEPTION 'condition is required';
  END IF;

  IF v_listing.price_type IS NULL THEN
    RAISE EXCEPTION 'price type is required';
  END IF;

  IF v_listing.price_type != 'free' AND (v_listing.price_paise IS NULL OR v_listing.price_paise <= 0) THEN
    RAISE EXCEPTION 'price in paise is required for non-free listings';
  END IF;

  -- India PIN Code & Location Integrity Verification
  IF v_listing.pin_code IS NULL OR v_listing.pin_code !~ '^\d{6}$' THEN
    RAISE EXCEPTION 'valid 6-digit PIN code is required';
  END IF;

  -- Validate that if locality_id is provided, it is legitimately mapped to the PIN code
  IF v_listing.locality_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.postal_pincode_localities ppl
      WHERE ppl.pincode = v_listing.pin_code
        AND ppl.locality_id = v_listing.locality_id
    ) THEN
      RAISE EXCEPTION 'INVALID_PIN_LOCALITY_MAPPING: Locality % is not mapped to PIN code %', v_listing.locality_id, v_listing.pin_code;
    END IF;

    -- Also verify locality belongs to the selected city
    SELECT city_id INTO v_loc_city_id
    FROM public.localities
    WHERE id = v_listing.locality_id;

    IF v_loc_city_id IS DISTINCT FROM v_listing.city_id THEN
      RAISE EXCEPTION 'INVALID_CITY_LOCALITY_MAPPING: Locality does not belong to selected city';
    END IF;
  END IF;

  -- Validate required category attributes
  FOR v_attr IN (
    SELECT name, label
    FROM public.category_attributes
    WHERE category_id = v_listing.category_id AND is_required = true
  ) LOOP
    IF NOT (v_listing.category_attributes ? v_attr.name) OR
       v_listing.category_attributes->>v_attr.name IS NULL OR
       length(trim(v_listing.category_attributes->>v_attr.name)) = 0 THEN
      RAISE EXCEPTION 'required attribute % (%) is missing', v_attr.label, v_attr.name;
    END IF;
  END LOOP;

  -- Validate media: at least 1 ready photo
  SELECT count(*) INTO v_media_count
  FROM public.listing_media
  WHERE listing_id = p_listing_id AND processing_status = 'ready';

  IF v_media_count < 1 THEN
    RAISE EXCEPTION 'listing must have at least one photo with processing_status = ready';
  END IF;

  -- Auto-assign cover photo if not set
  v_cover_id := v_listing.cover_photo_id;
  IF v_cover_id IS NULL THEN
    SELECT id INTO v_cover_id
    FROM public.listing_media
    WHERE listing_id = p_listing_id AND processing_status = 'ready'
    ORDER BY display_order ASC, created_at ASC
    LIMIT 1;
  END IF;

  -- Update listing status to pending_review
  UPDATE public.listings
  SET status = 'pending_review'::public.listing_status_enum,
      cover_photo_id = v_cover_id,
      submitted_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_listing_id;

  RETURN jsonb_build_object(
    'success', true,
    'listing_id', p_listing_id,
    'status', 'pending_review'
  );
END;
$function$
;
CREATE OR REPLACE FUNCTION app_security.impl_record_media_processing_result(p_media_id uuid, p_paths jsonb, p_dimensions jsonb, p_status text, p_error text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_media record;
  parent public.listings;
  scoped boolean:=false;
  supplied_path text;
BEGIN
  -- New families always lock the parent before the attachment. Preserve Goods.
  select l.* into parent from public.listings l join public.listing_media m on m.listing_id=l.id where m.id=p_media_id;
  scoped:=app_security.submission_family(parent.id,parent.category_id) is not null;
  if scoped then
    if current_setting('role',true) is distinct from 'service_role' then raise exception using errcode='42501',message='Accepted media worker required'; end if;
    select * into parent from public.listings where id=parent.id for update;
    if parent.status not in ('draft','pending_review') then raise exception using errcode='42501',message='Unsupported media lifecycle'; end if;
    for supplied_path in select value from jsonb_each_text(coalesce(p_paths,'{}')) loop
      if supplied_path is null or supplied_path not like parent.id::text||'/'||p_media_id::text||'/%' then raise exception using errcode='22023',message='Worker path must belong to the accepted attachment'; end if;
    end loop;
    insert into app_security.test_submission_permits values(parent.id,txid_current(),'worker');
  end if;
  SELECT * INTO v_media
  FROM public.listing_media
  WHERE id = p_media_id
  FOR UPDATE;

  IF v_media.id IS NULL THEN
    RAISE EXCEPTION 'media record % not found', p_media_id;
  END IF;

  IF p_status = 'ready' THEN
    UPDATE public.listing_media
    SET original_storage_path = p_paths->>'original',
        thumbnail_storage_path = p_paths->>'thumbnail',
        medium_storage_path = p_paths->>'medium',
        large_storage_path = p_paths->>'large',
        width = (p_dimensions->>'width')::integer,
        height = (p_dimensions->>'height')::integer,
        processing_status = 'ready'::public.media_processing_status_enum,
        processing_error = NULL
    WHERE id = p_media_id;

    PERFORM app_security.log_audit_event(
      'media.processing_completed',
      'listing_media',
      p_media_id,
      jsonb_build_object('listing_id', v_media.listing_id)
    );

  ELSIF p_status = 'failed' THEN
    UPDATE public.listing_media
    SET processing_status = 'failed'::public.media_processing_status_enum,
        processing_error = p_error
    WHERE id = p_media_id;

    PERFORM app_security.log_audit_event(
      'media.processing_failed',
      'listing_media',
      p_media_id,
      jsonb_build_object('listing_id', v_media.listing_id, 'error', p_error)
    );

  ELSIF p_status = 'processing' THEN
    UPDATE public.listing_media
    SET original_storage_path = COALESCE(p_paths->>'original', original_storage_path),
        processing_status = 'processing'::public.media_processing_status_enum
    WHERE id = p_media_id;
  ELSE
    RAISE EXCEPTION 'invalid media status: %', p_status;
  END IF;

  if scoped then delete from app_security.test_submission_permits where listing_id=parent.id and transaction_id=txid_current(); end if;
  RETURN jsonb_build_object('success', true, 'media_id', p_media_id, 'status', p_status);
END;
$function$
;
create function app_security.impl_get_seller_submission_status(lid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l public.listings;f text;p app_security.test_submission_policies;
begin
 select * into l from public.listings where id=lid;
 if auth.uid() is null or not found or l.seller_id<>auth.uid() then raise exception using errcode='42501',message='Owned listing required'; end if;
 f:=app_security.submission_family(l.id,l.category_id);
 select * into p from app_security.test_submission_policies where family=f;
 return jsonb_build_object('family',f,'enabled',coalesce(p.enabled and not p.maintenance,false),'policy_key',p.policy_key);
end $$;
revoke all on function app_security.impl_get_seller_submission_status(uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_get_seller_submission_status(uuid) to authenticated;
create function public.get_seller_submission_status(listing_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_get_seller_submission_status(listing_id)$$;
revoke all on function public.get_seller_submission_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_seller_submission_status(uuid) to authenticated;
commit;
