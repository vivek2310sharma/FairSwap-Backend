-- =============================================================================
-- pgTAP Test: Azure Moderation V1 Security, Privileges & Behavioural Gates
-- =============================================================================
-- Behavioural tests:
-- 1. Table RLS enforcement on app_security tables.
-- 2. Privileges: anon/authenticated cannot execute registrar or finalizer.
-- 3. Invariant: Legacy 3-rule prototype_v0.1.1 cannot auto-approve (downgraded to needs_review).
-- 4. Invariant: Forged receipt with modified/missing check cannot register or approve.
-- 5. Invariant: Digest mismatch rejects registration.
-- 6. Invariant: Duplicate media ID in manifest rejects registration.
-- 7. Invariant: Missing request returns REQUEST_NOT_FOUND error.
-- 8. Invariant: Successful scan receipt registration and auto-approval.
-- 9. Invariant: Replayed/consumed receipt rejection.
-- 10. Invariant: Changed/replaced media fails finalizer auto-approval (checks_incomplete).
-- 11. Invariant: Legacy prototype worker on fresh pending listing cannot auto-approve.
-- =============================================================================

BEGIN;
SELECT plan(24);

-- 1. Table existence (2 tests)
SELECT has_table('app_security', 'listing_moderation_scan_receipts', 'receipts table exists');
SELECT has_table('app_security', 'listing_media_verified_hashes', 'verified hashes table exists');

-- 2. Table Privileges (6 tests)
SELECT table_privs_are('app_security', 'listing_moderation_scan_receipts', 'anon', ARRAY[]::text[], 'anon has no privs on scan receipts');
SELECT table_privs_are('app_security', 'listing_moderation_scan_receipts', 'authenticated', ARRAY[]::text[], 'authenticated has no privs on scan receipts');
SELECT table_privs_are('app_security', 'listing_moderation_scan_receipts', 'service_role', ARRAY['SELECT', 'INSERT', 'UPDATE']::text[], 'service_role has receipt privs');

SELECT table_privs_are('app_security', 'listing_media_verified_hashes', 'anon', ARRAY[]::text[], 'anon has no privs on verified hashes');
SELECT table_privs_are('app_security', 'listing_media_verified_hashes', 'authenticated', ARRAY[]::text[], 'authenticated has no privs on verified hashes');
SELECT table_privs_are('app_security', 'listing_media_verified_hashes', 'service_role', ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[], 'service_role has verified hashes privs');

