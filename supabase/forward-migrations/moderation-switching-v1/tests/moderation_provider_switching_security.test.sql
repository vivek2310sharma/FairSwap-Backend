-- =============================================================================
-- pgTAP Test: Provider-Switchable Moderation Architecture Security Suite
-- 34 Authoritative Assertions
-- =============================================================================
-- Covers:
-- 1. System Settings Defaults & Kill Switch (3)
-- 2. Registrar & Finalizer ACL / Least-Privilege (4)
-- 3. Policy & Scope Validation Rules (5)
-- 4. Digest, Media Manifest & Zero-Photo Integrity (4)
-- 5. Publication Gate, Claim Leases & Replay Protection (9)
-- 6. Wearables W-AZ-1 Risk-Flag Wrapper Coexistence (4)
-- 7. Policy Downgrade Prevention, Scope Ledgering & Stale Mode Guard (5)
-- =============================================================================

BEGIN;
SELECT plan(34);

-- -----------------------------------------------------------------------------
-- 1. System Settings Defaults (3 assertions)
-- -----------------------------------------------------------------------------
SELECT results_eq(
  'SELECT setting_value FROM public.app_system_settings WHERE setting_key = ''moderation_azure_enabled''',
  $$VALUES ('false')$$,
  'moderation_azure_enabled defaults to false'
);

SELECT results_eq(
  'SELECT setting_value FROM public.app_system_settings WHERE setting_key = ''moderation_google_cloud_enabled''',
  $$VALUES ('false')$$,
  'moderation_google_cloud_enabled defaults to false'
);

SELECT results_eq(
  'SELECT setting_value FROM public.app_system_settings WHERE setting_key = ''moderation_automation_enabled''',
  $$VALUES ('true')$$,
  'moderation_automation_enabled master kill switch exists'
);

-- -----------------------------------------------------------------------------
-- 2. Registrar & Finalizer ACL / Permissions (4 assertions)
-- -----------------------------------------------------------------------------
SELECT function_privs_are(
  'app_security', 'register_moderation_scan_receipt',
  ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'],
  'anon', ARRAY[]::text[],
  'anon cannot execute register_moderation_scan_receipt'
);

SELECT function_privs_are(
  'app_security', 'register_moderation_scan_receipt',
  ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'],
  'authenticated', ARRAY[]::text[],
  'authenticated cannot execute register_moderation_scan_receipt'
);

SELECT function_privs_are(
  'app_security', 'register_moderation_scan_receipt',
  ARRAY['uuid', 'uuid', 'uuid', 'integer', 'uuid', 'text', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb', 'jsonb', 'integer'],
  'service_role', ARRAY['EXECUTE']::text[],
  'service_role can execute register_moderation_scan_receipt'
);

SELECT function_privs_are(
  'app_security', 'impl_finalize_moderation_result',
  ARRAY['uuid', 'uuid', 'text', 'text', 'text', 'text[]', 'text[]', 'jsonb', 'jsonb'],
  'service_role', ARRAY['EXECUTE']::text[],
  'service_role can execute impl_finalize_moderation_result'
);

-- -----------------------------------------------------------------------------
-- 3. Policy & Scope Validation Rules (5 assertions)
-- -----------------------------------------------------------------------------
SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'dummy-digest',
    'APPROVE',
    'invalid_policy_v2',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  )$$,
  'INVALID_POLICY_VERSION_OR_SCOPE',
  'Throws on unreviewed policy version'
);

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'dummy-digest',
    'APPROVE',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'], -- Missing 3 image checks
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  )$$,
  'INCOMPLETE_CHECKS_CANNOT_APPROVE',
  'Throws when 5-check APPROVE misses vision checks'
);

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'dummy-digest',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules'], -- Missing OpenAI check
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  )$$,
  'INCOMPLETE_CHECKS_CANNOT_APPROVE',
  'Throws when 2-check APPROVE misses OpenAI check'
);

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '11111111-1111-1111-1111-111111111111'::uuid,
    '22222222-2222-2222-2222-222222222222'::uuid,
    '33333333-3333-3333-3333-333333333333'::uuid,
    1,
    '44444444-4444-4444-4444-444444444444'::uuid,
    'dummy-digest',
    'APPROVE',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0 -- 0 photos is forbidden under five-check
  )$$,
  'ZERO_MEDIA_DISALLOWED_FOR_MULTIMODAL_POLICY',
  'Five-check policy rejects 0-photo scan receipt'
);

