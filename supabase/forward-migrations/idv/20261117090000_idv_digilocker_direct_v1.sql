-- Migration: 20261117090000_idv_digilocker_direct_v1.sql
-- FairSwap IDV: DigiLocker (MeriPehchaan) direct account-link verification, one-time.
-- Forward-only and additive. Depends on 20261026183000_idv_digilocker_foundation.sql.
-- Stores ONLY a keyed HMAC fingerprint of the 36-char digilockerid. No Aadhaar/PAN/DL data, no raw id.
-- Also adds backend-enforced "active + verified" gating for marketplace mutations, behind a
-- server-side switch (public.app_system_settings.identity_verification_required, default 'false').
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- 0. Enforcement switch (default OFF: nothing changes until the owner enables it after the flow is live)
INSERT INTO public.app_system_settings (setting_key, setting_value, description)
VALUES ('identity_verification_required', 'false',
        'When true, only active + identity-verified users may create/edit/submit listings, upload media, start conversations and send messages')
ON CONFLICT (setting_key) DO NOTHING;

-- 1. Attempts (single-use state, bound to the authenticated user). Only SHA-256 of the state is stored.
CREATE TABLE IF NOT EXISTS app_security.idv_digilocker_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','completed','failed','cancelled','expired')),
  expires_at timestamptz NOT NULL,
  consent_timestamp timestamptz NOT NULL DEFAULT clock_timestamp(),
  consent_purpose text NOT NULL,
  consent_policy_version text NOT NULL,
  failure_code text,
  consumed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS idx_idv_dl_attempts_user_created ON app_security.idv_digilocker_attempts(user_id, created_at DESC);
REVOKE ALL ON app_security.idv_digilocker_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON app_security.idv_digilocker_attempts TO service_role;
ALTER TABLE app_security.idv_digilocker_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.idv_digilocker_attempts FORCE ROW LEVEL SECURITY;

