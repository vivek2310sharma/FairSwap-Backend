-- Forward Migration: Provider-Switchable Moderation Architecture V1
-- Sequenced after Wearables activation: 20261104223000
--
-- Security Design:
-- 1. System Settings:
--    Inserts moderation_azure_enabled and moderation_google_cloud_enabled (default 'false').
--    Retains moderation_automation_enabled master kill switch.
-- 2. Scan Receipts (register_moderation_scan_receipt):
--    Accepts both:
--      a) Policy: 'india_azure_v1.0.0' (or legacy 'india_v1.0.0'), Scope: 'multimodal_five_check' (5 mandatory checks)
--      b) Policy: 'india_baseline_v1.0.0', Scope: 'baseline_two_check' (2 mandatory checks: check_india_fraud_rules, check_openai_moderation)
--    Enforces digest matching, original-storage path matching, verified hashes insertion, and lease checks.
-- 3. Finalizer Architecture & Wearables (W-AZ-1) Compatibility:
--    If Wearables activation wrapped the finalizer (app_security.impl_finalize_moderation_result_azure_v1 exists),
--    this migration updates the inner implementation function and preserves the outer W-AZ-1 wrapper
--    so that wearable risk flags continue routing to staff under both policies.
--    If not yet wrapped, updates app_security.impl_finalize_moderation_result directly.
-- 4. Publication Gate:
--    Two-check auto-approval permitted ONLY for explicitly approved low-risk active goods.
--    Five-check policy mandates all 5 checks and at least 1 verified photo.
--    Two-check is never relabeled as five-check.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Insert System Settings with Default False
INSERT INTO public.app_system_settings (setting_key, setting_value, description)
VALUES 
  ('moderation_azure_enabled', 'false', 'Enable optional Azure multimodal image moderation checks'),
  ('moderation_google_cloud_enabled', 'false', 'Future Google Cloud moderation provider switch (must remain off)')
ON CONFLICT (setting_key) DO NOTHING;

-- 2. Enhanced Register Scan Receipt RPC
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
  v_mandatory_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_vision_nsfw',
    'check_vision_category',
    'check_ocr_qr'
  ]::text[];
  v_mandatory_two_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation'
  ]::text[];
  v_is_five_check boolean := false;
  v_is_two_check boolean := false;
BEGIN
  -- Strict Policy and Scope Check
  IF (p_ruleset_version IN ('india_azure_v1.0.0', 'india_v1.0.0') AND p_scope = 'multimodal_five_check') THEN
    v_is_five_check := true;
  ELSIF (p_ruleset_version = 'india_baseline_v1.0.0' AND p_scope = 'baseline_two_check') THEN
    v_is_two_check := true;
  ELSE
    RAISE EXCEPTION 'INVALID_POLICY_VERSION_OR_SCOPE';
  END IF;

  -- If verdict is APPROVE, enforce 0 failed checks and all required checks present
  IF p_verdict = 'APPROVE' THEN
    IF cardinality(p_failed_checks) > 0 THEN
      RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
    END IF;

    IF v_is_five_check AND NOT (p_completed_checks @> v_mandatory_five_checks) THEN
      RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
    ELSIF v_is_two_check AND NOT (p_completed_checks @> v_mandatory_two_checks) THEN
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

  IF v_req.listing_id != p_listing_id OR v_req.listing_revision != p_listing_revision THEN
    RAISE EXCEPTION 'LISTING_OR_REVISION_MISMATCH';
  END IF;

  IF v_req.generation_id != p_generation_id THEN
    RAISE EXCEPTION 'GENERATION_ID_MISMATCH';
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

  -- 2. Validate media count against live database
  SELECT count(*) INTO v_db_media_count
  FROM public.listing_media
  WHERE listing_id = p_listing_id;

  v_manifest_count := jsonb_array_length(p_manifest);

  IF p_scanned_media_count != v_db_media_count OR v_manifest_count != v_db_media_count THEN
    RAISE EXCEPTION 'MEDIA_COUNT_MISMATCH: scanned=% db=% manifest=%',
      p_scanned_media_count, v_db_media_count, v_manifest_count;
  END IF;

  -- 3. Validate manifest entries, uniqueness, and DB paths
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_manifest)
  LOOP
    v_media_id := (v_item->>'id')::uuid;
    v_path := v_item->>'path';
    v_sha := v_item->>'sha256';

    IF v_media_id IS NULL OR v_path IS NULL OR v_sha IS NULL THEN
      RAISE EXCEPTION 'MALFORMED_MANIFEST_ENTRY';
    END IF;

    IF v_media_id = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'DUPLICATE_MEDIA_ID_IN_MANIFEST: %', v_media_id;
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_media_id);

    SELECT original_storage_path INTO v_db_path
    FROM public.listing_media
    WHERE id = v_media_id AND listing_id = p_listing_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'MEDIA_ID_NOT_ATTACHED_TO_LISTING: %', v_media_id;
    END IF;

    IF v_db_path IS DISTINCT FROM v_path THEN
      RAISE EXCEPTION 'MEDIA_PATH_MISMATCH: id=% db=% manifest=%', v_media_id, v_db_path, v_path;
    END IF;

    v_manifest_line := format('%s:%s:%s', v_media_id, v_path, v_sha);
    v_manifest_lines := array_append(v_manifest_lines, v_manifest_line);
  END LOOP;

  -- 4. Compute canonical digest of manifest and compare
  IF v_db_media_count > 0 THEN
    SELECT pg_catalog.string_agg(line, E'\n')
    INTO v_manifest_line
    FROM (SELECT pg_catalog.unnest(v_manifest_lines) AS line ORDER BY line ASC) AS s;

    v_computed_digest := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(COALESCE(v_manifest_line, ''), 'UTF8'),
        'sha256'
      ),
      'hex'
    );

    IF v_computed_digest IS DISTINCT FROM p_media_digest THEN
      RAISE EXCEPTION 'MEDIA_DIGEST_MISMATCH';
    END IF;
  END IF;

  -- 5. Record verified hashes into DB-owned state (atomic with receipt)
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_manifest)
  LOOP
    v_media_id := (v_item->>'id')::uuid;
    v_path := v_item->>'path';
    v_sha := v_item->>'sha256';

    INSERT INTO app_security.listing_media_verified_hashes (
      media_id, listing_id, original_storage_path, content_sha256, generation_id, verified_at
    ) VALUES (
      v_media_id, p_listing_id, v_path, v_sha, p_generation_id, v_now
    );
  END LOOP;

  -- 6. Insert scan receipt
  INSERT INTO app_security.listing_moderation_scan_receipts (
    request_id, listing_id, listing_revision, generation_id, media_digest,
    verdict, ruleset_version, scope, completed_checks, failed_checks,
    flags, model_versions, manifest, scanned_media_count, consumed, created_at
  ) VALUES (
    p_request_id, p_listing_id, p_listing_revision, p_generation_id, p_media_digest,
    p_verdict, p_ruleset_version, p_scope, p_completed_checks, p_failed_checks,
    p_flags, p_model_versions, p_manifest, p_scanned_media_count, false, v_now
  ) RETURNING id INTO v_receipt_id;

  RETURN v_receipt_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.register_moderation_scan_receipt FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.register_moderation_scan_receipt TO service_role;

