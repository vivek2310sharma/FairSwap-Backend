-- FAIRSWAP PRODUCTION PHASE-1 POSTFLIGHT (READ-ONLY, NO DDL/DML)
-- Run after separately authorized, sequential application of the seven pinned source migrations.
DO $fairswap_postflight$
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations) <> 52 THEN
    RAISE EXCEPTION 'STOP: expected 45 baseline plus 7 reviewed source migrations';
  END IF;
  IF to_regclass('app_security.test_submission_policies') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: Test-only submission policy installed in Production';
  END IF;
  IF to_regclass('public.listing_vehicle_contexts') IS NULL
     OR to_regclass('public.listing_car_contexts') IS NULL
     OR to_regclass('public.listing_property_contexts') IS NULL THEN
    RAISE EXCEPTION 'STOP: missing required category draft context table';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
        WHERE tgrelid='public.listings'::regclass
          AND tgname IN ('z_vehicle_listing_guard','zz_car_listing_guard','zzz_property_listing_guard')
          AND tgenabled='O') <> 3 THEN
    RAISE EXCEPTION 'STOP: one or more experimental listing draft/publication guards are disabled';
  END IF;
  IF EXISTS(SELECT 1 FROM public.categories c
       WHERE c.macro_category::text IN ('vehicles','property')
       AND (c.is_active OR c.new_listing_enabled)) THEN
    RAISE EXCEPTION 'STOP: one or more experimental categories became publicly available';
  END IF;
  IF EXISTS(SELECT 1 FROM public.vehicle_contract_versions WHERE new_assignment_enabled)
     OR EXISTS(SELECT 1 FROM public.car_contract_versions WHERE new_assignment_enabled)
     OR EXISTS(SELECT 1 FROM public.property_contract_versions WHERE new_assignment_enabled) THEN
    RAISE EXCEPTION 'STOP: experimental category draft assignment became available';
  END IF;
  IF EXISTS(SELECT 1 FROM public.listings l JOIN public.categories c ON c.id=l.category_id
      WHERE c.macro_category::text IN ('vehicles','property') AND l.status='active') THEN
    RAISE EXCEPTION 'STOP: experimental listing published';
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
  IF has_table_privilege('anon', 'public.listing_vehicle_contexts', 'SELECT')
     OR has_table_privilege('anon', 'public.listing_car_contexts', 'SELECT')
     OR has_table_privilege('anon', 'public.listing_property_contexts', 'SELECT') THEN
    RAISE EXCEPTION 'STOP: experimental listing contexts readable by anon';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname IN ('listing_vehicle_contexts','listing_car_contexts','listing_property_contexts')
     AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'STOP: missing RLS on new category context tables';
  END IF;
END;
$fairswap_postflight$;
