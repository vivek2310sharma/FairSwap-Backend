-- Migration 25: 20260929000025_india_postal_location_schema.sql
-- India Postal Data reference table, Postal Pincode to Locality mapping, Listing landmark column, lookup_pincode RPC, and PIN-locality submit integrity validation

-- 1. Create public.india_postal_data table
CREATE TABLE IF NOT EXISTS public.india_postal_data (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pincode text NOT NULL CHECK (pincode ~ '^\d{6}$'),
  office_name text NOT NULL,
  office_type text,
  delivery_status text,
  division text,
  region text,
  circle text,
  taluk text,
  district text NOT NULL,
  state text NOT NULL,
  source text NOT NULL DEFAULT 'data.gov.in',
  source_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_india_postal_data_pincode_office UNIQUE (pincode, office_name)
);

-- 2. Create public.postal_pincode_localities mapping table
-- Preserves source provenance and official post office name mapping
CREATE TABLE IF NOT EXISTS public.postal_pincode_localities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pincode text NOT NULL CHECK (pincode ~ '^\d{6}$'),
  locality_id uuid NOT NULL REFERENCES public.localities(id) ON DELETE CASCADE,
  office_name text,
  source text NOT NULL DEFAULT 'india_post_candidate',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_postal_pincode_locality UNIQUE (pincode, locality_id)
);

-- 3. Add landmark column to public.listings if not exists
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS landmark text CHECK (landmark IS NULL OR length(trim(landmark)) <= 200);

-- 4. Create Indexes
CREATE INDEX IF NOT EXISTS idx_india_postal_data_pincode ON public.india_postal_data(pincode);
CREATE INDEX IF NOT EXISTS idx_india_postal_data_state_district ON public.india_postal_data(state, district);
CREATE INDEX IF NOT EXISTS idx_postal_pincode_localities_pincode ON public.postal_pincode_localities(pincode);
CREATE INDEX IF NOT EXISTS idx_postal_pincode_localities_locality ON public.postal_pincode_localities(locality_id);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.india_postal_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.postal_pincode_localities ENABLE ROW LEVEL SECURITY;

-- RLS Policies (Read-only reference data for all users)
CREATE POLICY india_postal_data_select_policy ON public.india_postal_data
  FOR SELECT USING (true);

CREATE POLICY postal_pincode_localities_select_policy ON public.postal_pincode_localities
  FOR SELECT USING (true);

-- 6. Explicit PostgreSQL Grants
-- Strict denial of direct mutations to anon and authenticated roles
REVOKE ALL ON public.india_postal_data FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.postal_pincode_localities FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.india_postal_data TO anon, authenticated;
GRANT SELECT ON public.postal_pincode_localities TO anon, authenticated;

GRANT ALL ON public.india_postal_data TO service_role;
GRANT ALL ON public.postal_pincode_localities TO service_role;

-- 7. Create lookup_pincode RPC function
CREATE OR REPLACE FUNCTION public.lookup_pincode(p_pincode text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pincode text := trim(p_pincode);
  v_postal_records jsonb;
  v_localities jsonb;
  v_state text;
  v_district text;
  v_city text;
  v_city_id uuid;
BEGIN
  IF v_pincode IS NULL OR v_pincode !~ '^\d{6}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_PINCODE',
      'message', 'PIN code must be exactly 6 numeric digits'
    );
  END IF;

  -- 1. Fetch raw postal records from india_postal_data
  SELECT 
    jsonb_agg(
      jsonb_build_object(
        'office_name', office_name,
        'office_type', office_type,
        'delivery_status', delivery_status,
        'division', division,
        'region', region,
        'circle', circle,
        'taluk', taluk,
        'district', district,
        'state', state
      )
    ),
    MAX(state),
    MAX(district),
    MAX(COALESCE(taluk, district))
  INTO v_postal_records, v_state, v_district, v_city
  FROM public.india_postal_data
  WHERE pincode = v_pincode;

  IF v_postal_records IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PINCODE_NOT_FOUND',
      'message', 'PIN code not found in postal database'
    );
  END IF;

  -- 2. Fetch linked FairSwap localities for this pincode
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'slug', l.slug,
      'city_id', l.city_id,
      'city_name', c.name,
      'state', c.state
    ) ORDER BY l.name ASC
  )
  INTO v_localities
  FROM public.postal_pincode_localities ppl
  JOIN public.localities l ON l.id = ppl.locality_id
  JOIN public.cities c ON c.id = l.city_id
  WHERE ppl.pincode = v_pincode AND l.is_active = true AND c.is_active = true;

  -- 3. Check if city match exists by district/city name in existing cities table
  SELECT id INTO v_city_id
  FROM public.cities
  WHERE is_active = true AND (
    lower(name) = lower(v_district) OR lower(name) = lower(v_city)
  )
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'pincode', v_pincode,
    'state', v_state,
    'district', v_district,
    'city', v_city,
    'city_id', v_city_id,
    'postal_offices', v_postal_records,
    'localities', COALESCE(v_localities, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_pincode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_pincode(text)
  TO anon, authenticated, service_role;

-- 8. Hardened Listing Submission Integrity: app_security.impl_seller_submit_listing
-- Ensures server-side validation that PIN code is valid and locality belongs to the PIN code
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
$$;