-- 2. Private identity binding. user_id is NOT cascade-deleted: ON DELETE SET NULL keeps a fraud-blocked
--    fingerprint alive after auth.users deletion; a non-blocked binding is deleted with its account (trigger below).
--    fingerprint_key_version records which server HMAC key produced id_fingerprint, so keys can be added without
--    losing duplicate/fraud matching (old keys must stay configured while any binding uses them).
CREATE TABLE IF NOT EXISTS app_security.idv_digilocker_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'digilocker_meripehchaan' CHECK (provider = 'digilocker_meripehchaan'),
  id_fingerprint text NOT NULL CHECK (id_fingerprint ~ '^[0-9a-f]{64}$'),
  fingerprint_key_version text NOT NULL DEFAULT 'v1' CHECK (fingerprint_key_version ~ '^v[0-9]{1,3}$'),
  identity_status text NOT NULL DEFAULT 'linked' CHECK (identity_status IN ('linked','fraud_blocked')),
  linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  fraud_blocked_at timestamptz,
  fraud_blocked_by uuid,
  retention_review_at timestamptz,
  attempt_id uuid REFERENCES app_security.idv_digilocker_attempts(id) ON DELETE SET NULL,
  consent_timestamp timestamptz NOT NULL,
  consent_purpose text NOT NULL,
  consent_policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_idv_dl_provider_fingerprint UNIQUE (provider, id_fingerprint),
  CONSTRAINT chk_idv_dl_fraud_consistent CHECK ((identity_status = 'fraud_blocked') = (fraud_blocked_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_idv_dl_binding_user ON app_security.idv_digilocker_bindings(user_id) WHERE user_id IS NOT NULL;
REVOKE ALL ON app_security.idv_digilocker_bindings FROM PUBLIC, anon, authenticated;
-- No direct DML for any API role (service_role included): only the SECURITY DEFINER functions below touch bindings.
ALTER TABLE app_security.idv_digilocker_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.idv_digilocker_bindings FORCE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_idv_dl_binding_key_version ON app_security.idv_digilocker_bindings(fingerprint_key_version);

-- Fraud blocks can only be released/purged through impl_admin_digilocker_fraud_block_resolve (administrator + AAL2),
-- which sets a transaction-local marker. Accidental code paths (or a future function) cannot unblock or delete them.
CREATE OR REPLACE FUNCTION app_security.trg_idv_dl_binding_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_admin boolean := coalesce(pg_catalog.current_setting('fairswap.idv_dl_admin_resolve', true), '') = 'on';
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.identity_status = 'fraud_blocked' AND NOT v_admin THEN
      RAISE EXCEPTION 'FRAUD_BLOCK_PROTECTED' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.identity_status = 'fraud_blocked' THEN
    IF (NEW.identity_status <> 'fraud_blocked' AND NOT v_admin)
       OR NEW.id_fingerprint IS DISTINCT FROM OLD.id_fingerprint
       OR NEW.fingerprint_key_version IS DISTINCT FROM OLD.fingerprint_key_version THEN
      RAISE EXCEPTION 'FRAUD_BLOCK_PROTECTED' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_idv_dl_binding_guard ON app_security.idv_digilocker_bindings;
CREATE TRIGGER trg_idv_dl_binding_guard BEFORE UPDATE OR DELETE ON app_security.idv_digilocker_bindings
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_idv_dl_binding_guard();

-- Account deletion: the FK sets user_id NULL. A non-blocked binding is then removed (data minimisation);
-- a fraud-blocked one is retained until an administrator review purges it.
CREATE OR REPLACE FUNCTION app_security.trg_idv_dl_binding_orphan_cleanup()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  DELETE FROM app_security.idv_digilocker_bindings WHERE id = NEW.id AND identity_status <> 'fraud_blocked';
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_idv_dl_binding_orphan_cleanup ON app_security.idv_digilocker_bindings;
CREATE TRIGGER trg_idv_dl_binding_orphan_cleanup AFTER UPDATE OF user_id ON app_security.idv_digilocker_bindings
  FOR EACH ROW WHEN (OLD.user_id IS NOT NULL AND NEW.user_id IS NULL AND NEW.identity_status <> 'fraud_blocked')
  EXECUTE FUNCTION app_security.trg_idv_dl_binding_orphan_cleanup();
REVOKE ALL ON FUNCTION app_security.trg_idv_dl_binding_guard(), app_security.trg_idv_dl_binding_orphan_cleanup() FROM PUBLIC, anon, authenticated;

-- 3. Verification predicate + gate helpers
CREATE OR REPLACE FUNCTION app_security.is_identity_verified(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
    AND app_security.get_account_status(p_user_id) = 'active'
    AND EXISTS (
      SELECT 1 FROM public.user_identity_verifications v
      WHERE v.user_id = p_user_id
        AND v.verification_status = 'verified'
        AND v.badge_issued = true
        AND v.revoked_at IS NULL
        AND (v.valid_until IS NULL OR v.valid_until > pg_catalog.clock_timestamp())
    );
$$;
REVOKE ALL ON FUNCTION app_security.is_identity_verified(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.is_identity_verified(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app_security.identity_gate_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT setting_value = 'true' FROM public.app_system_settings
                   WHERE setting_key = 'identity_verification_required' LIMIT 1), false);
$$;
REVOKE ALL ON FUNCTION app_security.identity_gate_enabled() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.identity_gate_enabled() TO authenticated, service_role;

-- Request context. PostgREST/Supabase sets the JWT role ('anon' | 'authenticated' | 'service_role') for every API
-- request, including inside SECURITY DEFINER functions it invokes. NULL means a direct database session
-- (migration, pg_cron, owner maintenance), which already requires database credentials.
CREATE OR REPLACE FUNCTION app_security.idv_request_role()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_role text;
BEGIN
  v_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  IF v_role IS NULL THEN
    BEGIN
      v_role := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
    EXCEPTION WHEN others THEN
      v_role := 'unknown'; -- unparseable claims are an API request of unknown role: never "system"
    END;
  END IF;
  RETURN v_role;
END;
$$;
REVOKE ALL ON FUNCTION app_security.idv_request_role() FROM PUBLIC, anon, authenticated;

-- Explicit, auditable opt-in for a legitimate system write that creates an ownerless row from inside an API request
-- (for example a future SECURITY DEFINER system-message function). Only database-side code can set it:
-- set_config() is not exposed through PostgREST. No current code path sets it.
CREATE OR REPLACE FUNCTION app_security.identity_gate_system_write()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.current_setting('fairswap.identity_gate_system_write', true), '') = 'on';
$$;
REVOKE ALL ON FUNCTION app_security.identity_gate_system_write() FROM PUBLIC, anon, authenticated;

-- p_any_caller = true  (INSERTs): the row owner must be verified whoever performs the write, including
--                         service-role or SECURITY DEFINER paths acting on a user's behalf (no bypass).
-- p_any_caller = false (UPDATEs): enforced when the caller IS the owner, so moderation, media-processing
--                         workers and system status changes keep working.
-- A NULL owner is never treated as a verified actor:
--   INSERT with NULL owner -> allowed only for a direct database session or an explicit system write; any API
--                             caller (anon, authenticated, service_role, unknown) is refused.
--   UPDATE of a NULL-owner (historical) row -> refused for an end user; staff (moderator AAL2+), service-role
--                             and database sessions keep working, so historical rows and moderation are preserved.
CREATE OR REPLACE FUNCTION app_security.enforce_verified_actor(p_actor uuid, p_any_caller boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid uuid;
BEGIN
  IF NOT app_security.identity_gate_enabled() THEN
    RETURN;
  END IF;
  v_uid := auth.uid();
  IF p_actor IS NULL THEN
    IF coalesce(p_any_caller, false) THEN
      IF app_security.idv_request_role() IS NULL OR app_security.identity_gate_system_write() THEN
        RETURN;
      END IF;
      RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF v_uid IS NOT NULL AND NOT app_security.is_active_staff_aal2('moderator') THEN
      RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  IF NOT coalesce(p_any_caller, false) AND (v_uid IS NULL OR v_uid <> p_actor) THEN
    RETURN;
  END IF;
  IF NOT app_security.is_identity_verified(p_actor) THEN
    RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_security.enforce_verified_actor(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.enforce_verified_actor(uuid, boolean) TO service_role;

-- 4. Table triggers: fire for RLS inserts, RPCs and direct PostgREST writes alike.
CREATE OR REPLACE FUNCTION app_security.trg_identity_gate_listings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app_security.enforce_verified_actor(NEW.seller_id, true);
  -- Draft edits, submission, resubmission and (re)publication. Pausing, sold, removal stay open to manage own ads.
  ELSIF NEW.seller_id IS NULL AND OLD.seller_id IS NOT NULL AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NULL; -- owner removed by account deletion (FK SET NULL); not a user edit
  ELSIF NEW.status IN ('draft', 'pending_review', 'active')
        AND (OLD.status = 'draft' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    PERFORM app_security.enforce_verified_actor(OLD.seller_id, false);
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.trg_identity_gate_by_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_seller uuid;
BEGIN
  SELECT seller_id INTO v_seller FROM public.listings WHERE id = (pg_catalog.to_jsonb(NEW) ->> 'listing_id')::uuid;
  PERFORM app_security.enforce_verified_actor(v_seller, TG_OP = 'INSERT');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.trg_identity_gate_posting_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_security.enforce_verified_actor(NEW.owner_id, true);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.trg_identity_gate_staged_media()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.posting_upload_sessions WHERE id = NEW.session_id;
  PERFORM app_security.enforce_verified_actor(v_owner, TG_OP = 'INSERT');
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.trg_identity_gate_conversations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_security.enforce_verified_actor(NEW.buyer_id, true);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_security.trg_identity_gate_messages()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_security.enforce_verified_actor(NEW.sender_id, true);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_security.trg_identity_gate_listings(), app_security.trg_identity_gate_by_listing(),
  app_security.trg_identity_gate_posting_session(), app_security.trg_identity_gate_staged_media(),
  app_security.trg_identity_gate_conversations(), app_security.trg_identity_gate_messages() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_identity_gate ON public.listings;
CREATE TRIGGER trg_identity_gate BEFORE INSERT OR UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_listings();
DROP TRIGGER IF EXISTS trg_identity_gate ON public.listing_media;
CREATE TRIGGER trg_identity_gate BEFORE INSERT ON public.listing_media
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_by_listing();
DROP TRIGGER IF EXISTS trg_identity_gate ON public.conversations;
CREATE TRIGGER trg_identity_gate BEFORE INSERT ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_conversations();
DROP TRIGGER IF EXISTS trg_identity_gate ON public.messages;
CREATE TRIGGER trg_identity_gate BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_messages();

-- Tables that may not exist in every environment (posting v2, category contexts).
DO $$
DECLARE t text;
BEGIN
  IF to_regclass('public.posting_upload_sessions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_identity_gate ON public.posting_upload_sessions;
    CREATE TRIGGER trg_identity_gate BEFORE INSERT ON public.posting_upload_sessions
      FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_posting_session();
  END IF;
  IF to_regclass('public.posting_staged_media') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_identity_gate ON public.posting_staged_media;
    CREATE TRIGGER trg_identity_gate BEFORE INSERT OR UPDATE ON public.posting_staged_media
      FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_staged_media();
  END IF;
  FOREACH t IN ARRAY ARRAY['listing_accessory_contexts','listing_car_contexts','listing_generic_product_identity',
    'listing_mobile_contexts','listing_property_contexts','listing_tablet_contexts','listing_vehicle_contexts',
    'listing_wearable_contexts_v1'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_identity_gate ON public.%I', t);
      EXECUTE format('CREATE TRIGGER trg_identity_gate BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_by_listing()', t);
    END IF;
  END LOOP;
END $$;

-- Audit: idv_audit_events.attempt_id references the Setu attempts table, so DigiLocker events always pass NULL there.
-- 5. Start: server-only. Returns already_verified without any redirect when the account is already verified.
CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_start_attempt(
  p_user_id uuid, p_state_hash text, p_ttl_seconds integer,
  p_consent_purpose text, p_consent_acknowledged boolean, p_policy_version text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_id uuid; v_recent integer; v_blocked boolean;
BEGIN
  IF p_user_id IS NULL OR p_state_hash IS NULL OR p_state_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST');
  END IF;
  IF p_consent_acknowledged IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('success', false, 'error', 'CONSENT_REQUIRED');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));

  IF app_security.get_account_status(p_user_id) IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ELIGIBLE');
  END IF;
  IF app_security.is_identity_verified(p_user_id) THEN
    RETURN jsonb_build_object('success', true, 'already_verified', true);
  END IF;
  SELECT EXISTS (SELECT 1 FROM app_security.idv_digilocker_bindings
                 WHERE user_id = p_user_id AND identity_status = 'fraud_blocked') INTO v_blocked;
  IF v_blocked THEN
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_UNAVAILABLE');
  END IF;

  SELECT count(*) INTO v_recent FROM app_security.idv_digilocker_attempts
  WHERE user_id = p_user_id AND created_at > pg_catalog.clock_timestamp() - interval '1 hour';
  IF v_recent >= 5 THEN
    RETURN jsonb_build_object('success', false, 'error', 'RATE_LIMIT_EXCEEDED');
  END IF;

  UPDATE app_security.idv_digilocker_attempts SET status = 'cancelled'
  WHERE user_id = p_user_id AND status = 'pending';

  INSERT INTO app_security.idv_digilocker_attempts (user_id, state_hash, expires_at, consent_purpose, consent_policy_version)
  VALUES (p_user_id, p_state_hash,
          pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => greatest(60, least(coalesce(p_ttl_seconds, 600), 900))),
          p_consent_purpose, p_policy_version)
  RETURNING id INTO v_id;

  PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_attempt_started', p_user_id, 'user',
    jsonb_build_object('policy_version', p_policy_version));
  RETURN jsonb_build_object('success', true, 'attempt_id', v_id);
END;
$$;

-- 6. Consume state (single use, user-bound). Consumed BEFORE the provider exchange so a code/state can never replay.
CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_consume_state(p_user_id uuid, p_state_hash text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_a RECORD;
BEGIN
  IF p_user_id IS NULL OR p_state_hash IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;
  SELECT * INTO v_a FROM app_security.idv_digilocker_attempts WHERE state_hash = p_state_hash FOR UPDATE;
  IF NOT FOUND OR v_a.user_id <> p_user_id THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;
  IF v_a.status <> 'pending' THEN
    RETURN jsonb_build_object('success', false, 'error', 'STATE_ALREADY_USED');
  END IF;
  IF v_a.expires_at < pg_catalog.clock_timestamp() THEN
    UPDATE app_security.idv_digilocker_attempts SET status = 'expired' WHERE id = v_a.id;
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_EXPIRED');
  END IF;
  UPDATE app_security.idv_digilocker_attempts SET status = 'consumed', consumed_at = pg_catalog.clock_timestamp()
  WHERE id = v_a.id;
  RETURN jsonb_build_object('success', true, 'attempt_id', v_a.id);
END;
$$;

CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_fail_attempt(p_attempt_id uuid, p_user_id uuid, p_code text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  UPDATE app_security.idv_digilocker_attempts
  SET status = 'failed', failure_code = left(coalesce(p_code, 'UNKNOWN'), 64)
  WHERE id = p_attempt_id AND user_id = p_user_id AND status IN ('pending', 'consumed');
  PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_attempt_failed', p_user_id, 'system',
    jsonb_build_object('code', left(coalesce(p_code, 'UNKNOWN'), 64)));
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 7. Atomic link. Serialised per user and per fingerprint; the unique constraint is the final backstop.
CREATE OR REPLACE FUNCTION app_security.impl_idv_dl_complete(
  p_attempt_id uuid, p_user_id uuid, p_id_fingerprint text, p_key_version text,
  p_legacy_fingerprints text[] DEFAULT '{}'::text[]
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_a RECORD; v_b RECORD; v_own RECORD; v_last_event text; v_now timestamptz := pg_catalog.clock_timestamp();
  v_all text[]; v_fp text;
BEGIN
  -- p_id_fingerprint: HMAC under the CURRENT key (p_key_version). p_legacy_fingerprints: the same id under every
  -- older configured key, so duplicate and fraud-block matching survives key rotation.
  IF p_attempt_id IS NULL OR p_user_id IS NULL OR p_id_fingerprint IS NULL OR p_id_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_key_version IS NULL OR p_key_version !~ '^v[0-9]{1,3}$'
     OR coalesce(pg_catalog.array_length(p_legacy_fingerprints, 1), 0) > 8 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_IDENTITY_EVIDENCE');
  END IF;
  v_all := ARRAY[p_id_fingerprint] || coalesce(p_legacy_fingerprints, '{}'::text[]);
  FOREACH v_fp IN ARRAY v_all LOOP
    IF v_fp IS NULL OR v_fp !~ '^[0-9a-f]{64}$' THEN
      RETURN jsonb_build_object('success', false, 'error', 'INVALID_IDENTITY_EVIDENCE');
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_user_id::text));
  -- Racers for the same identity compute the same current-key fingerprint, so this serialises them.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_dl_fp_' || p_id_fingerprint));

  IF app_security.get_account_status(p_user_id) IS DISTINCT FROM 'active' THEN
    RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_NOT_ELIGIBLE');
  END IF;
  SELECT * INTO v_a FROM app_security.idv_digilocker_attempts WHERE id = p_attempt_id AND user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'ATTEMPT_NOT_FOUND');
  END IF;
  IF v_a.status = 'completed' THEN
    RETURN jsonb_build_object('success', true, 'already_verified', true);
  END IF;
  IF v_a.status <> 'consumed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_ATTEMPT_STATE');
  END IF;

  -- Admin revocation of this account must not be undone by self-service relinking.
  SELECT event_type INTO v_last_event FROM app_security.idv_audit_events
  WHERE user_id = p_user_id AND event_type IN ('admin_revocation', 'verification_completed', 'digilocker_linked')
  ORDER BY created_at DESC, id DESC LIMIT 1;
  IF v_last_event = 'admin_revocation' THEN
    UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'REVOKED' WHERE id = p_attempt_id;
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_UNAVAILABLE');
  END IF;

  -- Defensive: purge any non-blocked orphan (normally removed when its account is deleted).
  DELETE FROM app_security.idv_digilocker_bindings
  WHERE provider = 'digilocker_meripehchaan' AND id_fingerprint = ANY (v_all)
    AND user_id IS NULL AND identity_status <> 'fraud_blocked';

  IF EXISTS (SELECT 1 FROM app_security.idv_digilocker_bindings
             WHERE provider = 'digilocker_meripehchaan' AND id_fingerprint = ANY (v_all) AND identity_status = 'fraud_blocked') THEN
    UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'IDENTITY_BLOCKED' WHERE id = p_attempt_id;
    PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_link_rejected', p_user_id, 'system',
      jsonb_build_object('reason', 'blocked_identity'));
    RETURN jsonb_build_object('success', false, 'error', 'VERIFICATION_UNAVAILABLE');
  END IF;

  SELECT * INTO v_b FROM app_security.idv_digilocker_bindings
  WHERE provider = 'digilocker_meripehchaan' AND id_fingerprint = ANY (v_all)
  ORDER BY (user_id IS DISTINCT FROM p_user_id) DESC LIMIT 1 FOR UPDATE;

  IF FOUND THEN
    IF v_b.user_id IS DISTINCT FROM p_user_id THEN
      UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'IDENTITY_ALREADY_LINKED' WHERE id = p_attempt_id;
      PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_link_rejected', p_user_id, 'system',
        jsonb_build_object('reason', 'already_linked'));
      RETURN jsonb_build_object('success', false, 'error', 'IDENTITY_ALREADY_LINKED', 'recovery', true);
    END IF;
    -- Same user, same identity: refresh consent evidence and opportunistically re-key to the current key.
    UPDATE app_security.idv_digilocker_bindings
    SET id_fingerprint = p_id_fingerprint, fingerprint_key_version = p_key_version,
        attempt_id = p_attempt_id, consent_timestamp = v_a.consent_timestamp, consent_purpose = v_a.consent_purpose,
        consent_policy_version = v_a.consent_policy_version, linked_at = v_now, updated_at = v_now
    WHERE id = v_b.id;
  ELSE
    SELECT * INTO v_own FROM app_security.idv_digilocker_bindings WHERE user_id = p_user_id FOR UPDATE;
    IF FOUND THEN
      UPDATE app_security.idv_digilocker_attempts SET status = 'failed', failure_code = 'ACCOUNT_LINKED_TO_OTHER_IDENTITY' WHERE id = p_attempt_id;
      RETURN jsonb_build_object('success', false, 'error', 'ACCOUNT_LINKED_TO_OTHER_IDENTITY');
    END IF;
    INSERT INTO app_security.idv_digilocker_bindings (user_id, id_fingerprint, fingerprint_key_version, attempt_id,
      consent_timestamp, consent_purpose, consent_policy_version, linked_at)
    VALUES (p_user_id, p_id_fingerprint, p_key_version, p_attempt_id,
      v_a.consent_timestamp, v_a.consent_purpose, v_a.consent_policy_version, v_now);
  END IF;

  UPDATE app_security.idv_digilocker_attempts SET status = 'completed', completed_at = v_now WHERE id = p_attempt_id;

  -- One-time verification: valid_until stays NULL (no expiry, no routine reverification).
  INSERT INTO public.user_identity_verifications (user_id, verification_status, badge_issued, verified_at, valid_until, revoked_at, updated_at)
  VALUES (p_user_id, 'verified', true, v_now, NULL, NULL, v_now)
  ON CONFLICT (user_id) DO UPDATE SET verification_status = 'verified', badge_issued = true,
    verified_at = EXCLUDED.verified_at, valid_until = NULL, revoked_at = NULL, updated_at = v_now;

  PERFORM app_security.impl_record_idv_audit_event(p_user_id, NULL, 'digilocker_linked', p_user_id, 'system',
    jsonb_build_object('provider', 'digilocker_meripehchaan', 'key_version', p_key_version));
  RETURN jsonb_build_object('success', true);
