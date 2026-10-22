-- Apply after family-review-core.sql on FairSwapTest only.
-- Preserves existing Test draft/submit permits; adds reviewed human decisions.

CREATE OR REPLACE FUNCTION app_security.test_submission_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE family text; permitted text;
BEGIN
 family:=app_security.submission_family(
   case when tg_op='DELETE' then old.id else new.id end,
   case when tg_op='DELETE' then old.category_id else new.category_id end
 );
 IF family IS NULL THEN RETURN case when tg_op='DELETE' then old else new end; END IF;
 IF tg_op='DELETE' THEN
   IF old.status<>'draft' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Awaiting review is read-only'; END IF;
   RETURN old;
 END IF;
 IF tg_op='INSERT' THEN
   IF new.status<>'draft' THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Family listing must start as a draft'; END IF;
   RETURN new;
 END IF;
 SELECT operation INTO permitted FROM app_security.test_submission_permits
 WHERE listing_id=old.id AND transaction_id=txid_current();
 IF old.status='draft' AND new.status='draft' THEN
   new.revision:=old.revision+1;
 ELSIF old.status='draft' AND new.status='pending_review' AND permitted='submit' THEN
   new.revision:=old.revision+1;
 ELSIF old.status='pending_review' AND new.status='pending_review' AND permitted='worker'
   AND (to_jsonb(new)-'revision'-'updated_at'-'search_vector')=
       (to_jsonb(old)-'revision'-'updated_at'-'search_vector') THEN
   new.revision:=old.revision+1;
 ELSIF old.status='pending_review' AND new.status IN ('active','rejected','removed')
   AND EXISTS(SELECT 1 FROM app_security.family_review_permits p
       WHERE p.listing_id=old.id AND p.transaction_id=txid_current()
       AND p.requested_status=new.status) THEN
   new.revision:=old.revision+1;
 ELSE
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Family status transition is not authorized';
 END IF;
 RETURN new;
END $$;

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
  if new.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Two-wheeler status transition not authorized'; end if;
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
  if new.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Car status transition not authorized'; end if;
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
  if new.status not in ('draft','pending_review','active','rejected','removed') then raise exception using errcode='22023',message='Property status transition not authorized'; end if;
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
    if c.listing_id is null or c.category_id<>l.category_id or l.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Atomic vehicle context/category required; context/category mismatch'; end if;
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
    if c.listing_id is null or c.category_id<>l.category_id or l.status not in ('draft','pending_review','active','rejected','removed') then raise exception 'Atomic car context/category required; context/category mismatch'; end if;
    select p.fields into fields from public.car_category_contracts p where p.category_id=c.category_id and p.version_id=c.version_id;
    if not found then raise exception using errcode='22023',message='Car category/version reference unavailable'; end if;
    perform app_security.validate_car_answers(l.category_attributes,fields,l.category_attributes);
  elsif c.listing_id is not null then raise exception 'Car context cannot attach to unrelated category'; end if;
  return null;
end $function$
;
