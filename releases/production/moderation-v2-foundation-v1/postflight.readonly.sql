-- FAIRSWAP PRODUCTION MODERATION V2 PHASE-1 POSTFLIGHT (READ-ONLY, NO DDL/DML)
-- Validates target environment state immediately following application of the 3 V2 forward migrations.
-- Verifies exact ledger count (55), RLS on all 5 tables, deny on anon/auth for all 13 RPCs,
-- disabled gates, unapproved policy registry, and unchanged V1 functions.
DO $fairswap_v2_postflight$
DECLARE
  v2_tables text[] := ARRAY[
    'admission_control',
    'evaluation_attempts',
    'input_claim_leases',
    'listing_moderation_snapshots',
    'policy_registry'
  ];
  tbl text;
  v2_funcs text[] := ARRAY[
    'acquire_input_claim_lease',
    'claim_admission_slot',
    'complete_evaluation_attempt',
    'heartbeat_input_claim_lease',
    'mark_claim_lease_attempt',
    'recover_expired_claim_leases',
    'register_evaluation_attempt',
    'release_admission_slot',
    'release_input_claim_lease',
    'resolve_active_claim_lease',
    'resolve_active_policy',
    'seal_moderation_snapshot',
    'validate_listing_inputs'
  ];
  fn text;
BEGIN
  -- 1. Migration Ledger Count (52 baseline + 3 forward = 55)
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> 55 THEN
    RAISE EXCEPTION 'STOP: expected exactly 55 migrations, found %', (SELECT count(*) FROM supabase_migrations.schema_migrations);
  END IF;

  -- 2. Verify all 5 app_moderation_v2 tables exist and have RLS enabled
  FOREACH tbl IN ARRAY v2_tables LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname = 'app_moderation_v2' AND tablename = tbl) THEN
      RAISE EXCEPTION 'STOP: missing required V2 table app_moderation_v2.%', tbl;
    END IF;
    IF NOT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname = 'app_moderation_v2' AND tablename = tbl AND rowsecurity = true) THEN
      RAISE EXCEPTION 'STOP: RLS is NOT enabled on app_moderation_v2.%', tbl;
    END IF;
  END LOOP;

  -- 3. Verify all 13 app_moderation_v2 RPCs deny anon & authenticated and allow service_role
  FOREACH fn IN ARRAY v2_funcs LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app_moderation_v2' AND p.proname = fn) THEN
      RAISE EXCEPTION 'STOP: missing required V2 function app_moderation_v2.%', fn;
    END IF;
    IF EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_moderation_v2' AND p.proname = fn
      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) THEN
      RAISE EXCEPTION 'STOP: anon or authenticated has EXECUTE privilege on app_moderation_v2.%', fn;
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'app_moderation_v2' AND p.proname = fn
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'STOP: service_role lacks EXECUTE privilege on app_moderation_v2.%', fn;
    END IF;
  END LOOP;

  -- 4. Verify System Settings: V2 Disabled
  IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_v2_enabled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'STOP: moderation_v2_enabled is NOT false';
  END IF;

  IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_v2_mode') IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'STOP: moderation_v2_mode is NOT disabled';
  END IF;

  IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'STOP: moderation_automation_enabled differs from default-off baseline';
  END IF;

  -- 5. Verify Policy Registry: 0 Approved Builds
  IF (SELECT count(*) FROM app_moderation_v2.policy_registry WHERE is_approved = true) <> 0 THEN
    RAISE EXCEPTION 'STOP: policy_registry has approved policies';
  END IF;

  -- 6. Verify Admission Slots: exactly 2 pre-allocated slots created; initial state empty
  IF (SELECT count(*) FROM app_moderation_v2.admission_control) <> 2 THEN
    RAISE EXCEPTION 'STOP: expected 2 pre-allocated admission slots, found %', (SELECT count(*) FROM app_moderation_v2.admission_control);
  END IF;

  IF (SELECT count(*) FROM app_moderation_v2.admission_control WHERE is_active = true) <> 0 THEN
    RAISE EXCEPTION 'STOP: admission slots are unexpectedly active';
  END IF;

  -- 7. Verify V1 Functions & Enqueue Triggers Remain Unchanged
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
       'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'))
       IS DISTINCT FROM '118d04445fdd9139d90decd2048945f1' THEN
    RAISE EXCEPTION 'STOP: Goods finalizer unexpectedly changed';
  END IF;

  IF (SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='public.listings'::regclass AND tgname='trg_listing_moderation_enqueue') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'STOP: Goods moderation enqueue trigger unexpectedly changed';
  END IF;

  RAISE NOTICE 'PASS: All postflight checks passed. V2 foundation successfully verified in default-off state.';
END;
$fairswap_v2_postflight$;