EXCEPTION WHEN unique_violation THEN
  -- Concurrent racer won between our checks and insert: never double-bind.
  RETURN jsonb_build_object('success', false, 'error', 'IDENTITY_ALREADY_LINKED', 'recovery', true);
END;
$$;

-- 8. Admin fraud-block / review. Administrator + AAL2 only; mandatory reason; audited. Fingerprints never returned.
CREATE OR REPLACE FUNCTION app_security.impl_admin_digilocker_fraud_block(
  p_target_user_id uuid, p_reason text, p_retention_review_days integer DEFAULT 365
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_admin uuid := auth.uid(); v_now timestamptz := pg_catalog.clock_timestamp(); v_n integer;
  v_status public.account_status_enum;
BEGIN
  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN_ADMIN_AAL2_REQUIRED');
  END IF;
  IF p_target_user_id IS NULL OR p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'MANDATORY_REASON_REQUIRED');
  END IF;
  IF p_target_user_id = v_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'CANNOT_SELF_BLOCK');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('idv_user_lock_' || p_target_user_id::text));

  SELECT account_status INTO v_status FROM public.user_accounts WHERE user_id = p_target_user_id FOR UPDATE;
  IF v_status IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'USER_NOT_FOUND');
  END IF;
  -- Confirmed fraud disables marketplace access through the SAME implementation as the Admin "Moderation Action"
  -- (admin_update_user_account_status -> impl_update_user_account_status, staff-audited there). An account already
  -- suspended during investigation (or pending deletion) keeps its status: that implementation rejects no-op changes.
  IF v_status = 'active' THEN
    PERFORM app_security.impl_update_user_account_status(p_target_user_id, 'suspended', trim(p_reason));
  END IF;

  UPDATE app_security.idv_digilocker_bindings
  SET identity_status = 'fraud_blocked', fraud_blocked_at = v_now, fraud_blocked_by = v_admin,
      retention_review_at = v_now + pg_catalog.make_interval(days => greatest(30, least(coalesce(p_retention_review_days, 365), 1095))),
      updated_at = v_now
  WHERE user_id = p_target_user_id AND identity_status <> 'fraud_blocked';
  GET DIAGNOSTICS v_n = ROW_COUNT;

  UPDATE public.user_identity_verifications
  SET verification_status = 'revoked', badge_issued = false, revoked_at = v_now, updated_at = v_now
  WHERE user_id = p_target_user_id;

  PERFORM app_security.impl_record_idv_audit_event(p_target_user_id, NULL, 'digilocker_fraud_block', v_admin, 'administrator',
    jsonb_build_object('reason', trim(p_reason), 'binding_blocked', v_n > 0, 'previous_status', v_status));
  RETURN jsonb_build_object('success', true, 'binding_blocked', v_n > 0, 'previous_status', v_status);
