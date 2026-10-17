-- Migration 26: 20260930000026_fix_india_location_admin_and_lookup.sql
-- Fix India administrative location semantics in public.lookup_pincode (#81):
-- 1. State = postal state, District = postal district. Taluk remains raw metadata only.
-- 2. Legacy 'city' JSON field returns district (administrative anchor alias), NEVER Taluk.
-- 3. Compatibility city_id resolved strictly using lower(name) = lower(district) AND lower(state) = lower(state).
-- 4. Conflicting state/district boundaries within a single PIN fail explicitly instead of using arbitrary MAX(...).
-- 5. Preserves localities[].city_id as authoritative FK source.

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
  v_district text;
  v_city_id uuid;
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

  -- 1. Check existence and detect boundary conflict across state and district
  SELECT 
    count(DISTINCT lower(trim(state))),
    count(DISTINCT lower(trim(district))),
    min(state),
    min(district)
  INTO v_state_count, v_district_count, v_state, v_district
  FROM public.india_postal_data
  WHERE pincode = v_pincode;

  IF v_state_count = 0 OR v_state_count IS NULL THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'PINCODE_NOT_FOUND',
      'message', 'PIN code not found in postal database'
    );
  END IF;

  IF v_state_count > 1 OR v_district_count > 1 THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'CONFLICTING_POSTAL_BOUNDARIES',
      'message', 'PIN code maps to multiple administrative districts or states'
    );
  END IF;

  -- 2. Fetch raw postal records from india_postal_data (taluk remains raw metadata only)
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

  -- 3. Fetch linked FairSwap localities for this pincode
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

  -- 4. Check if compatibility city match exists strictly by district AND state
  SELECT id INTO v_city_id
  FROM public.cities
  WHERE is_active = true
    AND lower(name) = lower(v_district)
    AND lower(state) = lower(v_state)
  LIMIT 1;

  RETURN jsonb_build_object(
    'success', true,
    'pincode', v_pincode,
    'state', v_state,
    'district', v_district,
    'city', v_district, -- legacy backwards-compatibility alias; represents district, NEVER taluk
    'city_id', v_city_id,
    'postal_offices', v_postal_records,
    'localities', COALESCE(v_localities, '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_pincode(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_pincode(text)
  TO anon, authenticated, service_role;
