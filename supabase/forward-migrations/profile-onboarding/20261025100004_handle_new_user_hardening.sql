-- Harden handle_new_user: never derive the public name from the email address;
-- invalid/impersonating metadata names fall back to a neutral generated name instead
-- of failing signup. Consent / age / policy logic is preserved verbatim from
-- 20260918000020. Seeds an (incomplete) private-details row.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_display_name text;
  v_terms_accepted text;
  v_terms_version text;
  v_privacy_version text;
  v_acceptable_use_version text;
  v_age_confirmed text;
  v_min_age smallint;
  v_is_valid_consent boolean;
BEGIN
  v_display_name := pg_catalog.btrim(COALESCE(NEW.raw_user_meta_data->>'display_name', ''));
  -- Metadata is untrusted: validate; never fall back to the email local part.
  IF app_security.validate_public_text(v_display_name, 'display_name') IS NOT NULL THEN
    v_display_name := 'Member-' || pg_catalog.translate(
      pg_catalog.substr(pg_catalog.replace(gen_random_uuid()::text, '-', ''), 1, 8),
      '0123456789', 'ghjkmnpqrs');
  END IF;

  v_terms_accepted := NEW.raw_user_meta_data->>'terms_accepted';
  v_terms_version := NULLIF(TRIM(NEW.raw_user_meta_data->>'terms_version'), '');
  v_privacy_version := NULLIF(TRIM(NEW.raw_user_meta_data->>'privacy_policy_version'), '');
  v_acceptable_use_version := NULLIF(TRIM(NEW.raw_user_meta_data->>'acceptable_use_version'), '');
  v_age_confirmed := NEW.raw_user_meta_data->>'age_confirmed';

  -- Never trust client-supplied minimum_age_confirmed.
  IF COALESCE(v_age_confirmed, 'false') = 'true' THEN
    v_min_age := 18;
  ELSE
    v_min_age := NULL;
  END IF;

  v_is_valid_consent := (
    COALESCE(v_terms_accepted, 'false') = 'true' AND
    v_terms_version = '2026-09-18' AND
    v_privacy_version = '2026-09-18' AND
    v_acceptable_use_version = '2026-09-18' AND
    COALESCE(v_age_confirmed, 'false') = 'true' AND
    v_min_age = 18
  );

  IF v_is_valid_consent IS NOT TRUE THEN
    RAISE EXCEPTION 'Registration rejected: mandatory Terms acceptance, Privacy acknowledgement, Acceptable Use acceptance, and 18+ age confirmation are required with current policy versions.';
  END IF;

  INSERT INTO public.profiles (
    id, display_name, avatar_url, bio, city, state, created_at, updated_at
  ) VALUES (
    NEW.id, v_display_name, NULL, NULL, NULL, NULL, NEW.created_at, NEW.created_at
  );

  INSERT INTO public.user_accounts (
    user_id,
    account_status,
    terms_accepted_at,
    terms_version,
    privacy_policy_version,
    acceptable_use_version,
    age_confirmed_at,
    minimum_age_confirmed,
    notification_preferences,
    optional_contact_preferences,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    'active',
    NEW.created_at,
    '2026-09-18',
    '2026-09-18',
    '2026-09-18',
    NEW.created_at,
    18,
    '{"email_notifications": true}'::jsonb,
    '{}'::jsonb,
    NEW.created_at,
    NEW.created_at
  );

  INSERT INTO public.user_private_details (user_id) VALUES (NEW.id)
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

commit;
