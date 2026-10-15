-- Migration 1: 20260914000001_create_accounts_and_profiles.sql
-- Accounts, Profiles, Trusted Provisioning Trigger, and app_security Schema

-- 1. Create account_status_enum
CREATE TYPE public.account_status_enum AS ENUM (
  'active',
  'suspended',
  'deletion_pending',
  'deleted'
);

-- 2. Create public.profiles
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  avatar_url text,
  bio text,
  city text,
  state text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 3. Create public.user_accounts
CREATE TABLE public.user_accounts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  account_status public.account_status_enum NOT NULL DEFAULT 'active',
  terms_accepted_at timestamptz NOT NULL,
  terms_version text NOT NULL,
  privacy_policy_version text NOT NULL,
  notification_preferences jsonb NOT NULL DEFAULT '{"email_notifications": true}'::jsonb,
  optional_contact_preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 4. Create internal app_security schema (unexposed to PostgREST)
CREATE SCHEMA IF NOT EXISTS app_security;
REVOKE ALL ON SCHEMA app_security FROM PUBLIC, authenticated, anon;
GRANT USAGE ON SCHEMA app_security TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA app_security REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, authenticated, anon;

-- 5. Helper: get_account_status (SECURITY DEFINER, search_path = '')
CREATE OR REPLACE FUNCTION app_security.get_account_status(p_user_id uuid)
RETURNS public.account_status_enum
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT account_status FROM public.user_accounts WHERE user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION app_security.get_account_status(uuid) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION app_security.get_account_status(uuid) TO anon, authenticated, service_role;

-- 6. Immutability Triggers
CREATE OR REPLACE FUNCTION public.enforce_profiles_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Profile id is immutable';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Profile created_at is immutable';
  END IF;
  NEW.updated_at = pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_immutability
BEFORE UPDATE ON public.profiles
FOR EACH ROW
EXECUTE FUNCTION public.enforce_profiles_immutability();

CREATE OR REPLACE FUNCTION public.enforce_user_accounts_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'user_accounts user_id is immutable';
  END IF;
  IF NEW.terms_accepted_at IS DISTINCT FROM OLD.terms_accepted_at THEN
    RAISE EXCEPTION 'terms_accepted_at is immutable';
  END IF;
  IF NEW.terms_version IS DISTINCT FROM OLD.terms_version THEN
    RAISE EXCEPTION 'terms_version is immutable';
  END IF;
  IF NEW.privacy_policy_version IS DISTINCT FROM OLD.privacy_policy_version THEN
    RAISE EXCEPTION 'privacy_policy_version is immutable';
  END IF;
  IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'created_at is immutable';
  END IF;
  NEW.updated_at = pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_user_accounts_immutability
BEFORE UPDATE ON public.user_accounts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_user_accounts_immutability();

-- 7. Trusted Provisioning Trigger on auth.users
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
BEGIN
  v_display_name := COALESCE(
    NULLIF(TRIM(NEW.raw_user_meta_data->>'display_name'), ''),
    split_part(NEW.email, '@', 1)
  );
  v_terms_accepted := NEW.raw_user_meta_data->>'terms_accepted';
  v_terms_version := COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'terms_version'), ''), '2026-09-13-draft');
  v_privacy_version := COALESCE(NULLIF(TRIM(NEW.raw_user_meta_data->>'privacy_policy_version'), ''), '2026-09-13-draft');

  -- Create public profile
  INSERT INTO public.profiles (
    id, display_name, avatar_url, bio, city, state, created_at, updated_at
  ) VALUES (
    NEW.id, v_display_name, NULL, NULL, NULL, NULL, NEW.created_at, NEW.created_at
  );

  -- Create private user account with validated consent
  INSERT INTO public.user_accounts (
    user_id,
    account_status,
    terms_accepted_at,
    terms_version,
    privacy_policy_version,
    notification_preferences,
    optional_contact_preferences,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    'active',
    CASE WHEN v_terms_accepted = 'true' THEN NEW.created_at ELSE pg_catalog.clock_timestamp() END,
    v_terms_version,
    v_privacy_version,
    '{"email_notifications": true}'::jsonb,
    '{}'::jsonb,
    NEW.created_at,
    NEW.created_at
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();

-- 8. Row Level Security & Policies
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_accounts ENABLE ROW LEVEL SECURITY;

-- Profiles: Public can view active profiles; owner can view own profile
CREATE POLICY profiles_select_policy ON public.profiles
FOR SELECT USING (
  (id = auth.uid()) OR (app_security.get_account_status(id) = 'active')
);

-- Profiles: Owner can update permitted fields if account is active
CREATE POLICY profiles_update_policy ON public.profiles
FOR UPDATE USING (
  (id = auth.uid()) AND (app_security.get_account_status(auth.uid()) = 'active')
) WITH CHECK (
  (id = auth.uid()) AND (app_security.get_account_status(auth.uid()) = 'active')
);

-- User Accounts: Owner can view own account
CREATE POLICY user_accounts_select_policy ON public.user_accounts
FOR SELECT USING (
  user_id = auth.uid()
);

-- User Accounts: Owner can update own account if active
CREATE POLICY user_accounts_update_policy ON public.user_accounts
FOR UPDATE USING (
  (user_id = auth.uid()) AND (account_status = 'active')
) WITH CHECK (
  (user_id = auth.uid()) AND (account_status = 'active')
);

-- 9. Explicit Data API Grants
REVOKE ALL ON public.profiles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profiles TO anon, authenticated;
GRANT UPDATE (display_name, avatar_url, bio, city, state) ON public.profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;

REVOKE ALL ON public.user_accounts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_accounts TO authenticated;
GRANT UPDATE (notification_preferences, optional_contact_preferences) ON public.user_accounts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_accounts TO service_role;