-- 3. Core Provider-Switchable Finalizer Definition
-- Updates the underlying finalizer while preserving the Wearables (W-AZ-1) wrapper if present.
DO $$
DECLARE
  v_is_wrapped boolean := (pg_catalog.to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') IS NOT NULL);
  v_target_func text := CASE WHEN v_is_wrapped THEN 'app_security.impl_finalize_moderation_result_azure_v1' ELSE 'app_security.impl_finalize_moderation_result' END;
BEGIN
  EXECUTE format($body$
CREATE OR REPLACE FUNCTION %s(
  p_request_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_ruleset_version text,
  p_scope text,
  p_completed_rules text[] DEFAULT ARRAY[]::text[],
  p_failed_rules text[] DEFAULT ARRAY[]::text[],
  p_flags jsonb DEFAULT '[]'::jsonb,
  p_errors jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $func$
DECLARE
  v_req public.listing_moderation_requests%%ROWTYPE;
  v_listing public.listings%%ROWTYPE;
  v_receipt app_security.listing_moderation_scan_receipts%%ROWTYPE;
  v_target_listing_id uuid;
  v_decision public.moderation_decision_state;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_media_count integer := 0;
  v_unready_media_count integer := 0;
  v_failed_media_count integer := 0;
  v_account_status text;
  v_has_policy boolean;
  v_automation_enabled boolean := false;
  v_db_enabled boolean := false;
  v_vault_secret text;
  v_next_attempt timestamptz;
  v_has_valid_receipt boolean := false;
  v_cover_id uuid;
  v_mandatory_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_vision_nsfw',
    'check_vision_category',
    'check_ocr_qr'
  ]::text[];
  v_mandatory_two_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation'
  ]::text[];
  v_is_five_check boolean := false;
  v_is_two_check boolean := false;
  v_receipt_item jsonb;
  v_m_id uuid;
  v_m_path text;
  v_m_sha text;
  v_db_m_path text;
  v_recorded_sha text;
  v_category_record public.categories%%ROWTYPE;
  v_is_restricted_category boolean := false;
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

  -- Enforce versioned policy contract identity
  IF (p_ruleset_version IN ('india_azure_v1.0.0', 'india_v1.0.0') AND p_scope = 'multimodal_five_check') THEN
    v_is_five_check := true;
  ELSIF (p_ruleset_version = 'india_baseline_v1.0.0' AND p_scope = 'baseline_two_check') THEN
    v_is_two_check := true;
  ELSE
    -- Legacy or invalid policy versions fail closed to needs_review
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
    AND ruleset_version = p_ruleset_version
    AND scope = p_scope
    AND consumed = false
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_receipt.verdict = 'APPROVE'
       AND cardinality(v_receipt.failed_checks) = 0
       AND jsonb_array_length(v_receipt.flags) = 0 THEN

      IF (v_is_five_check AND v_receipt.completed_checks @> v_mandatory_five_checks AND v_receipt.scanned_media_count > 0)
         OR (v_is_two_check AND v_receipt.completed_checks @> v_mandatory_two_checks) THEN

        -- Compare manifest against current DB state (detect replaced, added, or removed photos)
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
  END IF;

  -- Auto-approval requires clean outcome, verified receipt, and valid media
  IF p_outcome = 'no_review_flags' THEN
    IF NOT v_has_valid_receipt OR v_unready_media_count > 0 OR v_failed_media_count > 0 THEN
      p_outcome := 'checks_incomplete';
    END IF;
    -- Five-check policy mandates at least 1 scanned photo
    IF v_is_five_check AND v_media_count < 1 THEN
      p_outcome := 'checks_incomplete';
    END IF;

    -- Stale Provider & Mode-Switch Guard:
    -- Prevent unreviewed auto-approval from stale results when current mode differs
    IF v_is_two_check AND EXISTS (
      SELECT 1 FROM public.app_system_settings
      WHERE setting_key = 'moderation_azure_enabled' AND setting_value = 'true'
    ) THEN
      p_outcome := 'needs_review';
    ELSIF v_is_five_check AND NOT EXISTS (
      SELECT 1 FROM public.app_system_settings
      WHERE setting_key = 'moderation_azure_enabled' AND setting_value = 'true'
    ) THEN
      p_outcome := 'needs_review';
    END IF;
  END IF;

  -- Environment-specific experimental-category and unapproved-family guards
  IF (
    (to_regclass('public.car_category_contracts') IS NOT NULL AND EXISTS (SELECT 1 FROM public.car_category_contracts WHERE category_id = v_listing.category_id))
    OR (to_regclass('public.vehicle_category_contracts') IS NOT NULL AND EXISTS (SELECT 1 FROM public.vehicle_category_contracts WHERE category_id = v_listing.category_id))
    OR (to_regclass('public.property_category_contracts') IS NOT NULL AND EXISTS (SELECT 1 FROM public.property_category_contracts WHERE category_id = v_listing.category_id))
  ) THEN
    v_is_restricted_category := true;
  END IF;

  IF v_is_restricted_category THEN
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
          'moderation.restricted_category_routed_to_admin', 'listings', v_listing.id,
          jsonb_build_object(
            'request_id', p_request_id,
            'generation_id', v_req.generation_id,
            'revision', v_listing.revision,
            'reason', 'RESTRICTED_CATEGORY_MANUAL_REVIEW',
            'ruleset_version', p_ruleset_version
          )
        );
      END IF;

      RETURN jsonb_build_object(
        'success', true,
        'decision', v_decision,
        'status', 'pending_review',
        'reason', 'RESTRICTED_CATEGORY_MANUAL_REVIEW'
      );
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
      -- Category eligibility and publication security check
      -- Only active categories in approved 'goods' macro_category may be auto-approved
      SELECT * INTO v_category_record FROM public.categories WHERE id = v_listing.category_id;
      IF NOT FOUND OR NOT v_category_record.is_active THEN
        v_decision := 'routed_to_admin'::public.moderation_decision_state;
      ELSIF v_category_record.macro_category IS NULL OR v_category_record.macro_category != 'goods' THEN
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
    -- Determine cover photo if media exists
    v_cover_id := v_listing.cover_photo_id;
    IF v_cover_id IS NULL AND v_media_count > 0 THEN
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
          'ruleset_version', p_ruleset_version,
          'scope', p_scope
        )
      );
    END IF;
  ELSIF v_decision = 'routed_to_admin' THEN
    IF to_regprocedure('app_security.log_audit_event(text,text,uuid,jsonb)') IS NOT NULL THEN
      PERFORM app_security.log_audit_event(
        'moderation.routed_to_admin',
        'listings',
        v_listing.id,
        jsonb_build_object('request_id', p_request_id, 'flags_count', jsonb_array_length(p_flags), 'scope', p_scope)
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'decision', v_decision,
    'status', (SELECT status FROM public.listings WHERE id = v_listing.id)
  );
END;
$func$;
$body$, v_target_func);

  IF v_is_wrapped THEN
    -- Inner function remains strictly private and not callable by public, anon, authenticated or service_role directly
    EXECUTE 'REVOKE ALL ON FUNCTION ' || v_target_func || '(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) FROM PUBLIC, anon, authenticated, service_role;';
  ELSE
    EXECUTE 'REVOKE ALL ON FUNCTION ' || v_target_func || '(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) FROM PUBLIC, anon, authenticated;';
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_target_func || '(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) TO service_role;';
  END IF;
END $$;

COMMIT;