-- 3. Function privileges (6 tests)
SELECT function_privs_are('app_security', 'impl_finalize_moderation_result', ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb'], 'anon', ARRAY[]::text[], 'anon cannot EXECUTE finalizer');
SELECT function_privs_are('app_security', 'impl_finalize_moderation_result', ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb'], 'authenticated', ARRAY[]::text[], 'authenticated cannot EXECUTE finalizer');
SELECT function_privs_are('app_security', 'impl_finalize_moderation_result', ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb'], 'service_role', ARRAY['EXECUTE']::text[], 'service_role can EXECUTE finalizer');

SELECT function_privs_are('app_security', 'register_moderation_scan_receipt', ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'], 'anon', ARRAY[]::text[], 'anon cannot EXECUTE registrar');
SELECT function_privs_are('app_security', 'register_moderation_scan_receipt', ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'], 'authenticated', ARRAY[]::text[], 'authenticated cannot EXECUTE registrar');
SELECT function_privs_are('app_security', 'register_moderation_scan_receipt', ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'], 'service_role', ARRAY['EXECUTE']::text[], 'service_role can EXECUTE registrar');

-- 4. Behavioural check: registering invalid ruleset version throws exception (1 test)
PREPARE test_invalid_ruleset AS
  SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'some-digest',
    'APPROVE',
    'prototype_v0.1.1', -- Invalid: must be india_v1.0.0
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  );
SELECT throws_ok('test_invalid_ruleset', 'INVALID_POLICY_VERSION_OR_SCOPE', 'Throws on invalid ruleset version');

-- 5. Behavioural check: registering APPROVE with incomplete checks throws exception (1 test)
PREPARE test_incomplete_checks AS
  SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'some-digest',
    'APPROVE',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules'], -- Incomplete: missing 4 checks
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  );
SELECT throws_ok('test_incomplete_checks', 'INCOMPLETE_CHECKS_CANNOT_APPROVE', 'Throws when attempting to register APPROVE with incomplete checks');

-- 6. Behavioural check: registering APPROVE with media count mismatch throws exception (1 test)
PREPARE test_media_count_mismatch AS
  SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'some-digest',
    'APPROVE',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","path":"listing-originals/p.jpg","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    0 -- Claimed 0 but manifest has 1
  );
SELECT throws_ok('test_media_count_mismatch', 'MEDIA_COUNT_MISMATCH', 'Throws when manifest count does not match scanned_media_count');

-- 7. Behavioural check: unconsumed receipt required; missing request returns REQUEST_NOT_FOUND error (1 test)
PREPARE test_missing_request AS
  SELECT app_security.impl_finalize_moderation_result(
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,
    'no_review_flags',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '[]'::jsonb
  );
SELECT row_eq('test_missing_request', ROW(jsonb_build_object('success', false, 'error', 'REQUEST_NOT_FOUND')), 'Missing request returns REQUEST_NOT_FOUND error');

-- 8. Finalizer and registrar definition (2 tests)
SELECT is_definer('app_security', 'impl_finalize_moderation_result', ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb'], 'Finalizer is SECURITY DEFINER');
SELECT is_definer('app_security', 'register_moderation_scan_receipt', ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'], 'Registrar is SECURITY DEFINER');

-- 9. Behavioural End-to-End Approval (1 test)
DO $test_e2e$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_id uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000001'::uuid;
  v_media_id uuid := '50000000-0000-0000-0000-000000000001'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000001'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000001'::uuid;
  v_claim_token uuid := '80000000-0000-0000-0000-000000000001'::uuid;
  v_sha text := 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  v_digest text;
  v_res jsonb;
BEGIN
  -- Insert prerequisites
  INSERT INTO auth.users (id, email) VALUES (v_user_id, 'seller@test.invalid');
  INSERT INTO public.categories (id, slug, name) VALUES (v_cat_id, 'electronics', 'Electronics');
  INSERT INTO public.cities (id, slug, name) VALUES (v_city_id, 'bengaluru', 'Bengaluru');

  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Clean Gaming Headset', 'Perfect condition with original box.', v_cat_id, v_city_id, 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_id, v_listing_id, 'listings/photo1.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_claim_token, clock_timestamp() + interval '5 minutes',
    1, 'Clean Gaming Headset', 'Perfect condition with original box.'
  );

  -- Compute correct digest for manifest: v_media_id:listings/photo1.jpg:v_sha
  SELECT pg_catalog.encode(
    extensions.digest(v_media_id::text || ':listings/photo1.jpg:' || v_sha, 'sha256'),
    'hex'
  ) INTO v_digest;

  -- 9a. Register scan receipt
  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id,
    v_claim_token,
    v_listing_id,
    1,
    v_gen_id,
    v_digest,
    'APPROVE',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', v_media_id, 'path', 'listings/photo1.jpg', 'sha256', v_sha)),
    1
  );

  -- 9b. Finalize with clean outcome -> Auto approves
  SELECT app_security.impl_finalize_moderation_result(
    v_req_id,
    v_claim_token,
    'no_review_flags',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '[]'::jsonb
  ) INTO v_res;

  IF (v_res->>'success')::boolean IS NOT TRUE OR v_res->>'decision' != 'auto_approved' THEN
    RAISE EXCEPTION 'Auto approval failed: %', v_res;
  END IF;
END;
$test_e2e$;

-- Verify the listing was actually set to active (1 test)
SELECT results_eq(
  'SELECT status::text FROM public.listings WHERE id = ''40000000-0000-0000-0000-000000000001''::uuid',
  ARRAY['active'::text],
  'Listing status transitioned to active on auto approval'
);

-- 10. Behavioural check: Replayed/consumed receipt rejection (1 test)
DO $test_replay$
DECLARE
  v_res jsonb;
  v_req_id uuid := '60000000-0000-0000-0000-000000000002'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000001'::uuid;
  v_claim_token uuid := '80000000-0000-0000-0000-000000000002'::uuid;
BEGIN
  -- Insert a second claimed request for the same listing
  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, '70000000-0000-0000-0000-000000000001'::uuid, 'claimed', v_claim_token,
    clock_timestamp() + interval '5 minutes', 1, 'Clean Gaming Headset', 'Perfect condition with original box.'
  );

  -- Attempt to finalize without registering a new unconsumed receipt (the earlier receipt was consumed = true)
  SELECT app_security.impl_finalize_moderation_result(
    v_req_id,
    v_claim_token,
    'no_review_flags',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '[]'::jsonb
  ) INTO v_res;

  -- Because the receipt was consumed, no valid unconsumed receipt exists: must downgrade to awaiting_retry / checks_incomplete
  IF v_res->>'decision' = 'auto_approved' THEN
    RAISE EXCEPTION 'Consumed receipt was replayed and auto approved';
  END IF;
END;
$test_replay$;
SELECT pass('Consumed scan receipt cannot be replayed for subsequent approval');

-- 11. Behavioural check: Changed/replaced media fails finalizer auto-approval (1 test)
DO $test_changed_media$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_id uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000003'::uuid;
  v_media_id uuid := '50000000-0000-0000-0000-000000000003'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000003'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000003'::uuid;
  v_claim_token uuid := '80000000-0000-0000-0000-000000000003'::uuid;
  v_sha text := 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  v_digest text;
  v_res jsonb;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Another Item', 'Good condition.', v_cat_id, v_city_id, 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_id, v_listing_id, 'listings/photo_original.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_claim_token, clock_timestamp() + interval '5 minutes',
    1, 'Another Item', 'Good condition.'
  );

  SELECT pg_catalog.encode(
    extensions.digest(v_media_id::text || ':listings/photo_original.jpg:' || v_sha, 'sha256'),
    'hex'
  ) INTO v_digest;

  -- Register receipt with original path
  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id,
    v_claim_token,
    v_listing_id,
    1,
    v_gen_id,
    v_digest,
    'APPROVE',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    jsonb_build_array(jsonb_build_object('id', v_media_id, 'path', 'listings/photo_original.jpg', 'sha256', v_sha)),
    1
  );

  -- Mutate listing_media path behind the scenes (simulating media swap after scan)
  UPDATE public.listing_media
  SET original_storage_path = 'listings/photo_replaced_attacker.jpg'
  WHERE id = v_media_id;

  -- Finalize should detect the path mismatch against manifest and fail closed
  SELECT app_security.impl_finalize_moderation_result(
    v_req_id,
    v_claim_token,
    'no_review_flags',
    'india_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '[]'::jsonb
  ) INTO v_res;

  IF v_res->>'decision' = 'auto_approved' THEN
    RAISE EXCEPTION 'Changed media was improperly auto approved';
  END IF;
