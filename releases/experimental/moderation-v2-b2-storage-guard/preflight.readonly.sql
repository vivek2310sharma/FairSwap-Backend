-- FairSwap B2 experimental Storage guard: HOSTED READ-ONLY preflight.
-- Does NOT authorize executing guard.candidate.sql. Read-only transactional check.
-- Requires a connected Production-authorized SQL session with the release owner.
BEGIN TRANSACTION READ ONLY;

DO $fairswap_b2_preflight$
DECLARE
  v_ledger_count integer;
  v_v1_switch text;
  v_v2_enabled text;
  v_v2_mode text;
  v_owner text;
  v_can_trigger boolean;
  v_custom_trigger_count integer;
  v_guard_count integer;
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'B2 PREFLIGHT BLOCKED: storage.objects is missing';
  END IF;

  SELECT count(*)::integer INTO v_ledger_count FROM supabase_migrations.schema_migrations;
  IF v_ledger_count <> 55 THEN
    RAISE EXCEPTION 'B2 PREFLIGHT BLOCKED: expected 55 applied migrations, observed %', v_ledger_count;
  END IF;

  SELECT setting_value INTO v_v1_switch FROM public.app_system_settings
  WHERE setting_key = 'moderation_automation_enabled';
  SELECT setting_value INTO v_v2_enabled FROM public.app_system_settings
  WHERE setting_key = 'moderation_v2_enabled';
  SELECT setting_value INTO v_v2_mode FROM public.app_system_settings
  WHERE setting_key = 'moderation_v2_mode';

  IF v_v1_switch IS DISTINCT FROM 'true'
    OR v_v2_enabled IS DISTINCT FROM 'false'
    OR v_v2_mode IS DISTINCT FROM 'disabled' THEN
    RAISE EXCEPTION 'B2 PREFLIGHT BLOCKED: existing moderation switches do not match default-off baseline';
  END IF;

  SELECT pg_get_userbyid(c.relowner) INTO v_owner
  FROM pg_class AS c WHERE c.oid = 'storage.objects'::regclass;
  SELECT has_table_privilege(current_user, 'storage.objects', 'TRIGGER')
    INTO v_can_trigger;

  SELECT count(*)::integer INTO v_custom_trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'storage.objects'::regclass AND NOT tgisinternal;

  SELECT count(*)::integer INTO v_guard_count
  FROM pg_trigger
  WHERE tgrelid = 'storage.objects'::regclass
    AND tgname = 'trg_fairswap_v2_sealed_storage_immutable';

  IF v_guard_count <> 0 THEN
    RAISE EXCEPTION 'B2 PREFLIGHT BLOCKED: experimental guard already exists; inspect its provenance';
  END IF;

  IF NOT v_can_trigger THEN
    RAISE EXCEPTION 'B2 PREFLIGHT BLOCKED: current operator lacks TRIGGER privilege on managed Storage metadata';
  END IF;

  RAISE NOTICE 'PASS: B2 read-only catalog preflight; ledger=%, V1=%, V2 disabled; Storage owner=%, existing non-system triggers=%, operator trigger grant=%, no B2 guard installed',
    v_ledger_count, v_v1_switch, v_owner, v_custom_trigger_count, v_can_trigger;
  RAISE NOTICE 'REMINDER: passing metadata/privilege checks is NOT Storage vendor compatibility, write-proxy, S3/TUS, retirement or deployment approval';
END;
$fairswap_b2_preflight$;

ROLLBACK;