END;
$$;

-- Review outcome: release (unblock, user must relink) or purge (delete the retained fingerprint after review).
CREATE OR REPLACE FUNCTION app_security.impl_admin_digilocker_fraud_block_resolve(
  p_binding_id uuid, p_action text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_admin uuid := auth.uid(); v_b RECORD; v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RETURN jsonb_build_object('success', false, 'error', 'FORBIDDEN_ADMIN_AAL2_REQUIRED');
  END IF;
  IF p_action NOT IN ('release', 'purge') OR p_reason IS NULL OR length(trim(p_reason)) < 10 THEN
    RETURN jsonb_build_object('success', false, 'error', 'INVALID_REQUEST');
  END IF;
  SELECT * INTO v_b FROM app_security.idv_digilocker_bindings WHERE id = p_binding_id AND identity_status = 'fraud_blocked' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'BINDING_NOT_FOUND');
  END IF;
  IF v_b.user_id = v_admin THEN
    RETURN jsonb_build_object('success', false, 'error', 'CANNOT_SELF_RESOLVE');
  END IF;
  PERFORM pg_catalog.set_config('fairswap.idv_dl_admin_resolve', 'on', true);
  -- A released block whose account no longer exists has nothing to link to: remove it instead of orphaning it.
  IF p_action = 'purge' OR v_b.user_id IS NULL THEN
    DELETE FROM app_security.idv_digilocker_bindings WHERE id = v_b.id;
  ELSE
    UPDATE app_security.idv_digilocker_bindings
    SET identity_status = 'linked', fraud_blocked_at = NULL, fraud_blocked_by = NULL, retention_review_at = NULL, updated_at = v_now
    WHERE id = v_b.id;
  END IF;
  PERFORM pg_catalog.set_config('fairswap.idv_dl_admin_resolve', '', true);
  IF v_b.user_id IS NOT NULL THEN
    PERFORM app_security.impl_record_idv_audit_event(v_b.user_id, NULL, 'digilocker_fraud_block_' || p_action, v_admin, 'administrator',
      jsonb_build_object('reason', trim(p_reason)));
  END IF;
  RETURN jsonb_build_object('success', true);