-- Seed base entities for behavioral fixtures
DO $fixture_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_cat_cars uuid := '20000000-0000-0000-0000-000000000002'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_two_check uuid := '40000000-0000-0000-0000-000000000001'::uuid;
  v_req_two_check uuid := '60000000-0000-0000-0000-000000000001'::uuid;
  v_gen_two_check uuid := '70000000-0000-0000-0000-000000000001'::uuid;
  v_token_two_check uuid := '80000000-0000-0000-0000-000000000001'::uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (v_user_id, 'mod_test@fairswap.invalid') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.cities (id, slug, name) VALUES (v_city_id, 'bengaluru', 'Bengaluru') ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.categories (id, slug, name, is_active) VALUES
    (v_cat_mobiles, 'mobiles', 'Mobile Phones', true),
    (v_cat_cars, 'cars', 'Cars', true)
  ON CONFLICT (id) DO NOTHING;

  -- Low-risk mobiles listing with 0 photos
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_two_check, v_user_id, 'Samsung Galaxy Phone', 'Clean used phone', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_two_check, v_listing_two_check, 1, v_gen_two_check, 'claimed', v_token_two_check,
    clock_timestamp() + interval '10 minutes', 1, 'Samsung Galaxy Phone', 'Clean used phone'
  ) ON CONFLICT (id) DO NOTHING;
END;
$fixture_setup$;

SELECT is(
  (SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000001'::uuid,
    '80000000-0000-0000-0000-000000000001'::uuid,
    '40000000-0000-0000-0000-000000000001'::uuid,
    1,
    '70000000-0000-0000-0000-000000000001'::uuid,
    '',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[]'::jsonb,
    0
  ) IS NOT NULL),
  true,
  'Baseline two-check permits zero-photo scan receipt'
);

-- -----------------------------------------------------------------------------
-- 4. Digest, Media Manifest & Photo Integrity (4 assertions)
-- -----------------------------------------------------------------------------
DO $media_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000002'::uuid;
  v_media_id uuid := '50000000-0000-0000-0000-000000000001'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000002'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000002'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000002'::uuid;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'OnePlus Phone', 'OnePlus 11', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_id, v_listing_id, 'listing-originals/oneplus.webp', 'ready', 0)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'OnePlus Phone', 'OnePlus 11'
  ) ON CONFLICT (id) DO NOTHING;
END;
$media_setup$;

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    '40000000-0000-0000-0000-000000000002'::uuid,
    1,
    '70000000-0000-0000-0000-000000000002'::uuid,
    'forged-digest-value',
    'APPROVE',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[{"id":"50000000-0000-0000-0000-000000000001","path":"listing-originals/oneplus.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    1
  )$$,
  'MEDIA_DIGEST_MISMATCH',
  'Throws on forged media digest'
);

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    '40000000-0000-0000-0000-000000000002'::uuid,
    1,
    '70000000-0000-0000-0000-000000000002'::uuid,
    'some-digest',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[{"id":"50000000-0000-0000-0000-000000000001","path":"listing-originals/oneplus.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},{"id":"50000000-0000-0000-0000-000000000001","path":"listing-originals/oneplus.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    2
  )$$,
  'DUPLICATE_MEDIA_ID_IN_MANIFEST',
  'Throws on duplicate media ID in manifest'
);

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    '40000000-0000-0000-0000-000000000002'::uuid,
    1,
    '70000000-0000-0000-0000-000000000002'::uuid,
    'some-digest',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[],
    '[]'::jsonb,
    '{}'::jsonb,
    '[{"id":"59999999-9999-9999-9999-999999999999","path":"listing-originals/unknown.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    1
  )$$,
  'MEDIA_ID_NOT_ATTACHED_TO_LISTING',
  'Throws when manifest media is not in database'
);

