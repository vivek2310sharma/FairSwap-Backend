-- Read-only, isolated local-only V2 forward checks. Never run against hosted projects.
DO $fairswap_ci_v2$
DECLARE
  rel record;
  fun record;
BEGIN
  IF to_regnamespace('app_moderation_v2') IS NULL THEN
    RAISE EXCEPTION 'V2 private schema is missing';
  END IF;
  IF to_regclass('app_moderation_v2.policy_registry') IS NULL
     OR to_regclass('app_moderation_v2.requests') IS NULL THEN
    RAISE EXCEPTION 'V2 policy registry/request foundation is incomplete';
  END IF;
  IF has_schema_privilege('anon','app_moderation_v2','USAGE')
     OR has_schema_privilege('authenticated','app_moderation_v2','USAGE') THEN
    RAISE EXCEPTION 'V2 schema exposed to client roles';
  END IF;
  FOR rel IN
    SELECT c.oid, c.relname, c.relrowsecurity
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'app_moderation_v2' AND c.relkind = 'r'
  LOOP
    IF NOT rel.relrowsecurity THEN
      RAISE EXCEPTION 'V2 table without RLS';
    END IF;
    IF has_table_privilege('anon', rel.oid, 'SELECT')
       OR has_table_privilege('anon', rel.oid, 'INSERT')
       OR has_table_privilege('anon', rel.oid, 'UPDATE')
       OR has_table_privilege('anon', rel.oid, 'DELETE')
       OR has_table_privilege('authenticated', rel.oid, 'SELECT')
       OR has_table_privilege('authenticated', rel.oid, 'INSERT')
       OR has_table_privilege('authenticated', rel.oid, 'UPDATE')
       OR has_table_privilege('authenticated', rel.oid, 'DELETE') THEN
      RAISE EXCEPTION 'V2 private table accessible to clients';
    END IF;
  END LOOP;
  FOR fun IN
    SELECT p.oid
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'app_moderation_v2'
  LOOP
    IF has_function_privilege('anon', fun.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', fun.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'V2 private routine executable by clients';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.app_system_settings
    WHERE setting_key = 'moderation_v2_enabled'
      AND setting_value <> 'false'
  ) OR EXISTS (
    SELECT 1 FROM public.app_system_settings
    WHERE setting_key = 'moderation_v2_mode'
      AND setting_value <> 'disabled'
  ) THEN
    RAISE EXCEPTION 'V2 activation gates must remain disabled';
  END IF;
END;
$fairswap_ci_v2$;
