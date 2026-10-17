-- FAIRSWAP PRODUCTION PHASE-1 PREFLIGHT (READ-ONLY, NO DDL/DML)
-- Do not execute until operator independently verifies the target project and approves the release.
-- Hard-stop on any source-schema drift from the observed 45-migration Production baseline.
DO $fairswap_preflight$
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
      '20261013235311'
    ]::text[];
BEGIN
  IF current_setting('server_version') NOT LIKE '17.6%' THEN
    RAISE EXCEPTION 'STOP: unexpected PostgreSQL version';
  END IF;
  IF (SELECT coalesce(array_agg(version ORDER BY version), ARRAY[]::text[])
      FROM supabase_migrations.schema_migrations) IS DISTINCT FROM expected_versions THEN
    RAISE EXCEPTION 'STOP: Production migration ledger differs from approved 45-version snapshot';
  END IF;
  IF (SELECT count(*) FROM public.categories WHERE macro_category::text IN ('vehicles','property')) <> 0 THEN
    RAISE EXCEPTION 'STOP: experimental category family already exists in target';
  END IF;
  IF to_regclass('public.listing_vehicle_contexts') IS NOT NULL
     OR to_regclass('public.listing_car_contexts') IS NOT NULL
     OR to_regclass('public.listing_property_contexts') IS NOT NULL
     OR to_regclass('app_security.test_submission_policies') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: category tables already installed; do not replay foundation';
  END IF;
  IF (SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='public.listings'::regclass AND tgname='trg_listing_moderation_enqueue') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'STOP: existing Goods moderation enqueue trigger is not enabled';
  END IF;
  IF (SELECT setting_value FROM public.app_system_settings
      WHERE setting_key='moderation_automation_enabled') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'STOP: Production Goods moderation switch differs from recorded baseline';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
       'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'))
       IS DISTINCT FROM '118d04445fdd9139d90decd2048945f1' THEN
    RAISE EXCEPTION 'STOP: Production Goods finalizer changed';
  END IF;
  IF has_function_privilege('anon',
      'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated',
      'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
      'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'STOP: finalizer privilege boundary changed';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM vault.decrypted_secrets
      WHERE name='moderation_worker_url'
        AND decrypted_secret='https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/process-listing-moderation') THEN
    RAISE EXCEPTION 'STOP: worker URL does not identify the approved Production project';
  END IF;
END;
$fairswap_preflight$;