-- Valid registration of baseline receipt with 1 media item
DO $register_valid_baseline$
DECLARE
  v_req_id uuid := '60000000-0000-0000-0000-000000000002'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000002'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000002'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000002'::uuid;
  v_manifest_line text := '50000000-0000-0000-0000-000000000001:listing-originals/oneplus.webp:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  v_digest text := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_manifest_line, 'UTF8'), 'sha256'), 'hex');
BEGIN
  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_listing_id, 1, v_gen_id, v_digest,
    'APPROVE', 'india_baseline_v1.0.0', 'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb,
    '[{"id":"50000000-0000-0000-0000-000000000001","path":"listing-originals/oneplus.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    1
  );
END;
$register_valid_baseline$;

SELECT is(
  (SELECT count(*) = 1 FROM app_security.listing_moderation_scan_receipts WHERE request_id = '60000000-0000-0000-0000-000000000002'::uuid),
  true,
  'Baseline two-check receipt with valid media digest registered successfully'
);

-- -----------------------------------------------------------------------------
-- 5. Publication Gate, Leases & Replay Protection (9 assertions)
-- -----------------------------------------------------------------------------
SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '99999999-9999-9999-9999-999999999999'::uuid, -- Forged claim token
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'error')),
  'LEASE_TOKEN_MISMATCH',
  'Invalid claim token fails closed'
);

-- Finalize valid baseline listing
SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'auto_approved',
  'Baseline two-check auto-approves eligible low-risk listing'
);

SELECT results_eq(
  'SELECT status FROM public.listings WHERE id = ''40000000-0000-0000-0000-000000000002''::uuid',
  $$VALUES ('active'::public.listing_status_enum)$$,
  'Listing status transitioned to active on auto_approved'
);

-- Replay protection: attempt to finalize again with completed request
SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000002'::uuid,
    '80000000-0000-0000-0000-000000000002'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'error')),
  'REQUEST_NOT_CLAIMED',
  'Replayed finalizer on completed request fails'
);

-- Restricted category: car listing cannot auto-approve under baseline two-check
DO $car_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_cars uuid := '20000000-0000-0000-0000-000000000002'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_car_listing uuid := '40000000-0000-0000-0000-000000000003'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000003'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000003'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000003'::uuid;
BEGIN
  INSERT INTO public.car_category_contracts (category_id) VALUES (v_cat_cars) ON CONFLICT (category_id) DO NOTHING;

  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_car_listing, v_user_id, 'Used Sedan', 'Good condition', v_cat_cars, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_car_listing, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'Used Sedan', 'Good condition'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_car_listing, 1, v_gen_id, '',
    'APPROVE', 'india_baseline_v1.0.0', 'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
END;
$car_setup$;

SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000003'::uuid,
    '80000000-0000-0000-0000-000000000003'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'routed_to_admin',
  'Baseline two-check on restricted car category routes to admin review instead of auto-approving'
);

-- Zero photo baseline auto-approves eligible category
SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000001'::uuid,
    '80000000-0000-0000-0000-000000000001'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'auto_approved',
  'Zero-photo listing auto-approves under baseline two-check policy for eligible category'
);

-- Stale media tampering: adding photo after scan receipt causes checks_incomplete / awaiting_retry
DO $tamper_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000004'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000004'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000004'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000004'::uuid;
  v_media_id uuid := '50000000-0000-0000-0000-000000000004'::uuid;
  v_line text := '50000000-0000-0000-0000-000000000004:listing-originals/p4.webp:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  v_digest text := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_line, 'UTF8'), 'sha256'), 'hex');
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Tamper Test Phone', 'Desc', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_id, v_listing_id, 'listing-originals/p4.webp', 'ready', 0)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'Tamper Test Phone', 'Desc'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_listing_id, 1, v_gen_id, v_digest,
    'APPROVE', 'india_azure_v1.0.0', 'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb,
    '[{"id":"50000000-0000-0000-0000-000000000004","path":"listing-originals/p4.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    1
  );

  -- Malicious attacker injects second unverified photo after scan receipt
  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES ('50000000-0000-0000-0000-000000000005'::uuid, v_listing_id, 'listing-originals/unscanned.webp', 'ready', 1);
END;
$tamper_setup$;

SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000004'::uuid,
    '80000000-0000-0000-0000-000000000004'::uuid,
    'no_review_flags',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'awaiting_retry',
  'Post-scan media tampering prevents auto-approval and routes to retry'
);

-- Master kill switch disables auto-approval
UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_automation_enabled';

DO $kill_switch_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000006'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000006'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000006'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000006'::uuid;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Kill Switch Test Phone', 'Desc', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'Kill Switch Test Phone', 'Desc'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_listing_id, 1, v_gen_id, '',
    'APPROVE', 'india_baseline_v1.0.0', 'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
END;
$kill_switch_setup$;

SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000006'::uuid,
    '80000000-0000-0000-0000-000000000006'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'routed_to_admin',
  'When moderation_automation_enabled is false, finalizer routes to admin instead of auto-approving'
);

-- Restore kill switch
UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_automation_enabled';

-- Expired claim lease fails closed
DO $lease_expired_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000007'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000007'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000007'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000007'::uuid;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Expired Lease Phone', 'Desc', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() - interval '1 minute', -- Expired in the past!
    1, 'Expired Lease Phone', 'Desc'
  ) ON CONFLICT (id) DO NOTHING;
END;
$lease_expired_setup$;

SELECT throws_ok(
  $$SELECT app_security.register_moderation_scan_receipt(
    '60000000-0000-0000-0000-000000000007'::uuid,
    '80000000-0000-0000-0000-000000000007'::uuid,
    '40000000-0000-0000-0000-000000000007'::uuid,
    1,
    '70000000-0000-0000-0000-000000000007'::uuid,
    '',
    'APPROVE',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  )$$,
  'CLAIM_LEASE_EXPIRED',
  'Expired claim lease rejects receipt registration'
);

-- -----------------------------------------------------------------------------
-- 6. Wearables W-AZ-1 Risk-Flag Wrapper Coexistence (4 assertions)
-- -----------------------------------------------------------------------------
DO $wearable_coexistence_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_wearables uuid := '20000000-0000-0000-0000-000000000008'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_clean uuid := '40000000-0000-0000-0000-000000000008'::uuid;
  v_listing_flagged uuid := '40000000-0000-0000-0000-000000000009'::uuid;
  v_req_clean uuid := '60000000-0000-0000-0000-000000000008'::uuid;
  v_req_flagged uuid := '60000000-0000-0000-0000-000000000009'::uuid;
  v_gen_clean uuid := '70000000-0000-0000-0000-000000000008'::uuid;
  v_gen_flagged uuid := '70000000-0000-0000-0000-000000000009'::uuid;
  v_token_clean uuid := '80000000-0000-0000-0000-000000000008'::uuid;
  v_token_flagged uuid := '80000000-0000-0000-0000-000000000009'::uuid;
  v_media_clean uuid := '50000000-0000-0000-0000-000000000008'::uuid;
  v_media_flagged uuid := '50000000-0000-0000-0000-000000000009'::uuid;
  v_line_c text := '50000000-0000-0000-0000-000000000008:listing-originals/w_clean.webp:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  v_line_f text := '50000000-0000-0000-0000-000000000009:listing-originals/w_flagged.webp:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  v_digest_c text := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_line_c, 'UTF8'), 'sha256'), 'hex');
  v_digest_f text := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_line_f, 'UTF8'), 'sha256'), 'hex');