END;
$$;

-- 9. Wrappers and grants
CREATE OR REPLACE FUNCTION public.server_idv_dl_start_attempt(p_user_id uuid, p_state_hash text, p_ttl_seconds integer,
  p_consent_purpose text, p_consent_acknowledged boolean, p_policy_version text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_start_attempt(p_user_id, p_state_hash, p_ttl_seconds, p_consent_purpose, p_consent_acknowledged, p_policy_version);
$$;
CREATE OR REPLACE FUNCTION public.server_idv_dl_consume_state(p_user_id uuid, p_state_hash text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_consume_state(p_user_id, p_state_hash);
$$;
CREATE OR REPLACE FUNCTION public.server_idv_dl_fail_attempt(p_attempt_id uuid, p_user_id uuid, p_code text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_fail_attempt(p_attempt_id, p_user_id, p_code);
$$;
CREATE OR REPLACE FUNCTION public.server_idv_dl_complete(p_attempt_id uuid, p_user_id uuid, p_id_fingerprint text, p_key_version text,
  p_legacy_fingerprints text[] DEFAULT '{}'::text[])
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_idv_dl_complete(p_attempt_id, p_user_id, p_id_fingerprint, p_key_version, p_legacy_fingerprints);
$$;
CREATE OR REPLACE FUNCTION public.admin_digilocker_fraud_block(p_target_user_id uuid, p_reason text, p_retention_review_days integer DEFAULT 365)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_admin_digilocker_fraud_block(p_target_user_id, p_reason, p_retention_review_days);
$$;
CREATE OR REPLACE FUNCTION public.admin_digilocker_fraud_block_resolve(p_binding_id uuid, p_action text, p_reason text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
  SELECT app_security.impl_admin_digilocker_fraud_block_resolve(p_binding_id, p_action, p_reason);
$$;

REVOKE ALL ON FUNCTION app_security.impl_idv_dl_start_attempt(uuid, text, integer, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_security.impl_idv_dl_consume_state(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_security.impl_idv_dl_fail_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_security.impl_idv_dl_complete(uuid, uuid, text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_start_attempt(uuid, text, integer, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_consume_state(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_fail_attempt(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_idv_dl_complete(uuid, uuid, text, text, text[]) TO service_role;

REVOKE ALL ON FUNCTION app_security.impl_admin_digilocker_fraud_block(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION app_security.impl_admin_digilocker_fraud_block_resolve(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_admin_digilocker_fraud_block(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_admin_digilocker_fraud_block_resolve(uuid, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.server_idv_dl_start_attempt(uuid, text, integer, text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_consume_state(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_fail_attempt(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_idv_dl_complete(uuid, uuid, text, text, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_start_attempt(uuid, text, integer, text, boolean, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_consume_state(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_fail_attempt(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.server_idv_dl_complete(uuid, uuid, text, text, text[]) TO service_role;

REVOKE ALL ON FUNCTION public.admin_digilocker_fraud_block(uuid, text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_digilocker_fraud_block_resolve(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_digilocker_fraud_block(uuid, text, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_digilocker_fraud_block_resolve(uuid, text, text) TO authenticated, service_role;

-- 10. Read-only access summary for clients (UX only; the triggers above are the enforcement).
CREATE OR REPLACE FUNCTION public.get_my_marketplace_access()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT CASE WHEN auth.uid() IS NULL THEN NULL ELSE jsonb_build_object(
    'identity_verified', app_security.is_identity_verified(auth.uid()),
    'verification_required', app_security.identity_gate_enabled()
  ) END;
$$;
REVOKE ALL ON FUNCTION public.get_my_marketplace_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_marketplace_access() TO authenticated, service_role;

commit;
