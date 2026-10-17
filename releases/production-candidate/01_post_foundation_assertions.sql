-- Read-only contract for a FUTURE cold foundation, never a migration.
-- This is not executable against today's 45-migration Production baseline.
WITH family_rows AS (
 SELECT macro_category,
  count(*) AS count,
  count(*) FILTER(WHERE is_active OR new_listing_enabled) AS opened
 FROM public.categories WHERE macro_category IN ('vehicles','property')
 GROUP BY macro_category
), versions AS (
 SELECT
   (SELECT count(*) FROM public.vehicle_contract_versions WHERE new_assignment_enabled) AS vehicles_open,
   (SELECT count(*) FROM public.car_contract_versions WHERE new_assignment_enabled) AS cars_open,
   (SELECT count(*) FROM public.property_contract_versions WHERE new_assignment_enabled) AS property_open
)
SELECT jsonb_build_object(
 'new_category_rows',(SELECT jsonb_agg(to_jsonb(family_rows)) FROM family_rows),
 'all_new_category_rows_closed',(SELECT count(*)=0 FROM public.categories WHERE macro_category IN ('vehicles','property') AND (is_active OR new_listing_enabled)),
 'all_contracts_closed',(SELECT vehicles_open=0 AND cars_open=0 AND property_open=0 FROM versions),
 'test_submission_policy_absent',to_regclass('app_security.test_submission_policies') IS NULL,
 'pending_experimental_listings',(SELECT count(*) FROM public.listings l JOIN public.categories c ON c.id=l.category_id WHERE c.macro_category IN ('vehicles','property') AND l.status='pending_review'),
 'active_experimental_listings',(SELECT count(*) FROM public.listings l JOIN public.categories c ON c.id=l.category_id WHERE c.macro_category IN ('vehicles','property') AND l.status='active'),
 'guard_status',(SELECT jsonb_object_agg(tgname,tgenabled::text) FROM pg_trigger WHERE tgrelid='public.listings'::regclass AND tgname IN ('z_vehicle_listing_guard','zz_car_listing_guard','zzz_property_listing_guard')),
 'goods_moderation_trigger',(SELECT tgenabled::text FROM pg_trigger WHERE tgrelid='public.listings'::regclass AND tgname='trg_listing_moderation_enqueue'),
 'release_mode','schema_only__no_public_draft_or_submission'
) AS result;
