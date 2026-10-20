-- FAIRSWAP PRODUCTION MODERATION V2 PHASE-1 POSTFLIGHT (READ-ONLY, NO DDL/DML)
-- Validates target environment state immediately following application of the 3 V2 forward migrations.
-- Verifies exact ledger count (55), RLS on all 5 app_moderation_v2 tables, deny on anon/auth for all routines,
-- disabled gates, unapproved policy registry, and unchanged V1 functions/triggers/switches.
DO $fairswap_v2_postflight$
DECLARE
  v2_tables text[] := ARRAY[
    'policy_registry',
    'requests',
    'input_admission_slots',
    'input_claims',
    'input_results'
  ];
  tbl text;
  fun record;
  pub_fn text;
  v1_switch_val text;
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

  -- 3. Verify all routines in app_moderation_v2 deny anon & authenticated
  FOR fun IN
    SELECT p.oid, p.proname
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_moderation_v2'
  LOOP
    IF has_function_privilege('anon', fun.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', fun.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'STOP: anon or authenticated has EXECUTE privilege on app_moderation_v2.%', fun.proname;
    END IF;
  END LOOP;

  -- 4. Verify public V2 wrapper RPCs deny anon & authenticated and allow service_role
  FOREACH pub_fn IN ARRAY ARRAY['claim_moderation_v2_input', 'heartbeat_moderation_v2_input', 'finalize_moderation_v2_input'] LOOP
    IF EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = pub_fn
      AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) THEN
      RAISE EXCEPTION 'STOP: anon or authenticated has EXECUTE privilege on public.%', pub_fn;
    END IF;
    IF NOT EXISTS(
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = pub_fn
      AND has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) THEN
      RAISE EXCEPTION 'STOP: service_role lacks EXECUTE privilege on public.%', pub_fn;
    END IF;
  END LOOP;

  -- 5. Verify System Settings: V2 Disabled
  IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_v2_enabled') IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'STOP: moderation_v2_enabled is NOT false';
  END IF;

  IF (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_v2_mode') IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'STOP: moderation_v2_mode is NOT disabled';
  END IF;

  -- 6. Verify Policy Registry: 0 Approved Builds
  IF (SELECT count(*) FROM app_moderation_v2.policy_registry WHERE is_approved = true) <> 0 THEN
    RAISE EXCEPTION 'STOP: policy_registry has approved policies';
  END IF;

  -- 7. Verify Admission Slots: exactly 2 pre-allocated slots created; initial state empty
  IF (SELECT count(*) FROM app_moderation_v2.input_admission_slots) <> 2 THEN
    RAISE EXCEPTION 'STOP: expected 2 pre-allocated admission slots, found %', (SELECT count(*) FROM app_moderation_v2.input_admission_slots);
  END IF;

  IF (SELECT count(*) FROM app_moderation_v2.input_admission_slots WHERE active_claim_id IS NOT NULL) <> 0 THEN
    RAISE EXCEPTION 'STOP: admission slots are unexpectedly active';
  END IF;

  -- 8. Verify V1 Baseline Invariants Remain Unchanged
  SELECT setting_value INTO v1_switch_val
  FROM public.app_system_settings
  WHERE setting_key = 'moderation_automation_enabled';

  IF v1_switch_val IS NULL OR v1_switch_val NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'STOP: Production Goods moderation switch moderation_automation_enabled corrupted or missing: %', v1_switch_val;
  END IF;

  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure(
       'app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'))
       IS DISTINCT FROM '118d04445fdd9139d90decd2048945f1' THEN
    RAISE EXCEPTION 'STOP: Goods finalizer unexpectedly changed';
  END IF;

  IF (SELECT tgenabled FROM pg_trigger
      WHERE tgrelid='public.listings'::regclass AND tgname='trg_listing_moderation_enqueue') IS DISTINCT FROM 'O' THEN
    RAISE EXCEPTION 'STOP: Goods moderation enqueue trigger unexpectedly changed';
  END IF;

  RAISE NOTICE 'PASS: All postflight checks passed. V2 foundation successfully verified in default-off state (V1 moderation_automation_enabled=%).', v1_switch_val;
END;
$fairswap_v2_postflight$;
