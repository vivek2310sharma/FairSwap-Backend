-- Migration 27: 20260930000027_support_multi_district_pincodes.sql
-- Support multi-district PIN codes within the same state (#81):
-- 1. Multiple districts within the same state succeed and return explicit district options.
-- 2. Multiple states for a single PIN fail closed with CONFLICTING_POSTAL_STATES.
-- 3. Normalized lower(trim(...)) comparisons for state and district.
-- 4. If exactly one district: district, city, city_id populated automatically.
--    If multiple districts: district, city, city_id are null, and districts array lists all options.
-- 5. Fixes localities contract so every locality object includes district (c.name).
-- 6. Taluk remains raw metadata only in postal_offices; never promoted to district or city.

CREATE OR REPLACE FUNCTION public.lookup_pincode(p_pincode text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pincode text := trim(p_pincode);
  v_state_count integer;
  v_district_count integer;
  v_state text;
  v_single_district text;
  v_single_city_id uuid;
  v_districts jsonb;
  v_postal_records jsonb;
  v_localities jsonb;
BEGIN
  IF v_pincode IS NULL OR v_pincode !~ '^\d{6}$' THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'INVALID_PINCODE',
      'message', 'PIN code must be exactly 6 numeric digits'
    );
  END IF;

  -- 1. Check existence and detect boundary conflict across states
  SELECT 
    count(DISTINCT lower(trim(state))),
    count(DISTINCT lower(trim(district))),
    min(state)
  INTO v_state_count, v_district_count, v_state
  FROM public.india_postal_data
  WHERE pincode = v_pincode;

  IF v_state_count = 0 OR v_state_count IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PINCODE_NOT_FOUND',
      'message', 'PIN code not found in postal database'
    );
  END IF;

  -- Cross-state PIN codes represent a critical data-integrity conflict; fail closed
  IF v_state_count > 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'CONFLICTING_POSTAL_STATES',
      'message', 'PIN code maps to multiple states'
    );
  END IF;

  -- 2. Build distinct districts within this state and resolve compatibility city_id for each
  WITH distinct_districts AS (
    SELECT DISTINCT ON (lower(trim(district)))
      district AS district_name
    FROM public.india_postal_data
    WHERE pincode = v_pincode
    ORDER BY lower(trim(district)), district ASC
  ),
  resolved_districts AS (
    SELECT 
      dd.district_name,
      c.id AS city_id
    FROM distinct_districts dd
    LEFT JOIN public.cities c
      ON c.is_active = true
     AND lower(c.name) = lower(dd.district_name)
     AND lower(c.state) = lower(v_state)
    ORDER BY dd.district_name ASC
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'name', district_name,
      'city_id', city_id
    )
  )
  INTO v_districts
  FROM resolved_districts;

  -- If exactly one district exists, resolve top-level district, city, city_id
  IF v_district_count = 1 THEN
    v_single_district := v_districts->0->>'name';
    IF v_districts->0->>'city_id' IS NOT NULL THEN
      v_single_city_id := (v_districts->0->>'city_id')::uuid;
    ELSE
      v_single_city_id := NULL;
    END IF;
  ELSE
    v_single_district := NULL;
    v_single_city_id := NULL;
  END IF;

  -- 3. Fetch raw postal records from india_postal_data (taluk remains raw metadata only)
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
      ) ORDER BY office_name ASC
    )
  INTO v_postal_records
  FROM public.india_postal_data
  WHERE pincode = v_pincode;

  -- 4. Fetch linked FairSwap localities for this pincode
  -- Every locality includes district (c.name)
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', l.id,
      'name', l.name,
      'slug', l.slug,
      'city_id', l.city_id,
      'city_name', c.name,
      'district', c.name,
      'state', c.state
    ) ORDER BY l.name ASC
  )
  INTO v_localities
  FROM public.postal_pincode_localities ppl
  JOIN public.localities l ON l.id = ppl.locality_id
  JOIN public.cities c ON c.id = l.city_id
  WHERE ppl.pincode = v_pincode AND l.is_active = true AND c.is_active = true;

  RETURN jsonb_build_object(
    'success', true,
    'pincode', v_pincode,
    'state', v_state,
    'district', v_single_district,
    'city', v_single_district, -- legacy backwards-compatibility alias; represents district, NEVER taluk
    'city_id', v_single_city_id,
    'districts', COALESCE(v_districts, '[]'::jsonb),
    'localities', COALESCE(v_localities, '[]'::jsonb),
    'postal_offices', COALESCE(v_postal_records, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_pincode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_pincode(text)
  TO anon, authenticated, service_role;
