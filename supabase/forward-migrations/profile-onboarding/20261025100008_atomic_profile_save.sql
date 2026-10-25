-- Atomic profile save + legacy-safe validation.
--  * save_my_profile_details: public fields and (when a PIN/locality is supplied) the private
--    location details are written in ONE function call/transaction. Every validation runs BEFORE
--    any write, so a rejected request writes nothing; any unexpected exception rolls back both.
--    Without a PIN/locality it behaves as a public-only save, so legacy users can still edit
--    public fields; the optional private full name can be set or explicitly cleared without a PIN.
--  * Public text is validated only when it differs from the stored value, so a legacy profile
--    whose existing name/bio would fail today's rules can still save unrelated fields.
--  * complete_my_profile / save_my_public_profile are re-declared (same signatures, grants kept)
--    to share the helpers below. Error codes and result shapes are unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Shared helper: returns NULL when OK, else {success:false,error,reason?}.
-- Validates display name / bio only when changed relative to the stored profile.
CREATE OR REPLACE FUNCTION app_security.check_profile_public_fields(
  p_uid uuid,
  p_display_name text,
  p_bio text
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_cur_name text;
  v_cur_bio text;
  v_found boolean;
  v_reason text;
BEGIN
  SELECT p.display_name, p.bio, true INTO v_cur_name, v_cur_bio, v_found
  FROM public.profiles p WHERE p.id = p_uid;
  IF v_found IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'PROFILE_NOT_FOUND');
  END IF;

  IF p_display_name IS DISTINCT FROM v_cur_name THEN
    v_reason := app_security.validate_public_text(p_display_name, 'display_name');
    IF v_reason IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_DISPLAY_NAME', 'reason', v_reason);
    END IF;
  END IF;
  IF p_bio IS NOT NULL AND p_bio IS DISTINCT FROM v_cur_bio THEN
    v_reason := app_security.validate_public_text(p_bio, 'bio');
    IF v_reason IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_BIO', 'reason', v_reason);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION app_security.check_profile_public_fields(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- Shared helper: server-side PIN / locality / district resolution (no writes).
-- Never accepts names from the client; reuses public.lookup_pincode and the postal mappings.
CREATE OR REPLACE FUNCTION app_security.resolve_profile_location(
  p_pin_code text,
  p_locality_id uuid,
  p_city_id uuid
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pin text := pg_catalog.btrim(COALESCE(p_pin_code, ''));
  v_lookup jsonb;
  v_districts jsonb;
  v_state text;
  v_loc_city uuid;
  v_loc_name text;
  v_city_name text;
  v_city_state text;
BEGIN
  IF v_pin !~ '^[1-9][0-9]{5}$' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_PINCODE');
  END IF;
  IF p_locality_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'LOCALITY_REQUIRED');
  END IF;

  v_lookup := public.lookup_pincode(v_pin);
  IF COALESCE((v_lookup->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false, 'error', COALESCE(v_lookup->>'error', 'PINCODE_NOT_FOUND'));
  END IF;
  v_state := v_lookup->>'state';
  v_districts := COALESCE(v_lookup->'districts', '[]'::jsonb);

  SELECT l.city_id, l.name, c.name, c.state
  INTO v_loc_city, v_loc_name, v_city_name, v_city_state
  FROM public.postal_pincode_localities ppl
  JOIN public.localities l ON l.id = ppl.locality_id AND l.is_active
  JOIN public.cities c ON c.id = l.city_id AND c.is_active
  WHERE ppl.pincode = v_pin AND ppl.locality_id = p_locality_id;

  IF v_loc_city IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'PIN_LOCALITY_MISMATCH');
  END IF;
  IF pg_catalog.jsonb_array_length(v_districts) > 1 AND p_city_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'DISTRICT_REQUIRED');
  END IF;
  IF p_city_id IS NOT NULL AND p_city_id <> v_loc_city THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'DISTRICT_MISMATCH');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.jsonb_array_elements(v_districts) d
    WHERE d->>'city_id' = v_loc_city::text
  ) OR pg_catalog.lower(v_city_state) <> pg_catalog.lower(v_state) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'DISTRICT_MISMATCH');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'pin_code', v_pin,
    'locality_id', p_locality_id,
    'city_id', v_loc_city,
    'locality', v_loc_name,
    'district', v_city_name,
    'state', v_city_state
  );
