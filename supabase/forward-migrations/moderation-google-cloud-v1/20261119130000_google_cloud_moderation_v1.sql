-- Forward Migration: Google Cloud Moderation V1 & Quad-Mode Switching
-- Sequenced: 20261119130000_google_cloud_moderation_v1.sql
--
-- Security & Invariant Design:
-- 1. System Settings:
--    Ensures moderation_google_cloud_enabled and moderation_azure_enabled exist (default 'false').
--    Retains moderation_automation_enabled master kill switch.
--    Installs BEFORE UPDATE trigger on app_system_settings to maintain updated_at on all setting modifications.
-- 2. Scan Receipts (register_moderation_scan_receipt):
--    Accepts all four authoritative policies:
--      a) 'india_baseline_v1.0.0' / 'baseline_two_check' (2 mandatory checks)
--      b) 'india_azure_v1.0.0' (or legacy 'india_v1.0.0') / 'multimodal_five_check' (5 mandatory checks)
--      c) 'india_google_v1.0.0' / 'multimodal_five_check' (5 mandatory checks)
--      d) 'india_dual_cloud_v1.0.0' / 'multimodal_seven_check' (multimodal dual-cloud checks)
--    Enforces digest matching, original-storage path matching, verified hashes insertion, and lease checks.
-- 3. In-Flight Switch & Race Safeguard:
--    Fails closed to needs_review if any moderation setting (moderation_azure_enabled,
--    moderation_google_cloud_enabled, moderation_automation_enabled) was updated while the job
--    was in-flight (updated_at > claimed_at), even if toggled away and back.
-- 4. Mode-Setting Consistency Guard:
--    Fails closed to needs_review if current database settings do not match the evaluated policy.
-- 5. Wearables (W-AZ-1) & Category Safeguards:
--    Preserves outer Wearables wrapper if present (updating inner function app_security.impl_finalize_moderation_result_azure_v1)
--    or base function app_security.impl_finalize_moderation_result.
--    Preserves restricted category routing (Cars, Two-Wheelers, Property) to staff review.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- 1. Ensure System Settings exist with Default False
INSERT INTO public.app_system_settings (setting_key, setting_value, description)
VALUES 
  ('moderation_azure_enabled', 'false', 'Enable optional Azure multimodal image moderation checks'),
  ('moderation_google_cloud_enabled', 'false', 'Enable optional Google Cloud Run multimodal image moderation checks')
ON CONFLICT (setting_key) DO NOTHING;

-- 2. Maintain updated_at timestamp on app_system_settings on any update
CREATE OR REPLACE FUNCTION app_security.trg_fn_update_app_system_settings_timestamp()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_app_system_settings_updated_at ON public.app_system_settings;
CREATE TRIGGER trg_app_system_settings_updated_at
BEFORE UPDATE ON public.app_system_settings
FOR EACH ROW
EXECUTE FUNCTION app_security.trg_fn_update_app_system_settings_timestamp();

-- 3. Enhanced Register Scan Receipt RPC for Quad-Mode Moderation
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
  v_mandatory_two_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation'
  ]::text[];
  v_mandatory_azure_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_vision_nsfw',
    'check_vision_category',
    'check_ocr_qr'
  ]::text[];
  v_mandatory_azure_prefixed_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_azure_vision_nsfw',
    'check_azure_vision_category',
    'check_azure_ocr_qr'
  ]::text[];
  v_mandatory_google_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_google_vision_nsfw',
    'check_google_vision_category',
    'check_google_ocr_qr'
  ]::text[];
  v_mandatory_dual_eight_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_azure_vision_nsfw',
    'check_azure_vision_category',
    'check_azure_ocr_qr',
    'check_google_vision_nsfw',
    'check_google_vision_category',
    'check_google_ocr_qr'
  ]::text[];
  v_is_azure_five_check boolean := false;
  v_is_google_five_check boolean := false;
  v_is_dual_cloud_check boolean := false;
  v_is_two_check boolean := false;
