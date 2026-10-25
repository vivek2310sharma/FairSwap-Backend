-- FairSwapProd Vehicles/Property complete reviewed submission + human publication BASE.
-- This file is prepared for ROLLBACK REHEARSAL; after all Test and Admin
-- acceptance proof, use the exact reviewed forward version in Production.
-- Insertion order: family policy/permits, submit, draft guards, review permits,
-- fingerprint and AAL2 reviewed approval. Policy enabled DEFAULT FALSE.
-- REVIEW-ONLY CANDIDATE, 2026-10-22. NOT AUTHORIZED FOR FAIRSWAPPROD.
-- Source: selected, reviewed building blocks from Test 20261011092234;
-- adapted to independently named Production RPCs. No Test activation, no
-- Goods submit overwrite, no moderation approval or publication.
-- Deliberate STOP is mandatory until verified PG17 replay and signed release.
-- Remove this stopper ONLY in an approved forward-only migration PR.
BEGIN;
create table app_security.production_submission_policies (
  family text primary key check (family in ('two-wheelers','cars','property')),
  policy_key text not null default 'production-family-submission-v1',
  contract_key text not null,
  definition_hash text not null,
  requirements jsonb not null,
  enabled boolean not null default false,
  maintenance boolean not null default false
);
alter table app_security.production_submission_policies enable row level security;
revoke all on app_security.production_submission_policies from public,anon,authenticated,service_role;
create function app_security.production_submission_policy_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if (to_jsonb(new)-'enabled'-'maintenance') is distinct from (to_jsonb(old)-'enabled'-'maintenance') then raise exception 'Production family submission policy/version facts are immutable'; end if;
 return new;
end $$;
revoke all on function app_security.production_submission_policy_immutable() from public,anon,authenticated,service_role;
create trigger production_submission_policy_immutable before update on app_security.production_submission_policies for each row execute function app_security.production_submission_policy_immutable();
insert into app_security.production_submission_policies(family,contract_key,definition_hash,requirements)
select 'two-wheelers',contract_key,md5(definition::text),'{"model":"catalogue/unresolved/not_listed; no Upcoming or incompatible fallback","year":"known/unknown","km_driven":"known/unknown; zero valid","photos":"at least one ready; maximum eight","publication":"blocked","amounts":"existing Test item constraints only"}'::jsonb from public.vehicle_contract_versions where contract_key='two-wheeler-draft-v1'
union all select 'cars',contract_key,md5(definition::text),'{"model":"catalogue/unresolved/not_listed; import_only allowed into review","year":"known/unknown","km_driven":"known/unknown; zero valid","applicable_declarations":"fuel_type/transmission/powertrain known/unknown","photos":"at least one ready; maximum eight","publication":"blocked","amounts":"existing Test item constraints only"}'::jsonb from public.car_contract_versions where contract_key='cars-draft-v1'
union all select 'property',contract_key,md5(definition::text),'{"rent":"known positive monthly INR, compatible explicit basis; no rent on request","deposit":"optional; explicit zero valid","maintenance":"optional; separate amount/period/basis preserved","photos":"at least one ready; maximum eight","publication":"blocked","amounts":"existing exact paise technical constraints only"}'::jsonb from public.property_contract_versions where contract_key='property-rental-draft-v1';
do $$ begin if (select count(*) from app_security.production_submission_policies)<>3 then raise exception 'Supported submission contracts missing'; end if; end $$;

-- A private transaction-scoped permit, never a caller-settable session flag.
create table app_security.production_submission_permits (
  listing_id uuid not null, transaction_id bigint not null, operation text not null check(operation in ('submit','worker')),
  primary key(listing_id,transaction_id)
);
alter table app_security.production_submission_permits enable row level security;
revoke all on app_security.production_submission_permits from public,anon,authenticated,service_role;

create function app_security.production_submission_family(lid uuid,cid uuid) returns text
language sql stable security definer set search_path='' as $$
 select case
 when exists(select 1 from public.property_category_contracts where category_id=cid) or exists(select 1 from public.listing_property_contexts where listing_id=lid) then 'property'
 when exists(select 1 from public.car_category_contracts where category_id=cid) or exists(select 1 from public.listing_car_contexts where listing_id=lid) then 'cars'
 when exists(select 1 from public.vehicle_category_contracts where category_id=cid) or exists(select 1 from public.listing_vehicle_contexts where listing_id=lid) then 'two-wheelers' end
$$;
revoke all on function app_security.production_submission_family(uuid,uuid) from public,anon,authenticated,service_role;

