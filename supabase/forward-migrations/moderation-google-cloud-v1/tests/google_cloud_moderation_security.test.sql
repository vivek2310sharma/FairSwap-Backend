-- =============================================================================
-- pgTAP Test: Google Cloud Moderation V1 & Quad-Mode Security and Invariants
-- File: supabase/forward-migrations/moderation-google-cloud-v1/tests/google_cloud_moderation_security.test.sql
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '30s';
SELECT plan(19);

-- 1. Verify app_system_settings keys exist and default to 'false'
SELECT is(
  (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_google_cloud_enabled'),
  'false',
  'moderation_google_cloud_enabled exists and defaults to false'
);

SELECT is(
  (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_azure_enabled'),
  'false',
  'moderation_azure_enabled exists and defaults to false'
);

SELECT ok(
  EXISTS(SELECT 1 FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled'),
  'moderation_automation_enabled master kill switch exists'
);

-- 2. Verify trigger on app_system_settings updates updated_at timestamp
SELECT ok(
  EXISTS(
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_app_system_settings_updated_at'
  ),
  'trg_app_system_settings_updated_at trigger exists on app_system_settings'
);

-- 3. Verify function security definer and empty search_path (LIMIT 1 to prevent multiple rows if overloaded)
SELECT ok(
  p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[],
  'app_security.register_moderation_scan_receipt is SECURITY DEFINER with empty search_path'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security' AND p.proname = 'register_moderation_scan_receipt'
LIMIT 1;

SELECT ok(
  p.prosecdef AND p.proconfig @> ARRAY['search_path=""']::text[],
  'app_security.impl_finalize_moderation_result is SECURITY DEFINER with empty search_path'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security' AND p.proname = 'impl_finalize_moderation_result'
LIMIT 1;

-- 4. Verify function execution privileges (fail closed for clients, minimal for service_role)
SELECT ok(
  has_function_privilege('anon', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
  AND has_function_privilege('authenticated', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = false
  AND has_function_privilege('service_role', 'app_security.register_moderation_scan_receipt(uuid,uuid,uuid,integer,uuid,text,text,text,text,text[],text[],jsonb,jsonb,jsonb,integer)', 'EXECUTE') = true,
  'register_moderation_scan_receipt executable only by service_role'
);

SELECT ok(
  has_function_privilege('anon', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
  AND has_function_privilege('authenticated', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = false
  AND has_function_privilege('service_role', 'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') = true,
  'impl_finalize_moderation_result executable only by service_role'
);

-- 5. Test policy and scope validation in register_moderation_scan_receipt
-- Test 5a: Invalid policy rejects registration
PREPARE test_invalid_policy AS
  SELECT app_security.register_moderation_scan_receipt(
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(),
    'digest', 'APPROVE', 'invalid_policy_v1', 'multimodal_five_check',
    ARRAY['check_india_fraud_rules'], ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
SELECT throws_ok('test_invalid_policy', 'INVALID_POLICY_VERSION_OR_SCOPE', 'Throws on invalid policy version');

-- Test 5b: Missing required checks cannot approve (Google Cloud policy)
PREPARE test_google_incomplete_approval AS
  SELECT app_security.register_moderation_scan_receipt(
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(),
    'digest', 'APPROVE', 'india_google_v1.0.0', 'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'], -- Missing vision and ocr
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
SELECT throws_ok('test_google_incomplete_approval', 'INCOMPLETE_CHECKS_CANNOT_APPROVE', 'Google cloud policy rejects APPROVE with incomplete checks');

-- Test 5c: Failed checks cannot approve (Google Cloud policy)
PREPARE test_google_failed_checks_approval AS
  SELECT app_security.register_moderation_scan_receipt(
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(),
    'digest', 'APPROVE', 'india_google_v1.0.0', 'multimodal_five_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation', 'check_vision_nsfw', 'check_vision_category', 'check_ocr_qr'],
    ARRAY['check_vision_nsfw']::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 1
  );
SELECT throws_ok('test_google_failed_checks_approval', 'FAILED_CHECKS_CANNOT_APPROVE', 'Google cloud policy rejects APPROVE when failed_checks is not empty');

-- Test 5d: Dual Cloud policy rejects APPROVE with incomplete checks (requires all 8 distinct attestations)
PREPARE test_dual_incomplete_approval AS
  SELECT app_security.register_moderation_scan_receipt(
    gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(),
    'digest', 'APPROVE', 'india_dual_cloud_v1.0.0', 'multimodal_eight_check',
    ARRAY['check_india_fraud_rules', 'check_openai_moderation'], -- Missing 6 image checks
    ARRAY[]::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
SELECT throws_ok('test_dual_incomplete_approval', 'INCOMPLETE_CHECKS_CANNOT_APPROVE', 'Dual cloud policy rejects APPROVE with incomplete checks');

-- 6. Non-existent request throws REQUEST_NOT_FOUND
PREPARE test_missing_request AS
  SELECT app_security.register_moderation_scan_receipt(
    '00000000-0000-0000-0000-000000000000'::uuid, gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(),
    'digest', 'FLAG', 'india_google_v1.0.0', 'multimodal_five_check',
    ARRAY[]::text[], ARRAY['google_missing_configuration']::text[], '[]'::jsonb, '{}'::jsonb, '[]'::jsonb, 0
  );
SELECT throws_ok('test_missing_request', 'REQUEST_NOT_FOUND', 'Non-existent request ID fails closed');

-- 7. In-flight race safeguard: verify updated_at trigger updates timestamp on setting modification
DO $$
DECLARE
  v_before timestamptz;
  v_after timestamptz;
BEGIN
  SELECT updated_at INTO v_before FROM public.app_system_settings WHERE setting_key = 'moderation_google_cloud_enabled';
  PERFORM pg_sleep(0.01);
  UPDATE public.app_system_settings SET setting_value = 'false' WHERE setting_key = 'moderation_google_cloud_enabled';
  SELECT updated_at INTO v_after FROM public.app_system_settings WHERE setting_key = 'moderation_google_cloud_enabled';

  IF v_after <= v_before THEN
    RAISE EXCEPTION 'TRIGGER_DID_NOT_UPDATE_TIMESTAMP';
  END IF;
END;
$$;
SELECT pass('app_system_settings update trigger accurately updates updated_at timestamp on toggle');

-- 8. Finalizer verifies implementation contains all 4 mode policies and in-flight switch guard
-- Uses LIMIT 1 on pg_proc inspect queries to prevent multiple test rows if wrapper and inner functions are present
SELECT ok(
  p.prosrc LIKE '%india_baseline_v1.0.0%'
  AND p.prosrc LIKE '%india_azure_v1.0.0%'
  AND p.prosrc LIKE '%india_google_v1.0.0%'
  AND p.prosrc LIKE '%india_dual_cloud_v1.0.0%',
  'finalizer source recognizes all four moderation policy identifiers'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security'
  AND p.proname IN ('impl_finalize_moderation_result', 'impl_finalize_moderation_result_azure_v1')
  AND p.prosrc LIKE '%v_google_active%'
LIMIT 1;

SELECT ok(
  p.prosrc LIKE '%updated_at > v_req.claimed_at%',
  'finalizer source enforces in-flight setting modification race guard'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security'
  AND p.proname IN ('impl_finalize_moderation_result', 'impl_finalize_moderation_result_azure_v1')
  AND p.prosrc LIKE '%v_google_active%'
LIMIT 1;

SELECT ok(
  p.prosrc LIKE '%v_azure_active OR v_google_active%',
  'finalizer source enforces mode consistency against live database settings'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security'
  AND p.proname IN ('impl_finalize_moderation_result', 'impl_finalize_moderation_result_azure_v1')
  AND p.prosrc LIKE '%v_google_active%'
LIMIT 1;

SELECT ok(
  p.prosrc LIKE '%ZERO_MEDIA%' OR p.prosrc LIKE '%v_media_count < 1%',
  'finalizer source mandates at least 1 photo for multimodal policies'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security'
  AND p.proname IN ('impl_finalize_moderation_result', 'impl_finalize_moderation_result_azure_v1')
  AND p.prosrc LIKE '%v_google_active%'
LIMIT 1;

SELECT ok(
  p.prosrc LIKE '%FOR SHARE%',
  'finalizer source takes FOR SHARE lock on settings rows during finalization'
)
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'app_security'
  AND p.proname IN ('impl_finalize_moderation_result', 'impl_finalize_moderation_result_azure_v1')
  AND p.prosrc LIKE '%v_google_active%'
LIMIT 1;

SELECT * FROM finish();
ROLLBACK;