BEGIN
  -- Strict Policy and Scope Validation
  IF (p_ruleset_version IN ('india_azure_v1.0.0', 'india_v1.0.0') AND p_scope = 'multimodal_five_check') THEN
    v_is_azure_five_check := true;
  ELSIF (p_ruleset_version = 'india_google_v1.0.0' AND p_scope = 'multimodal_five_check') THEN
    v_is_google_five_check := true;
  ELSIF (p_ruleset_version = 'india_dual_cloud_v1.0.0' AND p_scope IN ('multimodal_eight_check', 'multimodal_seven_check', 'dual_cloud_eight_check')) THEN
    v_is_dual_cloud_check := true;
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

    IF v_is_azure_five_check AND NOT (p_completed_checks @> v_mandatory_azure_five_checks OR p_completed_checks @> v_mandatory_azure_prefixed_five_checks) THEN
      RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
    ELSIF v_is_google_five_check AND NOT (p_completed_checks @> v_mandatory_google_five_checks) THEN
      RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
    ELSIF v_is_two_check AND NOT (p_completed_checks @> v_mandatory_two_checks) THEN
      RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
    ELSIF v_is_dual_cloud_check THEN
      -- Dual cloud requires all 8 distinct independent attestations
      IF NOT (p_completed_checks @> v_mandatory_dual_eight_checks) OR cardinality(p_completed_checks) < 8 THEN
        RAISE EXCEPTION 'INCOMPLETE_CHECKS_CANNOT_APPROVE';
      END IF;
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

