-- FAIRSWAP PRODUCTION MODERATION V2 PHASE-1 PREFLIGHT (READ-ONLY, NO DDL/DML)
-- Validates target environment matches exact Production-52 baseline before applying V2 foundation.
-- Hard-stop on any version drift, ledger deviation, existing V2 structures, or modified V1 rules.
DO $fairswap_v2_preflight$
DECLARE
  expected_versions text[] := ARRAY[
      '20260914000001',
      '20260914000002',
      '20260914000003',
      '20260914000004',
      '20260914000005',
      '20260914000006',
      '20260914000007',
      '20260914000008',
      '20260914000009',
      '20260914000010',
      '20260914000011',
      '20260914000012',
      '20260914000013',
      '20260914000014',
      '20260914000015',
      '20260914000016',
      '20260914000017',
      '20260916000018',
      '20260916000019',
      '20260918000020',
      '20260918000021',
      '20260926000022',
      '20260926000023',
      '20260926000024',
      '20260929000025',
      '20260930000026',
      '20260930000027',
      '20260930000028',
      '20261001000029',
      '20261001000030',
      '20261001000031',
      '20261001000032',
      '20261002000033',
      '20261007153735',
      '20261007153744',
      '20261007161425',
      '20261008210921',
      '20261009163210',
      '20261010071050',
      '20261010080000',
      '20261010090000',
      '20261011000038',
      '20261011000039',
      '20261013192336',
      '20261013235311',
      '20261017205755',
      '20261017205757',
      '20261017205759',
      '20261017205801',
      '20261017205803',
      '20261017205805',
      '20261017205807'
    ]::text[];
BEGIN
  -- 1. PostgreSQL Version Verification (17.x)
  IF current_setting('server_version') NOT LIKE '17.%' THEN
    RAISE EXCEPTION 'STOP: unexpected PostgreSQL version %, expected 17.x', current_setting('server_version');
  END IF;

  -- 2. Exact 52 Migration Ledger Match
  IF (SELECT coalesce(array_agg(version ORDER BY version), ARRAY[]::text[])
      FROM supabase_migrations.schema_migrations) IS DISTINCT FROM expected_versions THEN
    RAISE EXCEPTION 'STOP: Production migration ledger differs from approved 52-version snapshot';
  END IF;

  -- 3. Verify V2 Schema Is Pristine (Not Already Installed)
  IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'app_moderation_v2') THEN
    RAISE EXCEPTION 'STOP: app_moderation_v2 schema already exists; do not replay foundation';
  END IF;

  IF EXISTS(SELECT 1 FROM public.app_system_settings WHERE setting_key IN ('moderation_v2_enabled', 'moderation_v2_mode')) THEN
    RAISE EXCEPTION 'STOP: moderation_v2 system settings already exist';
  END IF;

  -- 4. Verify V1 Baseline Invariants
  -- Accepts either initial migration state ('false') or hosted active configuration ('true')
  IF (SELECT setting_value FROM public.app_system_settings
      WHERE setting_key='moderation_automation_enabled') NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'STOP: Production Goods moderation switch is corrupted or uninitialized';
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
       'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'))
       IS DISTINCT FROM '118d04445fdd9139d90decd2048945f1' THEN
    RAISE EXCEPTION 'STOP: Production Goods finalizer changed';
  END IF;

  -- Verify V1 Goods enqueue trigger is active ('O')
  IF (SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.listings'::regclass AND tgname='trg_listing_moderation_enqueue') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'STOP: Goods moderation enqueue trigger is not enabled (O)';
  END IF;

  -- 5. Finalizer privilege boundary check
  IF has_function_privilege('anon',
      'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
      'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP: finalizer privilege boundary changed';
  END IF;

  -- 6. Verify required storage schema operation function is present
  IF to_regprocedure('storage.allow_only_operation(text)') IS NULL THEN
    RAISE EXCEPTION 'STOP: required platform storage helper storage.allow_only_operation(text) is missing';
  END IF;

  RAISE NOTICE 'PASS: FairSwap Production 52-migration baseline verified for V2 foundation';
END;
$fairswap_v2_preflight$;