create function app_security.production_submission_lifecycle() returns trigger
language plpgsql security definer set search_path='' as $$
declare family text; permitted text;
begin
 family:=app_security.production_submission_family(case when tg_op='DELETE' then old.id else new.id end,case when tg_op='DELETE' then old.category_id else new.category_id end);
 if family is null then return case when tg_op='DELETE' then old else new end; end if;
 if tg_op='DELETE' then
  if old.status<>'draft' then raise exception using errcode='42501',message='Awaiting review is read-only'; end if;
  return old;
 end if;
 if tg_op='INSERT' then
  if new.status<>'draft' then raise exception using errcode='42501',message='New-family listings must start as drafts'; end if;
  return new;
 end if;
 select operation into permitted from app_security.production_submission_permits where listing_id=old.id and transaction_id=txid_current();
 if old.status='draft' and new.status='draft' then
  -- Every listing/context/media change advances this scoped saved identity.
  new.revision:=old.revision+1;
 elsif old.status='draft' and new.status='pending_review' and permitted='submit' then
  new.revision:=old.revision+1;
 elsif old.status='pending_review' and new.status='pending_review' and permitted='worker'
  and (to_jsonb(new)-'revision'-'updated_at'-'search_vector')=(to_jsonb(old)-'revision'-'updated_at'-'search_vector') then
  new.revision:=old.revision+1;
 elsif old.status='pending_review' and new.status in ('active','rejected','removed')
  and exists(select 1 from app_security.family_review_permits x where x.listing_id=old.id
      and x.transaction_id=txid_current() and x.requested_status=new.status) then
  new.revision:=old.revision+1;
 else
  raise exception using errcode='42501',message='Family status transition requires reviewed authorization';
 end if;
 return new;
end $$;
revoke all on function app_security.production_submission_lifecycle() from public,anon,authenticated,service_role;
create trigger z_0_production_submission_lifecycle before insert or update or delete on public.listings for each row execute function app_security.production_submission_lifecycle();

create function app_security.production_submission_child_change() returns trigger
language plpgsql security definer set search_path='' as $$
declare lid uuid;l public.listings;permit text;
begin
 lid:=case when tg_op='DELETE' then old.listing_id else new.listing_id end;
 select * into l from public.listings where id=lid for update;
 if not found then return case when tg_op='DELETE' then old else new end; end if;
 if app_security.production_submission_family(l.id,l.category_id) is null then return case when tg_op='DELETE' then old else new end; end if;
 select operation into permit from app_security.production_submission_permits where listing_id=lid and transaction_id=txid_current();
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
revoke all on function app_security.production_submission_child_change() from public,anon,authenticated,service_role;
create trigger zz_production_submission_child before insert or update or delete on public.listing_vehicle_contexts for each row execute function app_security.production_submission_child_change();
create trigger zz_production_submission_child before insert or update or delete on public.listing_car_contexts for each row execute function app_security.production_submission_child_change();
create trigger zz_production_submission_child before insert or update or delete on public.listing_property_contexts for each row execute function app_security.production_submission_child_change();
create trigger zz_production_submission_child before insert or update or delete on public.listing_media for each row execute function app_security.production_submission_child_change();

-- Context updates use existing owner-checked save RPCs, which take the parent
-- lock first. Direct child UPDATE cannot take a child lock ahead of the parent.
revoke update on public.listing_vehicle_contexts,public.listing_car_contexts,public.listing_property_contexts from authenticated;
create policy production_family_direct_media_update on public.listing_media as restrictive for update to authenticated
using (not exists(select 1 from public.listings l where l.id=listing_id and (
 exists(select 1 from public.vehicle_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.car_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.property_category_contracts where category_id=l.category_id))))
with check (not exists(select 1 from public.listings l where l.id=listing_id and (
 exists(select 1 from public.vehicle_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.car_category_contracts where category_id=l.category_id) or
 exists(select 1 from public.property_category_contracts where category_id=l.category_id))));

