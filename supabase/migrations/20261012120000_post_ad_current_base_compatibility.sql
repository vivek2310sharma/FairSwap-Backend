-- SOURCE-REVIEW PROPOSAL ONLY: not applied, not approved for execution.
-- Forward-only compatibility after all owner/Test and MOD-02B definitions.
-- Replaces three existing function bodies; preserves signatures/owners/grants.
-- No triggers, policies, queues, worker, dispatcher or activation changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

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
  v_next_revision integer;
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

  -- Preserve current staging MOD-02B rejected-resubmission review invalidation.
  IF v_listing.status = 'rejected'::public.listing_status_enum THEN
    v_next_revision := v_listing.revision + 1;
  ELSE
    v_next_revision := v_listing.revision;
  END IF;

  -- Update listing status to pending_review
  UPDATE public.listings
  SET status = 'pending_review'::public.listing_status_enum,
      revision = v_next_revision,
      rejection_reason = NULL,
      cover_photo_id = v_cover_id,
      submitted_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_listing_id;

  RETURN jsonb_build_object(
    'success', true,
    'listing_id', p_listing_id,
    'status', 'pending_review',
    'revision', v_next_revision
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
  v_listing_id uuid;
  parent public.listings;
  scoped boolean:=false;
  supplied_path text;
BEGIN
  -- All families, including Goods: lock the parent before the media attachment.
  SELECT listing_id INTO v_listing_id
  FROM public.listing_media WHERE id = p_media_id;
  IF v_listing_id IS NULL THEN
    RAISE EXCEPTION 'media record % not found', p_media_id;
  END IF;
  SELECT * INTO parent FROM public.listings WHERE id = v_listing_id FOR UPDATE;
  IF parent.id IS NULL THEN
    RAISE EXCEPTION 'listing record % not found', v_listing_id;
  END IF;
  scoped := app_security.submission_family(parent.id,parent.category_id) is not null;
  if scoped then
    if current_setting('role',true) is distinct from 'service_role' then raise exception using errcode='42501',message='Accepted media worker required'; end if;
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

  IF v_media.id IS NULL OR v_media.listing_id IS DISTINCT FROM v_listing_id THEN
    RAISE EXCEPTION 'media record % not found or reassociated', p_media_id;
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

-- Single revision owner for accepted pending ready completion; no trigger changes.
CREATE OR REPLACE FUNCTION app_security.test_submission_child_change() returns trigger
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
  -- Authorization/lifecycle checks above remain authoritative. For this accepted
  -- pending ready transition, the enabled staging AFTER handler owns invalidation.
  if l.status='pending_review' and old.processing_status is distinct from new.processing_status
     and new.processing_status='ready'::public.media_processing_status_enum
     and exists (
       select 1 from pg_catalog.pg_trigger t
       join pg_catalog.pg_attribute a on a.attrelid=t.tgrelid and a.attname='processing_status'
       where t.tgrelid=tg_relid and t.tgname='trg_listing_media_after_processing_update'
         and t.tgfoid='public.handle_listing_media_after_processing_update()'::pg_catalog.regprocedure
         and t.tgtype=17 and t.tgenabled in ('O','A') and t.tgqual is null
         and t.tgnargs=0 and t.tgattr::text=a.attnum::text
     ) then
    return new;
  end if;
 end if;
 update public.listings set revision=revision+1 where id=lid;
 return case when tg_op='DELETE' then old else new end;
end $$;

COMMIT;
