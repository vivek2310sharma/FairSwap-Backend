-- =============================================================================
-- Migration 37c: Invalidate Resubmission Review Token
-- =============================================================================
-- Purpose:
-- Close moderation review-generation collision when a previously rejected
-- listing is resubmitted by the seller without editing content fields:
--   pending_review -> rejected -> pending_review
--
-- Security boundary:
-- 1. When a listing transitions from 'rejected' to 'pending_review' via
--    app_security.impl_seller_submit_listing, listings.revision MUST increment
--    (v_listing.revision + 1) to invalidate any prior moderation tokens
--    (expected_revision, expected_status) held by moderators.
-- 2. Clear rejection_reason upon resubmission so stale rejection messages do
--    not linger on newly submitted reviews.
-- 3. For first-time submissions ('draft' -> 'pending_review'), revision is
--    preserved at its initial value (1) without duplicate increments.
-- 4. When a rejected listing was edited prior to submission, Amendment 2 of
--    handle_listing_before_update already transitioned it to 'draft' and
--    incremented revision once; resubmitting that draft preserves the incremented
--    revision without a redundant second bump.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_seller_submit_listing(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
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

  -- Compute revision advancement:
  -- If resubmitting directly from 'rejected', increment revision to invalidate prior review tokens.
  -- Otherwise (draft), keep current revision.
  IF v_listing.status = 'rejected'::public.listing_status_enum THEN
    v_next_revision := v_listing.revision + 1;
  ELSE
    v_next_revision := v_listing.revision;
  END IF;

  -- Update listing status to pending_review, advance revision if resubmitted, and clear rejection_reason
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
$$;