create function app_security.impl_submit_production_family(lid uuid,expected_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare l public.listings;c jsonb;p jsonb;definition jsonb;snapshot uuid;family text;policy app_security.production_submission_policies;fields jsonb;k text;raw jsonb;kind text;total integer;ready integer;cover uuid;
begin
 if auth.uid() is null or app_security.get_account_status(auth.uid())::text is distinct from 'active' or not app_security.has_current_policy_acceptance(auth.uid()) then raise exception using errcode='42501',message='Active policy-approved owner required'; end if;
 select * into l from public.listings where id=lid for update;
 if not found or l.seller_id<>auth.uid() then raise exception using errcode='42501',message='Owned listing required'; end if;
 family:=app_security.production_submission_family(l.id,l.category_id);
 if family is null then raise exception using errcode='22023',message='Unsupported Production family submission family'; end if;
 if l.status='pending_review' then return jsonb_build_object('success',true,'result','already_pending','listing_id',lid,'status','pending_review'); end if;
 if l.status<>'draft' then raise exception using errcode='42501',message='Saved draft required'; end if;
 select * into policy from app_security.production_submission_policies where production_submission_policies.family=family for share;
 if not found or not policy.enabled then raise exception using errcode='42501',message='Production family submission is disabled'; end if;
 if policy.maintenance then raise exception using errcode='42501',message='Listing maintenance is active'; end if;
 if not exists(select 1 from public.categories x where x.id=l.category_id and x.is_active and x.new_listing_enabled) then raise exception using errcode='42501',message='Family category not available for production submission'; end if;
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
 -- Production candidate conservatively freezes the entire ready gallery before moderation.
 if total>8 or ready<1 or ready<>total then raise exception using errcode='22023',message='All one-to-eight photos must be ready before submission'; end if;
 cover:=l.cover_photo_id;
 if cover is not null and not exists(select 1 from public.listing_media where id=cover and listing_id=lid and processing_status='ready') then raise exception using errcode='22023',message='Choose a ready cover photo belonging to this listing'; end if;
 if cover is null then select id into cover from public.listing_media where listing_id=lid and processing_status='ready' order by display_order,created_at limit 1; end if;
 insert into app_security.production_submission_permits values(lid,txid_current(),'submit');
 update public.listings set status='pending_review',cover_photo_id=cover,submitted_at=clock_timestamp(),updated_at=clock_timestamp() where id=lid;
 delete from app_security.production_submission_permits where listing_id=lid and transaction_id=txid_current();
 return jsonb_build_object('success',true,'result','submitted','listing_id',lid,'status','pending_review');
end $$;
revoke all on function app_security.impl_submit_production_family(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_submit_production_family(uuid,integer) to authenticated;
create function public.seller_submit_family_listing(listing_id uuid,expected_revision integer) returns jsonb
language sql security invoker set search_path='' as $$ select app_security.impl_submit_production_family(listing_id,expected_revision) $$;
revoke all on function public.seller_submit_family_listing(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.seller_submit_family_listing(uuid,integer) to authenticated;



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
  if new.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Two-wheeler review/publication is disabled for this milestone'; end if;
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
  if new.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Car review/publication is disabled for this milestone'; end if;
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
  if new.status not in ('draft','pending_review','active','rejected','removed') then raise exception using errcode='22023',message='Property review/publication disabled'; end if;
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
    if c.listing_id is null or c.category_id<>l.category_id or l.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Atomic vehicle context/category required; submission disabled'; end if;
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
    if c.listing_id is null or c.category_id<>l.category_id or l.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Atomic car context/category required; submission disabled'; end if;
    select p.fields into fields from public.car_category_contracts p where p.category_id=c.category_id and p.version_id=c.version_id;
    if not found then raise exception using errcode='22023',message='Car category/version reference unavailable'; end if;
    perform app_security.validate_car_answers(l.category_attributes,fields,l.category_attributes);
  elsif c.listing_id is not null then raise exception 'Car context cannot attach to unrelated category'; end if;
  return null;
end $function$
;
-- Existing deployed Production save_two_wheeler_draft, save_car_draft and
-- save_property_draft are preserved byte-for-byte. No cross-environment
-- compatibility rewrites or grants to their public RPCs occur in this release.

create function app_security.impl_get_seller_production_submission_status(lid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l public.listings;f text;p app_security.production_submission_policies;
begin
 select * into l from public.listings where id=lid;
 if auth.uid() is null or not found or l.seller_id<>auth.uid() then raise exception using errcode='42501',message='Owned listing required'; end if;
 f:=app_security.production_submission_family(l.id,l.category_id);
 if f='property' and not exists(select 1 from public.listing_property_contexts c where c.listing_id=l.id and c.category_id=l.category_id) then raise exception using errcode='22023',message='Saved Property category/context unavailable'; end if;
 if f='cars' and not exists(select 1 from public.listing_car_contexts c where c.listing_id=l.id and c.category_id=l.category_id) then raise exception using errcode='22023',message='Saved Car category/context unavailable'; end if;
 if f='two-wheelers' and not exists(select 1 from public.listing_vehicle_contexts c where c.listing_id=l.id and c.category_id=l.category_id) then raise exception using errcode='22023',message='Saved Vehicle category/context unavailable'; end if;
 select * into p from app_security.production_submission_policies where family=f;
 return jsonb_build_object('family',f,'enabled',coalesce(p.enabled and not p.maintenance,false),'policy_key',p.policy_key);
end $$;
revoke all on function app_security.impl_get_seller_production_submission_status(uuid) from public,anon,authenticated,service_role;
grant execute on function app_security.impl_get_seller_production_submission_status(uuid) to authenticated;
create function public.get_seller_production_submission_status(listing_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$select app_security.impl_get_seller_production_submission_status(listing_id)$$;
revoke all on function public.get_seller_production_submission_status(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_seller_production_submission_status(uuid) to authenticated;

-- Human-review authorization for stored Vehicles/Property (Test rehearsal first).
-- Separate from existing Goods; neither anon nor clients can create review permits.
CREATE TABLE IF NOT EXISTS app_security.family_review_permits(
 listing_id uuid NOT NULL,
 transaction_id bigint NOT NULL,
 requested_status public.listing_status_enum NOT NULL,
 PRIMARY KEY(listing_id,transaction_id)
);
ALTER TABLE app_security.family_review_permits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_security.family_review_permits FROM PUBLIC,anon,authenticated,service_role;

-- Hash the exact stored content, including private data and processed image identities.
-- The digest can be shown to staff, but neither raw private context nor paths are returned.
CREATE OR REPLACE FUNCTION app_security.family_review_fingerprint(p_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
   'listing',to_jsonb(l)-'search_vector',
   'vehicle',(SELECT to_jsonb(c) FROM public.listing_vehicle_contexts c WHERE c.listing_id=l.id),
   'car',(SELECT to_jsonb(c) FROM public.listing_car_contexts c WHERE c.listing_id=l.id),
   'property',(SELECT to_jsonb(c) FROM public.listing_property_contexts c WHERE c.listing_id=l.id),
   'media',(SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.display_order,m.id),'[]'::jsonb)
            FROM public.listing_media m WHERE m.listing_id=l.id)
 )::text,'UTF8')),'hex')
 FROM public.listings l WHERE l.id=p_id;
$$;
REVOKE ALL ON FUNCTION app_security.family_review_fingerprint(uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION app_security.impl_get_staff_family_review(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings; f text; v public.listing_vehicle_contexts; c public.listing_car_contexts;
 p public.listing_property_contexts; details jsonb; photos jsonb;
BEGIN
 IF auth.uid() IS NULL
   OR NOT (app_security.is_active_staff_aal2('moderator'::public.staff_role_enum)
        OR app_security.is_active_staff_aal2('administrator'::public.staff_role_enum))
   OR NOT app_security.has_current_policy_acceptance(auth.uid()) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Authorized AAL2 staff required';
 END IF;
 SELECT * INTO l FROM public.listings WHERE id=p_id AND status='pending_review';
 IF NOT FOUND OR l.seller_id=auth.uid() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Review record not available';
 END IF;
 SELECT * INTO p FROM public.listing_property_contexts WHERE listing_id=p_id;
 SELECT * INTO c FROM public.listing_car_contexts WHERE listing_id=p_id;
 SELECT * INTO v FROM public.listing_vehicle_contexts WHERE listing_id=p_id;
 f:=CASE WHEN p.listing_id IS NOT NULL THEN 'property'
         WHEN c.listing_id IS NOT NULL THEN 'cars'
         WHEN v.listing_id IS NOT NULL THEN 'two-wheelers' END;
 IF f IS NULL OR
   (CASE WHEN p.listing_id IS NOT NULL THEN 1 ELSE 0 END
   +CASE WHEN c.listing_id IS NOT NULL THEN 1 ELSE 0 END
   +CASE WHEN v.listing_id IS NOT NULL THEN 1 ELSE 0 END)<>1
 THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Family review is not available'; END IF;
 IF l.category_id IS DISTINCT FROM coalesce(p.category_id,c.category_id,v.category_id) THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Category reference mismatch';
 END IF;
 details:=CASE f WHEN 'property' THEN jsonb_build_object('financial',p.financial)
   WHEN 'cars' THEN jsonb_build_object('mode',c.mode,'brand_id',c.brand_id,'model_id',c.model_id,
        'brand_text',c.brand_text,'model_text',c.model_text,'classification_review_required',c.classification_review_required)
   ELSE jsonb_build_object('mode',v.mode,'brand_id',v.brand_id,'model_id',v.model_id,
        'brand_text',v.brand_text,'model_text',v.model_text,'classification_review_required',v.classification_review_required) END;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'status',processing_status,
                       'display_order',display_order) ORDER BY display_order,id),'[]'::jsonb)
 INTO photos FROM public.listing_media WHERE listing_id=p_id;
 RETURN jsonb_build_object(
  'identity',jsonb_build_object('id',l.id,'revision',l.revision,'status',l.status),
  'family',f,
  'title',l.title,'description',l.description,'category_id',l.category_id,
  'city_id',l.city_id,'locality_id',l.locality_id,
  'condition',l.condition,'price_type',l.price_type,'price_paise',l.price_paise,
  'attributes',l.category_attributes,'details',details,'media',photos,
  'cover_photo_id',l.cover_photo_id,
  'fingerprint',app_security.family_review_fingerprint(l.id)
 );
