-- Forward Migration: Azure Moderation V1 Authoritative Publication Gate
-- Reconciles with Test (97 migrations) and Production (81 migrations)
--
-- Security Design (Opus):
-- 1. app_security.listing_media_verified_hashes:
--    DB-owned table storing cryptographic content hashes (SHA-256) of media items.
-- 2. app_security.listing_moderation_scan_receipts:
--    Append-only receipt registry recording trusted scan results.
-- 3. app_security.register_moderation_scan_receipt:
--    Validates:
--      a) Request lease under lock (request_id, claim_token, unexpired claim).
--      b) Policy version (must be 'india_v1.0.0') and scope ('multimodal_five_check').
--      c) Mandates all 5 required checks present in p_completed_checks with 0 failed checks.
--      d) Verifies manifest has NO DUPLICATES and exactly matches DB-owned public.listing_media rows.
--      e) Inserts receipt and verified hashes in one atomic transaction.
-- 4. app_security.impl_finalize_moderation_result:
--    Authoritative gate validating:
--      a) Pre-registered unconsumed receipt matching listing_id, revision, generation.
--      b) Pre-registered manifest IDs, paths, and verified hashes match current public.listing_media exactly.
--      c) If any photo was replaced, removed, or modified after scanning -> fail closed.
--      d) Seller account active, policy accepted, city/category present, media processing ready.
--      e) Legacy 'prototype_v0.1.1' is strictly downgraded to 'needs_review'.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Verified Media Hashes Table
CREATE TABLE IF NOT EXISTS app_security.listing_media_verified_hashes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES public.listing_media(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  original_storage_path text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
  generation_id uuid NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_media_verified_hashes_media
  ON app_security.listing_media_verified_hashes (media_id, generation_id);

ALTER TABLE app_security.listing_media_verified_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.listing_media_verified_hashes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_security.listing_media_verified_hashes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON app_security.listing_media_verified_hashes TO service_role;

-- 2. Scan Receipts Table
CREATE TABLE IF NOT EXISTS app_security.listing_moderation_scan_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.listing_moderation_requests(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  listing_revision integer NOT NULL,
  generation_id uuid NOT NULL,
  media_digest text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('APPROVE', 'REJECT', 'FLAG', 'INCOMPLETE')),
  ruleset_version text NOT NULL,
  scope text NOT NULL,
  completed_checks text[] NOT NULL DEFAULT ARRAY[]::text[],
  failed_checks text[] NOT NULL DEFAULT ARRAY[]::text[],
  flags jsonb NOT NULL DEFAULT '[]'::jsonb,
  model_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  manifest jsonb NOT NULL DEFAULT '[]'::jsonb,
  scanned_media_count integer NOT NULL DEFAULT 0,
  consumed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_listing_scan_receipts_lookup
  ON app_security.listing_moderation_scan_receipts (request_id, listing_revision, generation_id);

ALTER TABLE app_security.listing_moderation_scan_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_security.listing_moderation_scan_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_security.listing_moderation_scan_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON app_security.listing_moderation_scan_receipts TO service_role;

-- 3. Register Scan Receipt
CREATE OR REPLACE FUNCTION app_security.register_moderation_scan_receipt(
  p_request_id uuid,
  p_claim_token uuid,
  p_listing_id uuid,
  p_listing_revision integer,
  p_generation_id uuid,
  p_media_digest text,
  p_verdict text,
  p_ruleset_version text,
  p_scope text,
  p_completed_checks text[],
  p_failed_checks text[],
  p_flags jsonb,
  p_model_versions jsonb,
  p_manifest jsonb,
  p_scanned_media_count integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req public.listing_moderation_requests%ROWTYPE;
  v_receipt_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_db_media_count integer;
  v_manifest_count integer;
  v_item jsonb;
  v_media_id uuid;
  v_path text;
  v_sha text;
  v_db_path text;
  v_manifest_line text;
  v_manifest_lines text[] := ARRAY[]::text[];
  v_computed_digest text;
  v_seen_ids uuid[] := ARRAY[]::uuid[];
  v_mandatory_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_vision_nsfw',
    'check_vision_category',
    'check_ocr_qr'
  ]::text[];
BEGIN
  -- Strict Policy and Scope Check
  IF p_ruleset_version != 'india_v1.0.0' OR p_scope != 'multimodal_five_check' THEN
    RAISE EXCEPTION 'INVALID_POLICY_VERSION_OR_SCOPE';
  END IF;

  -- If verdict is APPROVE, enforce 0 failed checks and all 5 mandatory checks present
  IF p_verdict = 'APPROVE' THEN
    IF NOT (p_completed_checks @> v_mandatory_checks) OR cardinality(p_failed_checks) > 0 THEN
      RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
    END IF;
  END IF;

  -- 1. Validate request and lease under lock
  SELECT * INTO v_req
  FROM public.listing_moderation_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'REQUEST_NOT_FOUND';
  END IF;

  IF v_req.claim_token IS DISTINCT FROM p_claim_token THEN
    RAISE EXCEPTION 'LEASE_TOKEN_MISMATCH';
  END IF;

  IF v_req.status != 'claimed' THEN
    RAISE EXCEPTION 'REQUEST_NOT_CLAIMED';
  END IF;

  IF v_req.claim_expires_at < v_now THEN
    RAISE EXCEPTION 'LEASE_EXPIRED';
  END IF;

  IF v_req.listing_id != p_listing_id OR v_req.listing_revision != p_listing_revision OR v_req.generation_id != p_generation_id THEN
    RAISE EXCEPTION 'SNAPSHOT_IDENTITY_MISMATCH';
  END IF;

  -- 2. Validate manifest uniqueness and match against DB
  SELECT count(*) INTO v_db_media_count
  FROM public.listing_media
  WHERE listing_id = p_listing_id;

  v_manifest_count := jsonb_array_length(p_manifest);

  IF v_manifest_count != v_db_media_count OR v_manifest_count != p_scanned_media_count THEN
    RAISE EXCEPTION 'MEDIA_COUNT_MISMATCH';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_manifest)
  LOOP
    v_media_id := (v_item->>'id')::uuid;
    v_path := v_item->>'path';
    v_sha := v_item->>'sha256';

    -- Check duplicate media IDs in manifest
    IF v_media_id = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'DUPLICATE_MEDIA_ID_IN_MANIFEST';
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_media_id);

    IF v_sha IS NULL OR NOT (v_sha ~ '^[a-f0-9]{64}$') THEN
      RAISE EXCEPTION 'INVALID_HASH_FORMAT';
    END IF;

    SELECT original_storage_path INTO v_db_path
    FROM public.listing_media
    WHERE id = v_media_id AND listing_id = p_listing_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'MEDIA_ITEM_NOT_FOUND';
    END IF;

    IF v_db_path IS DISTINCT FROM v_path THEN
      RAISE EXCEPTION 'MEDIA_PATH_MISMATCH';
    END IF;

    -- Append canonical manifest line: id:path:sha256
    v_manifest_line := v_media_id::text || ':' || v_path || ':' || v_sha;
    v_manifest_lines := array_append(v_manifest_lines, v_manifest_line);

    -- Store verified hash
    INSERT INTO app_security.listing_media_verified_hashes (
      media_id, listing_id, original_storage_path, content_sha256, generation_id
    ) VALUES (
      v_media_id, p_listing_id, v_path, v_sha, p_generation_id
    );
  END LOOP;

  -- 2b. Compute and verify media digest against canonical sorted manifest
  SELECT pg_catalog.encode(
    extensions.digest(
      COALESCE(
        (SELECT pg_catalog.string_agg(line, E'\n') FROM (SELECT unnest(v_manifest_lines) AS line ORDER BY line ASC) AS s),
        ''
      ),
      'sha256'
    ),
    'hex'
  ) INTO v_computed_digest;

  IF v_manifest_count > 0 AND v_computed_digest IS DISTINCT FROM p_media_digest THEN
    RAISE EXCEPTION 'MEDIA_DIGEST_MISMATCH';
  END IF;

  -- 3. Insert verifiable scan receipt
  INSERT INTO app_security.listing_moderation_scan_receipts (
    request_id, listing_id, listing_revision, generation_id, media_digest,
    verdict, ruleset_version, scope, completed_checks, failed_checks,
    flags, model_versions, manifest, scanned_media_count, consumed
  ) VALUES (
    p_request_id, p_listing_id, p_listing_revision, p_generation_id, p_media_digest,
    p_verdict, p_ruleset_version, p_scope, p_completed_checks, p_failed_checks,
    p_flags, p_model_versions, p_manifest, p_scanned_media_count, false
  )
  RETURNING id INTO v_receipt_id;

  RETURN v_receipt_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.register_moderation_scan_receipt FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.register_moderation_scan_receipt TO service_role;