BEGIN
  INSERT INTO public.categories (id, slug, name, is_active)
  VALUES (v_cat_wearables, 'wearables', 'Smartwatches & Wearables', true)
  ON CONFLICT (id) DO NOTHING;

  -- Clean wearable
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_clean, v_user_id, 'Apple Watch Series 8', 'Clean smartwatch', v_cat_wearables, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_clean, v_listing_clean, 'listing-originals/w_clean.webp', 'ready', 0)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_clean, v_listing_clean, 1, v_gen_clean, 'claimed', v_token_clean,
    clock_timestamp() + interval '10 minutes', 1, 'Apple Watch Series 8', 'Clean smartwatch'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_clean, v_token_clean, v_listing_clean, 1, v_gen_clean, v_digest_c,
    'APPROVE', 'india_azure_v1.0.0', 'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb,
    '[{"id":"50000000-0000-0000-0000-000000000008","path":"listing-originals/w_clean.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    1
  );

  -- Flagged wearable
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_flagged, v_user_id, 'Unknown Brand Smartwatch', 'Suspicious watch', v_cat_wearables, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_media (id, listing_id, original_storage_path, processing_status, display_order)
  VALUES (v_media_flagged, v_listing_flagged, 'listing-originals/w_flagged.webp', 'ready', 0)
  ON CONFLICT (id) DO NOTHING;

  -- Add risk flag to public.listing_wearable_risk_flags_v1 if table exists
  IF to_regclass('public.listing_wearable_risk_flags_v1') IS NOT NULL THEN
    INSERT INTO public.listing_wearable_risk_flags_v1 (listing_id, signal, severity)
    VALUES (v_listing_flagged, 'other_model_requires_staff_review', 'high')
    ON CONFLICT DO NOTHING;
  END IF;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_flagged, v_listing_flagged, 1, v_gen_flagged, 'claimed', v_token_flagged,
    clock_timestamp() + interval '10 minutes', 1, 'Unknown Brand Smartwatch', 'Suspicious watch'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_flagged, v_token_flagged, v_listing_flagged, 1, v_gen_flagged, v_digest_f,
    'APPROVE', 'india_azure_v1.0.0', 'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb,
    '[{"id":"50000000-0000-0000-0000-000000000009","path":"listing-originals/w_flagged.webp","sha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}]'::jsonb,
    1
  );
END;
$wearable_coexistence_setup$;

-- Clean wearable auto-approves
SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000008'::uuid,
    '80000000-0000-0000-0000-000000000008'::uuid,
    'no_review_flags',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'auto_approved',
  'Clean wearable auto-approves under five-check policy'
);

-- W-AZ-1: Flagged wearable diverts to routed_to_admin under outer wrapper
SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000009'::uuid,
    '80000000-0000-0000-0000-000000000009'::uuid,
    'no_review_flags',
    'india_azure_v1.0.0',
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'routed_to_admin',
  'W-AZ-1: Flagged wearable listing diverts to routed_to_admin through wrapper'
);

-- Inner finalizer impl_finalize_moderation_result_azure_v1 is private if wrapped
SELECT is(
  (SELECT CASE 
    WHEN to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') IS NOT NULL THEN
      NOT has_function_privilege('service_role', 'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('anon', 'app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
    ELSE true
  END),
  true,
  'Inner Azure finalizer is strictly private and cannot be invoked directly by any role'
);

-- Outer wrapper preserves W-AZ-1 inspection of listing_wearable_risk_flags_v1
SELECT is(
  (SELECT CASE 
    WHEN to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') IS NOT NULL THEN
      (SELECT prosrc LIKE '%listing_wearable_risk_flags_v1%' AND prosrc LIKE '%needs_review%'
       FROM pg_proc WHERE oid = to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'))
    ELSE true
  END),
  true,
  'Outer finalizer preserves W-AZ-1 risk flag divert logic'
);

-- -----------------------------------------------------------------------------
-- 7. Policy Downgrade Prevention, Scope Ledgering & Stale Mode Guard (5 assertions)
-- -----------------------------------------------------------------------------
-- Two-check receipt cannot satisfy five-check finalizer call
DO $mismatch_policy_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000010'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000010'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000010'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000010'::uuid;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Cross Policy Test', 'Desc', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'Cross Policy Test', 'Desc'
  ) ON CONFLICT (id) DO NOTHING;

  -- Registered as baseline_two_check
  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_listing_id, 1, v_gen_id, '',
    'APPROVE', 'india_baseline_v1.0.0', 'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
END;
$mismatch_policy_setup$;

SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000010'::uuid,
    '80000000-0000-0000-0000-000000000010'::uuid,
    'no_review_flags',
    'india_azure_v1.0.0', -- Finalizer claims five-check but receipt was two-check!
    'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'awaiting_retry',
  'Two-check receipt cannot satisfy five-check finalizer call (incomplete checks awaiting retry)'
);

