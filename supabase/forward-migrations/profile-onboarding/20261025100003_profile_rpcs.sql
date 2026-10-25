-- Profile RPCs. Pattern: app_security.impl_* (SECURITY DEFINER, search_path='') +
-- thin public.* SECURITY INVOKER wrapper. Wrapper callers need EXECUTE on BOTH the
-- wrapper and the impl (an invoker wrapper runs the impl call as the caller).
-- Every privileged impl re-checks identity, account status and policy acceptance.
-- Validation failures return {success:false,error:<CODE>} (no exception) so clients
-- can map codes; identity/permission failures use the same shape.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ---------------------------------------------------------------------------
-- save_my_public_profile(p_display_name, p_bio) -> jsonb
-- Works for legacy / not-yet-onboarded users. Never touches private details.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_save_my_public_profile(
  p_display_name text,
  p_bio text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := pg_catalog.btrim(COALESCE(p_display_name, ''));
  v_bio text := NULLIF(pg_catalog.btrim(COALESCE(p_bio, '')), '');
  v_reason text;
BEGIN
  IF v_uid IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  IF app_security.get_account_status(v_uid) IS DISTINCT FROM 'active'
     OR NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'ACCOUNT_RESTRICTED');
  END IF;

  v_reason := app_security.validate_public_text(v_name, 'display_name');
  IF v_reason IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_DISPLAY_NAME', 'reason', v_reason);
  END IF;
  IF v_bio IS NOT NULL THEN
    v_reason := app_security.validate_public_text(v_bio, 'bio');
    IF v_reason IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_BIO', 'reason', v_reason);
    END IF;
  END IF;

  UPDATE public.profiles
  SET display_name = v_name, bio = v_bio
  WHERE id = v_uid;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'PROFILE_NOT_FOUND');
  END IF;

  RETURN pg_catalog.jsonb_build_object('success', true, 'display_name', v_name, 'bio', v_bio);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_save_my_public_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_save_my_public_profile(text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_my_public_profile(p_display_name text, p_bio text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_save_my_public_profile(p_display_name, p_bio) $$;
REVOKE ALL ON FUNCTION public.save_my_public_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_my_public_profile(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- complete_my_profile(p_full_name, p_pin_code, p_locality_id, p_city_id, p_preferred_language)
-- Re-validates the PIN via public.lookup_pincode and the postal mapping tables.
-- Submitted names are never accepted; only ids that must match server-side data.
-- onboarding_completed_at is set only after every check passes.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_complete_my_profile(
  p_full_name text,
  p_pin_code text,
  p_locality_id uuid,
  p_city_id uuid,
  p_preferred_language text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_pin text := pg_catalog.btrim(COALESCE(p_pin_code, ''));
  v_name text := NULLIF(pg_catalog.btrim(COALESCE(p_full_name, '')), '');
  v_lang text := COALESCE(NULLIF(pg_catalog.btrim(p_preferred_language), ''), 'en');
  v_lookup jsonb;
  v_districts jsonb;
  v_state text;
  v_loc_city uuid;
  v_loc_name text;
  v_city_name text;
  v_city_state text;
  v_city_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  IF app_security.get_account_status(v_uid) IS DISTINCT FROM 'active'
     OR NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'ACCOUNT_RESTRICTED');
  END IF;

  IF v_lang <> 'en' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_LANGUAGE');
  END IF;
  IF v_name IS NOT NULL AND (pg_catalog.char_length(v_name) > 100 OR v_name ~ '[\x00-\x1F\x7F]') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_FULL_NAME');
  END IF;
  IF v_pin !~ '^[1-9][0-9]{5}$' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_PINCODE');
  END IF;
  IF p_locality_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'LOCALITY_REQUIRED');
  END IF;

  -- Reuse the canonical postal lookup; failure codes are passed through.
  v_lookup := public.lookup_pincode(v_pin);
  IF COALESCE((v_lookup->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'error', COALESCE(v_lookup->>'error', 'PINCODE_NOT_FOUND')
    );
  END IF;
  v_state := v_lookup->>'state';
  v_districts := COALESCE(v_lookup->'districts', '[]'::jsonb);

  -- Locality must be mapped to this PIN and be active.
  SELECT l.city_id, l.name, c.name, c.state
  INTO v_loc_city, v_loc_name, v_city_name, v_city_state
  FROM public.postal_pincode_localities ppl
  JOIN public.localities l ON l.id = ppl.locality_id AND l.is_active
  JOIN public.cities c ON c.id = l.city_id AND c.is_active
  WHERE ppl.pincode = v_pin AND ppl.locality_id = p_locality_id;

  IF v_loc_city IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'PIN_LOCALITY_MISMATCH');
  END IF;

  -- Multi-district PIN: the user must choose explicitly.
  IF pg_catalog.jsonb_array_length(v_districts) > 1 AND p_city_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'DISTRICT_REQUIRED');
  END IF;
  IF p_city_id IS NOT NULL AND p_city_id <> v_loc_city THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'DISTRICT_MISMATCH');
  END IF;
  v_city_id := v_loc_city;

  -- The locality's district must be one of the PIN's postal districts, in the PIN's state.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(v_districts) d
    WHERE d->>'city_id' = v_city_id::text
  ) OR pg_catalog.lower(v_city_state) <> pg_catalog.lower(v_state) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'DISTRICT_MISMATCH');
  END IF;

  INSERT INTO public.user_private_details AS d (
    user_id, full_name, pin_code, locality_id, city_id, state,
    preferred_language, onboarding_completed_at
  ) VALUES (
    v_uid, v_name, v_pin, p_locality_id, v_city_id, v_city_state,
    'en', pg_catalog.clock_timestamp()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    full_name = EXCLUDED.full_name,
    pin_code = EXCLUDED.pin_code,
    locality_id = EXCLUDED.locality_id,
    city_id = EXCLUDED.city_id,
    state = EXCLUDED.state,
    preferred_language = EXCLUDED.preferred_language,
    onboarding_completed_at = COALESCE(d.onboarding_completed_at, EXCLUDED.onboarding_completed_at);

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'onboarding_completed', true,
    'locality', v_loc_name,
    'district', v_city_name,
    'state', v_city_state
  );
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_complete_my_profile(text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_complete_my_profile(text, text, uuid, uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.complete_my_profile(
  p_full_name text,
  p_pin_code text,
  p_locality_id uuid,
  p_city_id uuid DEFAULT NULL,
  p_preferred_language text DEFAULT 'en'
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_complete_my_profile(p_full_name, p_pin_code, p_locality_id, p_city_id, p_preferred_language) $$;
REVOKE ALL ON FUNCTION public.complete_my_profile(text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_my_profile(text, text, uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- get_my_private_details() -> jsonb  (owner read; INVOKER, relies on owner RLS)
-- Not gated on account status so restricted owners can still read their own data.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_private_details()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT COALESCE((
    SELECT pg_catalog.jsonb_build_object(
      'exists', true,
      'full_name', d.full_name,
      'pin_code', d.pin_code,
      'locality_id', d.locality_id,
      'locality', l.name,
      'city_id', d.city_id,
      'district', c.name,
      'state', d.state,
      'preferred_language', d.preferred_language,
      'onboarding_completed', d.onboarding_completed_at IS NOT NULL,
      'onboarding_completed_at', d.onboarding_completed_at
    )
    FROM public.user_private_details d
    LEFT JOIN public.localities l ON l.id = d.locality_id
    LEFT JOIN public.cities c ON c.id = d.city_id
    WHERE d.user_id = (SELECT auth.uid())
  ), pg_catalog.jsonb_build_object('exists', false, 'onboarding_completed', false))
$$;
REVOKE ALL ON FUNCTION public.get_my_private_details() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_private_details() TO authenticated;

-- ---------------------------------------------------------------------------
-- public_profile_location(p_user_ids uuid[]) -> jsonb
-- The ONLY public projection of private details: locality + district NAMES for
-- active, onboarded accounts. Never returns PIN, ids, full name or state ids.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_public_profile_location(p_user_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'user_id', d.user_id,
    'locality', l.name,
    'district', c.name
  )), '[]'::jsonb)
  FROM public.user_private_details d
  JOIN public.user_accounts ua ON ua.user_id = d.user_id AND ua.account_status = 'active'
  JOIN public.localities l ON l.id = d.locality_id
  JOIN public.cities c ON c.id = d.city_id
  WHERE d.user_id = ANY (p_user_ids[1:50])
    AND d.onboarding_completed_at IS NOT NULL
$$;
REVOKE ALL ON FUNCTION app_security.impl_public_profile_location(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.impl_public_profile_location(uuid[]) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.public_profile_location(p_user_ids uuid[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_public_profile_location(p_user_ids) $$;
REVOKE ALL ON FUNCTION public.public_profile_location(uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_profile_location(uuid[]) TO anon, authenticated, service_role;

commit;