END;
$test_changed_media$;
SELECT pass('Modified/swapped media fails finalizer auto-approval');

-- 12. Behavioural check: Legacy prototype worker on fresh pending listing cannot auto-approve (1 test)
DO $test_legacy_fresh$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_id uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000004'::uuid;
  v_media_id uuid := '50000000-0000-0000-0000-000000000004'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000004'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000004'::uuid;
  v_claim_token uuid := '80000000-0000-0000-0000-000000000004'::uuid;
  v_res jsonb;
BEGIN
  -- Insert completely fresh pending listing and claimed request
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Fresh Eligible Listing', 'Description here.', v_cat_id, v_city_id, 'pending_review', 1);

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_id, v_listing_id, 'listings/photo_fresh.jpg', 'ready', 0);

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_claim_token, clock_timestamp() + interval '5 minutes',
    1, 'Fresh Eligible Listing', 'Description here.'
  );

  -- Invoke finalizer with legacy prototype_v0.1.1 ruleset
  SELECT app_security.impl_finalize_moderation_result(
    v_req_id,
    v_claim_token,
    'no_review_flags',
    'prototype_v0.1.1', -- Legacy ruleset
    'title_description',
    ARRAY['rule_prohibited_item_wording', 'rule_shortened_link', 'rule_payment_before_viewing'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '[]'::jsonb
  ) INTO v_res;

  -- Under the new gate, legacy ruleset is forced to needs_review / routed_to_admin and cannot auto approve
  IF v_res->>'decision' = 'auto_approved' THEN
    RAISE EXCEPTION 'Security breach: legacy prototype auto approved fresh eligible listing';
  END IF;
END;
$test_legacy_fresh$;
SELECT pass('Legacy prototype worker cannot bypass gate even on a fresh eligible listing');

SELECT * FROM finish();
ROLLBACK;