-- Strict recording of baseline_two_check in public.listing_moderation_results
SELECT results_eq(
  'SELECT scope, ruleset_version FROM public.listing_moderation_results WHERE request_id = ''60000000-0000-0000-0000-000000000002''::uuid',
  $$VALUES ('baseline_two_check', 'india_baseline_v1.0.0')$$,
  'Two-check results strictly ledgered with scope baseline_two_check and version india_baseline_v1.0.0'
);

-- Strict recording of multimodal_five_check in public.listing_moderation_results
SELECT results_eq(
  'SELECT scope, ruleset_version FROM public.listing_moderation_results WHERE request_id = ''60000000-0000-0000-0000-000000000008''::uuid',
  $$VALUES ('multimodal_five_check', 'india_azure_v1.0.0')$$,
  'Five-check results strictly ledgered with scope multimodal_five_check and version india_azure_v1.0.0'
);

-- Failed rule in outcome leads to routed_to_admin, never auto_approved
DO $failed_rule_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000011'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000011'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000011'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000011'::uuid;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Flagged Rule Listing', 'Desc', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'Flagged Rule Listing', 'Desc'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_listing_id, 1, v_gen_id, '',
    'FLAG', 'india_baseline_v1.0.0', 'baseline_two_check',
    ARRAY['check_india_fraud_rules'],
    ARRAY['check_openai_moderation'],
    '[{"rule":"check_openai_moderation","flag":"violence"}]'::jsonb,
    '{}'::jsonb, '[]'::jsonb, 0
  );
END;
$failed_rule_setup$;

SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000011'::uuid,
    '80000000-0000-0000-0000-000000000011'::uuid,
    'needs_review',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules'],
    ARRAY['check_openai_moderation'],
    '[{"rule":"check_openai_moderation","flag":"violence"}]'::jsonb,
    '{}'::jsonb
  )->>'decision')),
  'routed_to_admin',
  'Failed rule prevents auto-approval and strictly routes to admin'
);

-- Stale mode-switch guard: baseline two-check cannot auto-approve if Azure was enabled mid-flight
DO $stale_mode_setup$
DECLARE
  v_user_id uuid := '10000000-0000-0000-0000-000000000001'::uuid;
  v_cat_mobiles uuid := '20000000-0000-0000-0000-000000000001'::uuid;
  v_city_id uuid := '30000000-0000-0000-0000-000000000001'::uuid;
  v_listing_id uuid := '40000000-0000-0000-0000-000000000012'::uuid;
  v_req_id uuid := '60000000-0000-0000-0000-000000000012'::uuid;
  v_gen_id uuid := '70000000-0000-0000-0000-000000000012'::uuid;
  v_token uuid := '80000000-0000-0000-0000-000000000012'::uuid;
BEGIN
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, status, revision)
  VALUES (v_listing_id, v_user_id, 'Stale Mode Switch Test', 'Desc', v_cat_mobiles, v_city_id, 'pending_review', 1)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.listing_moderation_requests (
    id, listing_id, listing_revision, generation_id, status, claim_token, claim_expires_at,
    attempt_count, evaluated_title, evaluated_description
  ) VALUES (
    v_req_id, v_listing_id, 1, v_gen_id, 'claimed', v_token,
    clock_timestamp() + interval '10 minutes', 1, 'Stale Mode Switch Test', 'Desc'
  ) ON CONFLICT (id) DO NOTHING;

  PERFORM app_security.register_moderation_scan_receipt(
    v_req_id, v_token, v_listing_id, 1, v_gen_id, '',
    'APPROVE', 'india_baseline_v1.0.0', 'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );

  -- Mid-flight mode switch: Azure gets enabled!
  UPDATE public.app_system_settings SET setting_value = 'true' WHERE setting_key = 'moderation_azure_enabled';
END;
$stale_mode_setup$;

SELECT is(
  (SELECT (app_security.impl_finalize_moderation_result(
    '60000000-0000-0000-0000-000000000012'::uuid,
    '80000000-0000-0000-0000-000000000012'::uuid,
    'no_review_flags',
    'india_baseline_v1.0.0',
    'baseline_two_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'],
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb
  )->>'decision')),
  'routed_to_admin',
  'Stale baseline two-check result diverts to routed_to_admin when Azure was enabled mid-flight'
);

-- Revert setting
UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_azure_enabled';

SELECT * FROM finish();
ROLLBACK;
