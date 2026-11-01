-- =============================================================================
-- FairSwap Moderation V1 Test Fixture Bootstrap
-- Compatible with PostgreSQL 17 disposable testing
-- Re-creates minimum required schema (auth, app_security, vault, categories,
-- locations, listings, listing_media, requests, settings)
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS app_security;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS vault;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgtap;

-- Roles
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA public, auth, app_security, extensions TO anon, authenticated, service_role;

-- 1. auth.users & helpers
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text,
  account_status text NOT NULL DEFAULT 'active',
  policy_accepted boolean NOT NULL DEFAULT true
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- 2. app_security helpers
CREATE OR REPLACE FUNCTION app_security.get_account_status(p_user_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT account_status FROM auth.users WHERE id = p_user_id), 'not_found');
$$;

CREATE OR REPLACE FUNCTION app_security.has_current_policy_acceptance(p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT COALESCE((SELECT policy_accepted FROM auth.users WHERE id = p_user_id), false);
$$;

CREATE OR REPLACE FUNCTION app_security.log_audit_event(
  p_event_name text,
  p_target_table text,
  p_target_id uuid,
  p_details jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- Test stub
END;
$$;

-- 3. vault.decrypted_secrets view stub
CREATE TABLE IF NOT EXISTS vault._secrets (
  name text PRIMARY KEY,
  decrypted_secret text
);

CREATE OR REPLACE VIEW vault.decrypted_secrets AS
  SELECT name, decrypted_secret FROM vault._secrets;

GRANT SELECT ON vault.decrypted_secrets TO service_role;

-- 4. public.app_system_settings
CREATE TABLE IF NOT EXISTS public.app_system_settings (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL
);

INSERT INTO public.app_system_settings (setting_key, setting_value)
VALUES ('moderation_automation_enabled', 'true')
ON CONFLICT (setting_key) DO UPDATE SET setting_value = 'true';

-- 5. Categories & Cities
CREATE TABLE IF NOT EXISTS public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  name text NOT NULL
);

-- 6. Enums
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'listing_status_enum') THEN
    CREATE TYPE public.listing_status_enum AS ENUM (
      'draft', 'pending_review', 'active', 'reserved', 'sold', 'rejected', 'paused', 'expired', 'removed'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_decision_state') THEN
    CREATE TYPE public.moderation_decision_state AS ENUM (
      'auto_approved', 'routed_to_admin', 'awaiting_retry', 'escalated_to_admin', 'rejected_invalid', 'superseded'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_outcome_enum') THEN
    CREATE TYPE public.moderation_outcome_enum AS ENUM (
      'no_review_flags', 'needs_review', 'checks_incomplete', 'invalid_input'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'moderation_request_status') THEN
    CREATE TYPE public.moderation_request_status AS ENUM (
      'pending', 'claimed', 'completed', 'retry', 'failed', 'superseded'
    );
  END IF;
END $$;

-- 7. Listings
CREATE TABLE IF NOT EXISTS public.listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL REFERENCES auth.users(id),
  title text NOT NULL,
  description text,
  category_id uuid REFERENCES public.categories(id),
  city_id uuid REFERENCES public.cities(id),
  status public.listing_status_enum NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  cover_photo_id uuid,
  published_at timestamptz,
  expires_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 8. Listing Media
CREATE TABLE IF NOT EXISTS public.listing_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  original_storage_path text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  processing_status text NOT NULL DEFAULT 'ready',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 9. Listing Moderation Requests & Results
CREATE TABLE IF NOT EXISTS public.listing_moderation_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL,
  generation_id uuid NOT NULL,
  status public.moderation_request_status NOT NULL DEFAULT 'pending',
  claim_token uuid,
  claim_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  evaluated_title text NOT NULL,
  evaluated_description text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS public.listing_moderation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.listing_moderation_requests(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL,
  generation_id uuid NOT NULL,
  outcome public.moderation_outcome_enum NOT NULL,
  ruleset_version text NOT NULL,
  scope text NOT NULL,
  completed_rules text[] NOT NULL DEFAULT ARRAY[]::text[],
  failed_rules text[] NOT NULL DEFAULT ARRAY[]::text[],
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision public.moderation_decision_state NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