-- 4. Core Finalizer Update Preserving Wearables (W-AZ-1) Compatibility Wrapper
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
  v_az_receipt app_security.listing_moderation_scan_receipts%%ROWTYPE;
  v_g_receipt app_security.listing_moderation_scan_receipts%%ROWTYPE;
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
  v_mandatory_two_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation'
  ]::text[];
  v_mandatory_azure_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_vision_nsfw',
    'check_vision_category',
    'check_ocr_qr'
  ]::text[];
  v_mandatory_azure_prefixed_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_azure_vision_nsfw',
    'check_azure_vision_category',
    'check_azure_ocr_qr'
  ]::text[];
  v_mandatory_google_five_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_google_vision_nsfw',
    'check_google_vision_category',
    'check_google_ocr_qr'
  ]::text[];
  v_mandatory_dual_eight_checks text[] := ARRAY[
    'check_india_fraud_rules',
    'check_openai_moderation',
    'check_azure_vision_nsfw',
    'check_azure_vision_category',
    'check_azure_ocr_qr',
    'check_google_vision_nsfw',
    'check_google_vision_category',
    'check_google_ocr_qr'
  ]::text[];
  v_is_azure boolean := false;
  v_is_google boolean := false;
  v_is_dual_cloud boolean := false;
  v_is_two_check boolean := false;
  v_receipt_item jsonb;
  v_m_id uuid;
  v_m_path text;
  v_m_sha text;
  v_db_m_path text;
  v_recorded_sha text;
  v_category_record public.categories%%ROWTYPE;
  v_is_restricted_category boolean := false;
  v_azure_active boolean := false;
  v_google_active boolean := false;
  v_automation_active boolean := false;
  v_setting_modified_in_flight boolean := false;
  v_setting_row record;
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
    v_is_azure := true;
  ELSIF (p_ruleset_version = 'india_google_v1.0.0' AND p_scope = 'multimodal_five_check') THEN
    v_is_google := true;
  ELSIF (p_ruleset_version = 'india_dual_cloud_v1.0.0' AND p_scope IN ('multimodal_eight_check', 'multimodal_seven_check', 'dual_cloud_eight_check')) THEN
    v_is_dual_cloud := true;
  ELSIF (p_ruleset_version = 'india_baseline_v1.0.0' AND p_scope = 'baseline_two_check') THEN
    v_is_two_check := true;
  ELSE
    -- Unrecognized policy versions fail closed to needs_review
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

  -- Verify pre-registered scan receipts (dual-cloud requires both independent Azure and Google receipts)
  IF v_is_dual_cloud THEN
    SELECT * INTO v_az_receipt
    FROM app_security.listing_moderation_scan_receipts
    WHERE request_id = p_request_id
      AND listing_id = v_listing.id
      AND listing_revision = v_listing.revision
      AND generation_id = v_req.generation_id
      AND ruleset_version IN ('india_azure_v1.0.0', 'india_v1.0.0')
      AND scope = 'multimodal_five_check'
      AND consumed = false
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    SELECT * INTO v_g_receipt
    FROM app_security.listing_moderation_scan_receipts
    WHERE request_id = p_request_id
      AND listing_id = v_listing.id
      AND listing_revision = v_listing.revision
      AND generation_id = v_req.generation_id
      AND ruleset_version = 'india_google_v1.0.0'
      AND scope = 'multimodal_five_check'
      AND consumed = false
    ORDER BY created_at DESC
    LIMIT 1
    FOR UPDATE;

    IF v_az_receipt.id IS NOT NULL AND v_g_receipt.id IS NOT NULL THEN
      IF v_az_receipt.verdict = 'APPROVE' AND v_g_receipt.verdict = 'APPROVE'
         AND cardinality(v_az_receipt.failed_checks) = 0 AND cardinality(v_g_receipt.failed_checks) = 0
         AND jsonb_array_length(v_az_receipt.flags) = 0 AND jsonb_array_length(v_g_receipt.flags) = 0
         AND v_az_receipt.media_digest = v_g_receipt.media_digest
         AND (v_az_receipt.completed_checks @> v_mandatory_azure_five_checks OR v_az_receipt.completed_checks @> v_mandatory_azure_prefixed_five_checks)
         AND (v_g_receipt.completed_checks @> v_mandatory_google_five_checks)
         AND v_az_receipt.scanned_media_count > 0 AND v_g_receipt.scanned_media_count > 0 THEN

        SELECT
          count(*),
          count(*) FILTER (WHERE processing_status != 'ready'),
          count(*) FILTER (WHERE processing_status = 'failed')
        INTO v_media_count, v_unready_media_count, v_failed_media_count
        FROM public.listing_media
        WHERE listing_id = v_listing.id;

        IF v_media_count = v_az_receipt.scanned_media_count AND v_media_count = v_g_receipt.scanned_media_count
           AND v_unready_media_count = 0 AND v_failed_media_count = 0 THEN
          v_has_valid_receipt := true;

          -- Re-verify each item in manifest against live listing_media and recorded verified hashes
          FOR v_receipt_item IN SELECT * FROM jsonb_array_elements(v_az_receipt.manifest)
          LOOP
            v_m_id := (v_receipt_item->>'id')::uuid;
            v_m_path := v_receipt_item->>'path';
            v_m_sha := v_receipt_item->>'sha256';

            SELECT original_storage_path INTO v_db_m_path
            FROM public.listing_media
            WHERE id = v_m_id AND listing_id = v_listing.id;

            IF NOT FOUND OR v_db_m_path IS DISTINCT FROM v_m_path THEN
              v_has_valid_receipt := false;
              EXIT;
            END IF;

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
  ELSE
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

        IF (v_is_azure AND (v_receipt.completed_checks @> v_mandatory_azure_five_checks OR v_receipt.completed_checks @> v_mandatory_azure_prefixed_five_checks) AND v_receipt.scanned_media_count > 0)
           OR (v_is_google AND v_receipt.completed_checks @> v_mandatory_google_five_checks AND v_receipt.scanned_media_count > 0)
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
  END IF;

  -- IN-FLIGHT SWITCH & RACE GUARD:
  -- Lock individual settings rows with FOR SHARE to prevent concurrent settings mutation during finalization
  -- and verify current values & timestamps in the exact same transaction without aggregates on FOR SHARE.
  v_azure_active := false;
  v_google_active := false;
  v_automation_active := false;
  v_setting_modified_in_flight := false;

  FOR v_setting_row IN
    SELECT setting_key, setting_value, updated_at
    FROM public.app_system_settings
    WHERE setting_key IN ('moderation_azure_enabled', 'moderation_google_cloud_enabled', 'moderation_automation_enabled')
    FOR SHARE
  LOOP
    IF v_setting_row.setting_key = 'moderation_azure_enabled' AND v_setting_row.setting_value = 'true' THEN
      v_azure_active := true;
    ELSIF v_setting_row.setting_key = 'moderation_google_cloud_enabled' AND v_setting_row.setting_value = 'true' THEN
      v_google_active := true;
    ELSIF v_setting_row.setting_key = 'moderation_automation_enabled' AND v_setting_row.setting_value = 'true' THEN
      v_automation_active := true;
    END IF;

    IF v_req.claimed_at IS NOT NULL AND v_setting_row.updated_at > v_req.claimed_at THEN
      v_setting_modified_in_flight := true;
    END IF;
  END LOOP;

  -- Kill switch check: require both live locked setting and decrypted vault veto to permit automation
  IF NOT v_automation_active OR NOT v_automation_enabled THEN
    IF p_outcome = 'no_review_flags' THEN
      p_outcome := 'needs_review';
    END IF;
  END IF;

  -- Auto-approval requires clean outcome, verified receipt, and valid media
  IF p_outcome = 'no_review_flags' THEN
    IF NOT v_has_valid_receipt OR v_unready_media_count > 0 OR v_failed_media_count > 0 THEN
      p_outcome := 'checks_incomplete';
    END IF;
    -- Multimodal policies mandate at least 1 scanned photo
    IF (v_is_azure OR v_is_google OR v_is_dual_cloud) AND v_media_count < 1 THEN
      p_outcome := 'checks_incomplete';
    END IF;

    -- IN-FLIGHT SWITCH & RACE GUARD:
    -- If any provider setting was updated after the request was claimed, prevent unreviewed approval
    -- (Detects flag modifications away and back during scan under FOR SHARE lock)
    IF v_req.claimed_at IS NOT NULL AND v_setting_modified_in_flight THEN
      p_outcome := 'needs_review';
    END IF;

    -- MODE-SWITCH GUARD:
    -- Ensure evaluated policy matches current locked database provider configuration
    IF v_is_two_check AND (v_azure_active OR v_google_active) THEN
      p_outcome := 'needs_review';
    ELSIF v_is_azure AND (NOT v_azure_active OR v_google_active) THEN
      p_outcome := 'needs_review';
    ELSIF v_is_google AND (NOT v_google_active OR v_azure_active) THEN
      p_outcome := 'needs_review';
    ELSIF v_is_dual_cloud AND (NOT v_azure_active OR NOT v_google_active) THEN
      p_outcome := 'needs_review';
    END IF;
  END IF;

  -- Restricted category guards (Cars, Two-Wheelers, Property)
  IF to_regclass('public.car_category_contracts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.car_category_contracts WHERE category_id = $1)'
      INTO v_is_restricted_category USING v_listing.category_id;
  END IF;
  IF NOT v_is_restricted_category AND to_regclass('public.vehicle_category_contracts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.vehicle_category_contracts WHERE category_id = $1)'
      INTO v_is_restricted_category USING v_listing.category_id;
  END IF;
  IF NOT v_is_restricted_category AND to_regclass('public.property_category_contracts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.property_category_contracts WHERE category_id = $1)'
      INTO v_is_restricted_category USING v_listing.category_id;
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
  IF v_is_dual_cloud THEN
    IF v_az_receipt.id IS NOT NULL THEN
      UPDATE app_security.listing_moderation_scan_receipts
      SET consumed = true
      WHERE id = v_az_receipt.id;
    END IF;
    IF v_g_receipt.id IS NOT NULL THEN
      UPDATE app_security.listing_moderation_scan_receipts
      SET consumed = true
      WHERE id = v_g_receipt.id;
    END IF;
  ELSE
    IF v_receipt.id IS NOT NULL THEN
      UPDATE app_security.listing_moderation_scan_receipts
      SET consumed = true
      WHERE id = v_receipt.id;
    END IF;
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
        expires_at = v_now + INTERVAL '365 days',
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
END;
$$;

COMMIT;