END $$;
REVOKE ALL ON FUNCTION app_security.impl_get_staff_family_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_get_staff_family_review(uuid) TO authenticated;
CREATE OR REPLACE FUNCTION public.get_staff_family_review(listing_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT app_security.impl_get_staff_family_review(listing_id);
$$;
REVOKE ALL ON FUNCTION public.get_staff_family_review(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.get_staff_family_review(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_security.impl_moderate_family_reviewed(
 p_id uuid,p_action text,p_reason text,p_revision integer,p_fingerprint text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE l public.listings; f text; photo_total int; photo_ready int; row_result jsonb; ctx_count integer;
BEGIN
 IF auth.uid() IS NULL OR
   NOT (app_security.is_active_staff_aal2('moderator'::public.staff_role_enum)
      OR app_security.is_active_staff_aal2('administrator'::public.staff_role_enum))
   OR NOT app_security.has_current_policy_acceptance(auth.uid()) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Authorized AAL2 staff required';
 END IF;
 IF p_action NOT IN ('approve','reject','remove') OR p_revision IS NULL
   OR p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Complete reviewed decision required';
 END IF;
 SELECT * INTO l FROM public.listings WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR l.seller_id=auth.uid() THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Review record not available';
 END IF;
 IF l.status <> 'pending_review' OR l.revision IS DISTINCT FROM p_revision
   OR app_security.family_review_fingerprint(p_id) IS DISTINCT FROM p_fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='Review changed; refresh the complete evidence before deciding';
 END IF;
 SELECT count(*) INTO ctx_count FROM (
    SELECT listing_id FROM public.listing_vehicle_contexts WHERE listing_id=p_id AND category_id=l.category_id
    UNION ALL SELECT listing_id FROM public.listing_car_contexts WHERE listing_id=p_id AND category_id=l.category_id
    UNION ALL SELECT listing_id FROM public.listing_property_contexts WHERE listing_id=p_id AND category_id=l.category_id
 ) contexts;
 IF ctx_count<>1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Saved family category/context invalid'; END IF;
 IF p_action='approve' THEN
   SELECT count(*),count(*) FILTER(WHERE processing_status='ready') INTO photo_total,photo_ready
   FROM public.listing_media WHERE listing_id=p_id;
   IF photo_total NOT BETWEEN 1 AND 8 OR photo_total<>photo_ready THEN
      RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Review requires one-to-eight fully processed photos';
   END IF;
   IF l.cover_photo_id IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM public.listing_media WHERE listing_id=p_id AND id=l.cover_photo_id AND processing_status='ready'
   ) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Review cover image changed'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.categories WHERE id=l.category_id AND is_active) THEN
     RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Listing category is disabled';
   END IF;
 END IF;
 IF p_action IN ('reject','remove') AND length(btrim(coalesce(p_reason,'')))<3 THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='A meaningful review reason is required';
 END IF;
 INSERT INTO app_security.family_review_permits(listing_id,transaction_id,requested_status)
 VALUES (p_id,txid_current(),
   CASE p_action WHEN 'approve' THEN 'active'::public.listing_status_enum
     WHEN 'reject' THEN 'rejected'::public.listing_status_enum ELSE 'removed'::public.listing_status_enum END);
 row_result:=app_security.impl_moderate_listing(p_id,p_action,p_reason);
 DELETE FROM app_security.family_review_permits
 WHERE listing_id=p_id AND transaction_id=txid_current();
 RETURN row_result;
END $$;
REVOKE ALL ON FUNCTION app_security.impl_moderate_family_reviewed(uuid,text,text,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_moderate_family_reviewed(uuid,text,text,integer,text) TO authenticated;
CREATE OR REPLACE FUNCTION public.moderate_family_reviewed(
 listing_id uuid,action text,reason text,expected_revision integer,expected_fingerprint text
) RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
 SELECT app_security.impl_moderate_family_reviewed(listing_id,action,reason,expected_revision,expected_fingerprint);
$$;
REVOKE ALL ON FUNCTION public.moderate_family_reviewed(uuid,text,text,integer,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.moderate_family_reviewed(uuid,text,text,integer,text) TO authenticated;

COMMIT;