END;
$$;
REVOKE ALL ON FUNCTION app_security.resolve_profile_location(text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- save_my_public_profile: unchanged contract; now legacy-safe (validates changed values only).
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
  v_err jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  IF app_security.get_account_status(v_uid) IS DISTINCT FROM 'active'
     OR NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'ACCOUNT_RESTRICTED');
  END IF;

  v_err := app_security.check_profile_public_fields(v_uid, v_name, v_bio);
  IF v_err IS NOT NULL THEN
    RETURN v_err;
  END IF;

  UPDATE public.profiles SET display_name = v_name, bio = v_bio WHERE id = v_uid;
  RETURN pg_catalog.jsonb_build_object('success', true, 'display_name', v_name, 'bio', v_bio);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_save_my_public_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_save_my_public_profile(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- complete_my_profile: unchanged contract; location checks now in the shared resolver.
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
  v_name text := NULLIF(pg_catalog.btrim(COALESCE(p_full_name, '')), '');
  v_lang text := COALESCE(NULLIF(pg_catalog.btrim(p_preferred_language), ''), 'en');
  v_loc jsonb;
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

  v_loc := app_security.resolve_profile_location(p_pin_code, p_locality_id, p_city_id);
  IF (v_loc->>'success')::boolean IS NOT TRUE THEN
    RETURN v_loc;
  END IF;

  INSERT INTO public.user_private_details AS d (
    user_id, full_name, pin_code, locality_id, city_id, state,
    preferred_language, onboarding_completed_at
  ) VALUES (
    v_uid, v_name, v_loc->>'pin_code', (v_loc->>'locality_id')::uuid, (v_loc->>'city_id')::uuid,
    v_loc->>'state', 'en', pg_catalog.clock_timestamp()
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
    'locality', v_loc->>'locality',
    'district', v_loc->>'district',
    'state', v_loc->>'state'
  );
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_complete_my_profile(text, text, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_complete_my_profile(text, text, uuid, uuid, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- save_my_profile_details(...) -> jsonb   (single Save Changes action)
--   success: {success:true, display_name, bio, onboarding_completed, locality?, district?, state?}
--   errors : union of save_my_public_profile and complete_my_profile codes; nothing is written
--            when success is false.
-- Location is processed only when p_pin_code or p_locality_id is supplied; without it the call
-- is a public-only save (plus an optional private full-name change) and never marks onboarding
-- complete, so legacy users keep public-only editing.
-- Full-name semantics (private, optional):
--   p_clear_full_name = true            -> full_name is set to NULL (no PIN needed)
--   p_full_name non-empty               -> full_name is set to the trimmed value
--   p_full_name NULL/empty, clear=false -> full_name is left UNCHANGED
--   non-empty p_full_name with clear=true is contradictory -> INVALID_FULL_NAME (nothing written)
-- Clearing never creates a private row on its own.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_save_my_profile_details(
  p_display_name text,
  p_bio text,
  p_full_name text,
  p_pin_code text,
  p_locality_id uuid,
  p_city_id uuid,
  p_preferred_language text,
  p_clear_full_name boolean
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_disp text := pg_catalog.btrim(COALESCE(p_display_name, ''));
  v_bio text := NULLIF(pg_catalog.btrim(COALESCE(p_bio, '')), '');
  v_name text := NULLIF(pg_catalog.btrim(COALESCE(p_full_name, '')), '');
  v_clear boolean := COALESCE(p_clear_full_name, false);
  v_lang text := COALESCE(NULLIF(pg_catalog.btrim(p_preferred_language), ''), 'en');
  v_has_location boolean :=
    NULLIF(pg_catalog.btrim(COALESCE(p_pin_code, '')), '') IS NOT NULL OR p_locality_id IS NOT NULL;
  v_err jsonb;
  v_loc jsonb;
  v_done boolean;
BEGIN
  IF v_uid IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  IF app_security.get_account_status(v_uid) IS DISTINCT FROM 'active'
     OR NOT app_security.has_current_policy_acceptance(v_uid) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'ACCOUNT_RESTRICTED');
  END IF;

  -- 1. Validate everything first; no writes happen before all checks pass.
  v_err := app_security.check_profile_public_fields(v_uid, v_disp, v_bio);
  IF v_err IS NOT NULL THEN
    RETURN v_err;
  END IF;
  IF v_lang <> 'en' THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_LANGUAGE');
  END IF;
  IF v_name IS NOT NULL AND (pg_catalog.char_length(v_name) > 100 OR v_name ~ '[\x00-\x1F\x7F]') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_FULL_NAME');
  END IF;
  IF v_clear AND v_name IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_FULL_NAME', 'reason', 'conflicting_clear');
  END IF;
  IF v_has_location THEN
    v_loc := app_security.resolve_profile_location(p_pin_code, p_locality_id, p_city_id);
    IF (v_loc->>'success')::boolean IS NOT TRUE THEN
      RETURN v_loc;
    END IF;
  END IF;

  -- 2. Write public + private in this single transaction.
  UPDATE public.profiles SET display_name = v_disp, bio = v_bio WHERE id = v_uid;

  IF v_has_location THEN
    INSERT INTO public.user_private_details AS d (
      user_id, full_name, pin_code, locality_id, city_id, state,
      preferred_language, onboarding_completed_at
    ) VALUES (
      v_uid, v_name, v_loc->>'pin_code', (v_loc->>'locality_id')::uuid, (v_loc->>'city_id')::uuid,
      v_loc->>'state', 'en', pg_catalog.clock_timestamp()
    )
    ON CONFLICT (user_id) DO UPDATE SET
      full_name = CASE WHEN v_clear THEN NULL ELSE COALESCE(v_name, d.full_name) END,
      pin_code = EXCLUDED.pin_code,
      locality_id = EXCLUDED.locality_id,
      city_id = EXCLUDED.city_id,
      state = EXCLUDED.state,
      preferred_language = EXCLUDED.preferred_language,
      onboarding_completed_at = COALESCE(d.onboarding_completed_at, EXCLUDED.onboarding_completed_at);
  ELSIF v_name IS NOT NULL THEN
    INSERT INTO public.user_private_details AS d (user_id, full_name)
    VALUES (v_uid, v_name)
    ON CONFLICT (user_id) DO UPDATE SET full_name = EXCLUDED.full_name;
  ELSIF v_clear THEN
    UPDATE public.user_private_details SET full_name = NULL WHERE user_id = v_uid;
  END IF;

  SELECT d.onboarding_completed_at IS NOT NULL INTO v_done
  FROM public.user_private_details d WHERE d.user_id = v_uid;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'display_name', v_disp,
    'bio', v_bio,
    'onboarding_completed', COALESCE(v_done, false)
  ) || CASE WHEN v_has_location THEN pg_catalog.jsonb_build_object(
    'locality', v_loc->>'locality', 'district', v_loc->>'district', 'state', v_loc->>'state')
    ELSE '{}'::jsonb END;
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_save_my_profile_details(text, text, text, text, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_save_my_profile_details(text, text, text, text, uuid, uuid, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.save_my_profile_details(
  p_display_name text,
  p_bio text DEFAULT NULL,
  p_full_name text DEFAULT NULL,
  p_pin_code text DEFAULT NULL,
  p_locality_id uuid DEFAULT NULL,
  p_city_id uuid DEFAULT NULL,
  p_preferred_language text DEFAULT 'en',
  p_clear_full_name boolean DEFAULT false
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_save_my_profile_details(
  p_display_name, p_bio, p_full_name, p_pin_code, p_locality_id, p_city_id, p_preferred_language,
  p_clear_full_name) $$;
REVOKE ALL ON FUNCTION public.save_my_profile_details(text, text, text, text, uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_my_profile_details(text, text, text, text, uuid, uuid, text, boolean) TO authenticated;

commit;
