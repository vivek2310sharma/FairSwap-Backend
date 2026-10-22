-- FairSwapTest-only approved human-review extension. No family activation (already enabled in Test).
-- Source-of-truth: exact reviewed SQL in this file; apply only to FairSwapTest.
BEGIN;
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

COMMIT;
