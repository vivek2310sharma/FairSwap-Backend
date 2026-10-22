-- FairSwapProd Vehicles + Property: database-only READY CHECK (READ ONLY).
-- This query must FAIL before the reviewed release. Passing is necessary,
-- NEVER sufficient: signed-in E2E, staff review, security negatives,
-- source SHA and recovery evidence remain mandatory separate gates.
BEGIN TRANSACTION READ ONLY;
DO $readiness$
DECLARE
  active_vehicles integer;
  active_property integer;
  assignment_count integer;
  functions_ok boolean;
  guard_count integer;
  visible_bad integer;
BEGIN
  SELECT count(*) FILTER (WHERE macro_category='vehicles'
                           AND is_active AND new_listing_enabled),
         count(*) FILTER (WHERE macro_category='property'
                           AND is_active AND new_listing_enabled)
  INTO active_vehicles,active_property
  FROM public.categories WHERE macro_category IN ('vehicles','property');
  IF active_vehicles <> 18 OR active_property <> 10 THEN
    RAISE EXCEPTION 'NO-GO: 18 Vehicle + 10 Property categories not fully enabled (%,%)',
      active_vehicles,active_property;
  END IF;
  SELECT
      (SELECT count(*) FROM public.vehicle_contract_versions
        WHERE contract_key='two-wheeler-draft-v1' AND new_assignment_enabled)
    + (SELECT count(*) FROM public.car_contract_versions
        WHERE contract_key='cars-draft-v1' AND new_assignment_enabled)
    + (SELECT count(*) FROM public.property_contract_versions
        WHERE contract_key='property-rental-draft-v1' AND new_assignment_enabled)
  INTO assignment_count;
  IF assignment_count <> 3 THEN
    RAISE EXCEPTION 'NO-GO: family contract assignment not enabled for each approved version';
  END IF;
  -- Required implementation contract for the follow-up reviewed backend
  -- migration. A signature alone does not prove its RLS/authorization safety.
  functions_ok := to_regprocedure('public.seller_submit_family_listing(uuid,integer)') IS NOT NULL
     AND to_regprocedure('public.moderate_listing_reviewed(uuid,text,text,integer,public.listing_status_enum)') IS NOT NULL;
  IF NOT functions_ok THEN
    RAISE EXCEPTION 'NO-GO: production family submission/review RPC contract missing';
  END IF;
  SELECT count(*) INTO guard_count
    FROM pg_trigger WHERE tgrelid='public.listings'::regclass
      AND tgname IN ('z_vehicle_listing_guard','zz_car_listing_guard','zzz_property_listing_guard')
      AND tgenabled='O';
  IF guard_count <> 3 THEN
    RAISE EXCEPTION 'NO-GO: family listing guards must remain enabled';
  END IF;
  IF has_table_privilege('anon','public.listing_property_contexts','SELECT')
     OR has_table_privilege('anon','public.listing_vehicle_contexts','SELECT')
     OR has_table_privilege('anon','public.listing_car_contexts','SELECT') THEN
    RAISE EXCEPTION 'NO-GO: private context grants exposed to anon';
  END IF;
  SELECT count(*) INTO visible_bad FROM public.listings l
    JOIN public.categories c ON c.id=l.category_id
    WHERE c.macro_category='property'
      AND l.status='active'
      AND (l.condition IS NOT NULL OR l.price_type IS NOT NULL OR l.price_paise IS NOT NULL);
  IF visible_bad <> 0 THEN
    RAISE EXCEPTION 'NO-GO: published Property listing using invalid Goods pricing';
  END IF;
  RAISE NOTICE 'PASS: DATABASE PREREQUISITES ONLY. NOT a production go-live or security certification.';
END
$readiness$;
COMMIT;