-- Public wrapper
CREATE OR REPLACE FUNCTION public.register_moderation_scan_receipt(
  p_request_id uuid,
  p_claim_token uuid,
  p_listing_id uuid,
  p_listing_revision integer,
  p_generation_id uuid,
  p_media_digest text,
  p_verdict text,
  p_ruleset_version text,
  p_scope text,
  p_completed_checks text[],
  p_failed_checks text[],
  p_flags jsonb,
  p_model_versions jsonb,
  p_manifest jsonb,
  p_scanned_media_count integer
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.register_moderation_scan_receipt(
    p_request_id, p_claim_token, p_listing_id, p_listing_revision, p_generation_id,
    p_media_digest, p_verdict, p_ruleset_version, p_scope, p_completed_checks,
    p_failed_checks, p_flags, p_model_versions, p_manifest, p_scanned_media_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_moderation_scan_receipt FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_moderation_scan_receipt TO service_role;

-- 4. Authoritative Publication Gate
CREATE OR REPLACE FUNCTION app_security.impl_finalize_moderation_result(
  p_request_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_ruleset_version text,
  p_scope text,
  p_completed_rules text[],
  p_failed_rules text[],
  p_flags jsonb,
  p_errors jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req public.listing_moderation_requests%ROWTYPE;
  v_listing public.listings%ROWTYPE;
  v_receipt app_security.listing_moderation_scan_receipts%ROWTYPE;
  v_target_listing_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_decision public.moderation_decision_state;
  v_media_count integer;
  v_unready_media_count integer;
  v_failed_media_count integer;
  v_account_status text;
  v_has_policy boolean;
  v_automation_enabled boolean := false;
  v_db_enabled boolean := false;
  v_vault_secret text;
  v_next_attempt timestamptz;
  v_has_valid_receipt boolean := false;
  v_cover_id uuid;
  v_mandatory_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_vision_nsfw',
    'check_vision_category',
    'check_ocr_qr'
  ]::text[];
  v_receipt_item jsonb;
  v_m_id uuid;
  v_m_path text;
  v_m_sha text;
  v_db_m_path text;
  v_recorded_sha text;
BEGIN
  -- Kill switch check (authoritative database switch + Vault veto)
  SELECT COALESCE(
    (SELECT (setting_value = 'true') FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled' LIMIT 1),
    false
  ) INTO v_db_enabled;

  SELECT decrypted_secret INTO v_vault_secret
  FROM vault.decrypted_secrets
  WHERE name = 'moderation_automation_enabled'
  LIMIT 1;

  v_automation_enabled := v_db_enabled AND (v_vault_secret IS NULL OR v_vault_secret = 'true');

  -- Enforce versioned 5-check contract identity
  -- Closes legacy prototype_v0.1.1 from auto-approving
  IF p_ruleset_version != 'india_v1.0.0' OR p_scope != 'multimodal_five_check' THEN
    p_outcome := 'needs_review';
  END IF;

  -- Lock PARENT LISTING ROW FIRST
  SELECT listing_id INTO v_target_listing_id
  FROM public.listing_moderation_requests
  WHERE id = p_request_id;

  IF v_target_listing_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND');
  END IF;

  SELECT * INTO v_listing
  FROM public.listings
  WHERE id = v_target_listing_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'LISTING_NOT_FOUND');
  END IF;

  -- Lock MODERATION REQUEST ROW SECOND
  SELECT * INTO v_req
  FROM public.listing_moderation_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND');
  END IF;

  IF v_req.listing_id != v_listing.id THEN
    RETURN jsonb_build_object('success', false, 'error', 'LISTING_REQUEST_MISMATCH');
  END IF;

  IF v_req.status = 'superseded' THEN
    RETURN jsonb_build_object('success', true, 'decision', 'superseded', 'reason', 'REQUEST_ALREADY_SUPERSEDED');
  END IF;

  IF v_req.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_TOKEN_MISMATCH');
  END IF;

  IF v_req.status != 'claimed' THEN
    RETURN jsonb_build_object('success', false, 'error', 'REQUEST_NOT_CLAIMED');
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_req.claim_expires_at < v_now THEN
    RETURN jsonb_build_object('success', false, 'error', 'LEASE_EXPIRED');
  END IF;

  -- Revision & Content Freshness Guard
  IF v_listing.status != 'pending_review'::public.listing_status_enum
     OR v_listing.revision != v_req.listing_revision
     OR v_listing.title IS DISTINCT FROM v_req.evaluated_title
     OR v_listing.description IS DISTINCT FROM v_req.evaluated_description THEN
    UPDATE public.listing_moderation_requests
    SET status = 'superseded', updated_at = v_now
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true, 'decision', 'superseded', 'reason', 'LISTING_CONTENT_OR_STATE_CHANGED');
  END IF;

  -- Verify pre-registered scan receipt
  SELECT * INTO v_receipt
  FROM app_security.listing_moderation_scan_receipts
  WHERE request_id = p_request_id
    AND listing_id = v_listing.id
    AND listing_revision = v_listing.revision
    AND generation_id = v_req.generation_id
    AND consumed = false
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_receipt.verdict = 'APPROVE'
       AND v_receipt.completed_checks @> v_mandatory_checks
       AND cardinality(v_receipt.failed_checks) = 0
       AND jsonb_array_length(v_receipt.flags) = 0
       AND v_receipt.scanned_media_count > 0 THEN

      -- Compare manifest against current DB state (detect replaced or removed photos)
      SELECT
        count(*),
        count(*) FILTER (WHERE processing_status != 'ready'),
        count(*) FILTER (WHERE processing_status = 'failed')
      INTO v_media_count, v_unready_media_count, v_failed_media_count
      FROM public.listing_media
      WHERE listing_id = v_listing.id;

      IF v_media_count = v_receipt.scanned_media_count AND v_unready_media_count = 0 AND v_failed_media_count = 0 THEN
        v_has_valid_receipt := true;
        -- Re-verify each item in manifest against live listing_media and recorded verified hashes
        FOR v_receipt_item IN SELECT * FROM jsonb_array_elements(v_receipt.manifest)
        LOOP
          v_m_id := (v_receipt_item->>'id')::uuid;
          v_m_path := v_receipt_item->>'path';
          v_m_sha := v_receipt_item->>'sha256';

          -- Check live DB row
          SELECT original_storage_path INTO v_db_m_path
          FROM public.listing_media
          WHERE id = v_m_id AND listing_id = v_listing.id;

          IF NOT FOUND OR v_db_m_path IS DISTINCT FROM v_m_path THEN
            v_has_valid_receipt := false;
            EXIT;
          END IF;

          -- Check DB-owned recorded verified hash
          SELECT content_sha256 INTO v_recorded_sha
          FROM app_security.listing_media_verified_hashes
          WHERE media_id = v_m_id
            AND listing_id = v_listing.id
            AND generation_id = v_req.generation_id
          ORDER BY verified_at DESC
          LIMIT 1;

          IF NOT FOUND OR v_recorded_sha IS DISTINCT FROM v_m_sha THEN
            v_has_valid_receipt := false;
            EXIT;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;

  -- Auto-approval requires clean outcome, verified receipt, and at least 1 photo
  IF p_outcome = 'no_review_flags' THEN
    IF NOT v_has_valid_receipt OR v_media_count < 1 OR v_unready_media_count > 0 OR v_failed_media_count > 0 THEN
      p_outcome := 'checks_incomplete';
    END IF;
  END IF;

  -- 8. Environment-specific experimental-category guards (Staging / Step 1Q)
  -- If app_security.test_submission_policies exists, check if category belongs to experimental family (cars, two-wheelers, property)
  IF to_regclass('app_security.test_submission_policies') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'car_category_contracts'
    ) AND (
      EXISTS (SELECT 1 FROM public.car_category_contracts WHERE category_id = v_listing.category_id)
      OR EXISTS (SELECT 1 FROM public.vehicle_category_contracts WHERE category_id = v_listing.category_id)
      OR EXISTS (SELECT 1 FROM public.property_category_contracts WHERE category_id = v_listing.category_id)
      OR EXISTS (SELECT 1 FROM public.listing_car_contexts WHERE listing_id = v_listing.id)
      OR EXISTS (SELECT 1 FROM public.listing_vehicle_contexts WHERE listing_id = v_listing.id)
      OR EXISTS (SELECT 1 FROM public.listing_property_contexts WHERE listing_id = v_listing.id)
    ) THEN
      -- Experimental category detected: publication is strictly blocked and routed to admin
      IF p_outcome = 'no_review_flags' THEN
        v_decision := 'routed_to_admin'::public.moderation_decision_state;
        UPDATE public.listing_moderation_requests
        SET status = 'completed'::public.moderation_request_status, updated_at = v_now
        WHERE id = p_request_id;

        INSERT INTO public.listing_moderation_results (
          request_id, listing_id, listing_revision, generation_id, outcome,
          ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
        ) VALUES (
          p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
          'no_review_flags'::public.moderation_outcome_enum,
          p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
        );

        IF to_regprocedure('app_security.log_audit_event(text,text,uuid,jsonb)') IS NOT NULL THEN
          PERFORM app_security.log_audit_event(
            'moderation.experimental_publication_disabled', 'listings', v_listing.id,
            jsonb_build_object(
              'request_id', p_request_id,
              'generation_id', v_req.generation_id,
              'revision', v_listing.revision,
              'reason', 'EXPERIMENTAL_PUBLICATION_DISABLED',
              'ruleset_version', p_ruleset_version
            )
          );
        END IF;

        RETURN jsonb_build_object(
          'success', true,
          'decision', v_decision,
          'status', 'pending_review',
          'reason', 'EXPERIMENTAL_PUBLICATION_DISABLED'
        );
      END IF;
    END IF;
  END IF;

  -- Route according to validated outcome
  IF p_outcome = 'no_review_flags' THEN
    IF NOT v_automation_enabled THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
    ELSIF v_unready_media_count > 0 THEN
      v_next_attempt := v_now + INTERVAL '30 seconds';
      UPDATE public.listing_moderation_requests
      SET status = 'retry'::public.moderation_request_status,
          claim_token = NULL,
          claim_expires_at = NULL,
          next_attempt_at = v_next_attempt,
          updated_at = v_now
      WHERE id = p_request_id;

      RETURN jsonb_build_object('success', true, 'decision', 'awaiting_retry', 'next_attempt_at', v_next_attempt);
    ELSIF v_failed_media_count > 0 OR v_listing.category_id IS NULL OR v_listing.city_id IS NULL THEN
      v_decision := 'routed_to_admin'::public.moderation_decision_state;
    ELSE
      -- Account eligibility check
      v_account_status := app_security.get_account_status(v_listing.seller_id);
      v_has_policy := app_security.has_current_policy_acceptance(v_listing.seller_id);

      IF v_account_status != 'active' OR NOT v_has_policy THEN
        v_decision := 'routed_to_admin'::public.moderation_decision_state;
      ELSE
        v_decision := 'auto_approved'::public.moderation_decision_state;
      END IF;
    END IF;
  ELSIF p_outcome = 'needs_review' THEN
    v_decision := 'routed_to_admin'::public.moderation_decision_state;
  ELSIF p_outcome = 'invalid_input' THEN
    v_decision := 'rejected_invalid'::public.moderation_decision_state;
  ELSE
    -- checks_incomplete
    IF v_req.attempt_count < v_req.max_attempts THEN
      v_next_attempt := v_now + (POWER(2, v_req.attempt_count) * INTERVAL '30 seconds');
      UPDATE public.listing_moderation_requests
      SET status = 'retry'::public.moderation_request_status,
          claim_token = NULL,
          claim_expires_at = NULL,
          attempt_count = attempt_count + 1,
          next_attempt_at = v_next_attempt,
          updated_at = v_now
      WHERE id = p_request_id;

      RETURN jsonb_build_object('success', true, 'decision', 'awaiting_retry', 'next_attempt_at', v_next_attempt);
    ELSE
      v_decision := 'escalated_to_admin'::public.moderation_decision_state;
    END IF;
  END IF;

  -- Apply final state updates
  UPDATE public.listing_moderation_requests
  SET status = 'completed', updated_at = v_now
  WHERE id = p_request_id;

  INSERT INTO public.listing_moderation_results (
    request_id, listing_id, listing_revision, generation_id, outcome,
    ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
  ) VALUES (
    p_request_id, v_listing.id, v_listing.revision, v_req.generation_id,
    p_outcome::public.moderation_outcome_enum,
    p_ruleset_version, p_scope, p_completed_rules, p_failed_rules, p_flags, p_errors, v_decision
  );

  -- Mark receipt consumed
  IF v_receipt.id IS NOT NULL THEN
    UPDATE app_security.listing_moderation_scan_receipts
    SET consumed = true
    WHERE id = v_receipt.id;
  END IF;

  IF v_decision = 'auto_approved' THEN
    -- Determine cover photo
    v_cover_id := v_listing.cover_photo_id;
    IF v_cover_id IS NULL THEN
      SELECT id INTO v_cover_id
      FROM public.listing_media
      WHERE listing_id = v_listing.id AND processing_status = 'ready'
      ORDER BY display_order ASC, created_at ASC
      LIMIT 1;
    END IF;

    UPDATE public.listings
    SET status = 'active'::public.listing_status_enum,
        published_at = v_now,
        expires_at = v_now + INTERVAL '30 days',
        rejection_reason = NULL,
        cover_photo_id = v_cover_id,
        updated_at = v_now
    WHERE id = v_listing.id;

    IF to_regprocedure('app_security.log_audit_event(text,text,uuid,jsonb)') IS NOT NULL THEN
      PERFORM app_security.log_audit_event(
        'listing.auto_approved',
        'listings',
        v_listing.id,
        jsonb_build_object(
          'revision', v_listing.revision,
          'request_id', p_request_id,
          'generation_id', v_req.generation_id,
          'ruleset_version', p_ruleset_version
        )
      );
    END IF;
  ELSIF v_decision = 'routed_to_admin' THEN
    IF to_regprocedure('app_security.log_audit_event(text,text,uuid,jsonb)') IS NOT NULL THEN
      PERFORM app_security.log_audit_event(
        'moderation.routed_to_admin',
        'listings',
        v_listing.id,
        jsonb_build_object('request_id', p_request_id, 'flags_count', jsonb_array_length(p_flags))
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'decision', v_decision,
    'status', (SELECT status FROM public.listings WHERE id = v_listing.id)
  );
END;
$$;

COMMIT;
