-- FairSwapProd Vehicles + Property: BASELINE SECURITY ASSERTIONS (READ ONLY).
-- 2026-10-22. Review in read-only mode; this is NOT an activation or launch signal.
-- Must be executed against project ref kriuhwppxgxsyyrbjsau after independent
-- verification of the connection. Never run from the mixed Test migration tree.
BEGIN TRANSACTION READ ONLY;
DO $baseline$
DECLARE
  missing_versions integer;
  guarded integer;
  category_total integer;
  vehicle_total integer;
  property_total integer;
  assignable integer;
  live_count integer;
  anonymous_readable integer;
  missing_rls integer;
  contract_tw integer;
  contract_cars integer;
  contract_property integer;
BEGIN
  IF current_setting('server_version_num')::integer < 170000 THEN
    RAISE EXCEPTION 'STOP: PostgreSQL 17 required for reviewed baseline';
  END IF;
  SELECT count(*) INTO missing_versions
  FROM (VALUES ('20261017205755'),('20261017205757'),('20261017205759'),
               ('20261017205801'),('20261017205803'),('20261017205805'),
               ('20261017205807')) AS required(version)
  WHERE NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations m
    WHERE m.version = required.version
  );
  IF missing_versions <> 0 THEN
    RAISE EXCEPTION 'STOP: missing % category-foundation migrations', missing_versions;
  END IF;
  SELECT count(*) INTO guarded
  FROM pg_trigger t WHERE t.tgrelid='public.listings'::regclass
    AND t.tgname IN ('z_vehicle_listing_guard',
                     'zz_car_listing_guard',
                     'zzz_property_listing_guard')
    AND t.tgenabled='O';
  IF guarded <> 3 THEN
    RAISE EXCEPTION 'STOP: one or more category draft/publication guards are disabled';
  END IF;
  SELECT count(*),
         count(*) FILTER (WHERE macro_category='vehicles'),
         count(*) FILTER (WHERE macro_category='property'),
         count(*) FILTER (WHERE is_active OR new_listing_enabled)
  INTO category_total,vehicle_total,property_total,assignable
  FROM public.categories
  WHERE macro_category IN ('vehicles','property');
  IF category_total <> 28 OR vehicle_total <> 18 OR property_total <> 10 THEN
    RAISE EXCEPTION 'STOP: category foundation mismatch (total=%, vehicles=%, property=%)',
      category_total, vehicle_total, property_total;
  END IF;
  IF assignable <> 0 THEN
    RAISE EXCEPTION 'STOP: category activated before production lifecycle release (count=%)', assignable;
  END IF;
  SELECT (SELECT count(*) FROM public.vehicle_category_contracts),
         (SELECT count(*) FROM public.car_category_contracts),
         (SELECT count(*) FROM public.property_category_contracts)
  INTO contract_tw,contract_cars,contract_property;
  IF contract_tw <> 9 OR contract_cars <> 9 OR contract_property <> 10 THEN
    RAISE EXCEPTION 'STOP: contract foundation mismatch (two-wheelers=%, cars=%, property=%)',
      contract_tw,contract_cars,contract_property;
  END IF;
  SELECT
    (SELECT count(*) FROM public.vehicle_contract_versions WHERE new_assignment_enabled)
   +(SELECT count(*) FROM public.car_contract_versions WHERE new_assignment_enabled)
   +(SELECT count(*) FROM public.property_contract_versions WHERE new_assignment_enabled)
  INTO assignable;
  IF assignable <> 0 THEN
    RAISE EXCEPTION 'STOP: new contract assignment activated ahead of production review';
  END IF;
  SELECT count(*) INTO live_count FROM public.listings l
    JOIN public.categories c ON c.id=l.category_id
    WHERE c.macro_category IN ('vehicles','property') AND l.status <> 'draft';
  IF live_count <> 0 THEN
    RAISE EXCEPTION 'STOP: experimental family has non-draft listings before lifecycle approval';
  END IF;
  SELECT count(*) INTO missing_rls
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('listing_vehicle_contexts','listing_car_contexts',
                      'listing_property_contexts')
    AND c.relkind='r' AND NOT c.relrowsecurity;
  IF missing_rls <> 0 THEN
    RAISE EXCEPTION 'STOP: family context table missing RLS';
  END IF;
  SELECT
      (has_table_privilege('anon','public.listing_vehicle_contexts','SELECT'))::int
    + (has_table_privilege('anon','public.listing_car_contexts','SELECT'))::int
    + (has_table_privilege('anon','public.listing_property_contexts','SELECT'))::int
    INTO anonymous_readable;
  IF anonymous_readable <> 0 THEN
    RAISE EXCEPTION 'STOP: private family context table grants exposed to anon';
  END IF;
  IF to_regclass('app_security.test_submission_policies') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: Test-only family submission policies installed in Production';
  END IF;
  RAISE NOTICE 'PASS (BASELINE ONLY): 18 Vehicles + 10 Property installed and inactive; 28 contracts mapped; three publication guards enabled; private context RLS/grants intact.';
  RAISE NOTICE 'NOT A LAUNCH APPROVAL: family submission, review, safe public readback and deployment must be tested independently.';
END
$baseline$;
COMMIT;
