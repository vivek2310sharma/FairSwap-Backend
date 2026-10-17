-- Read-only inspection only. No DDL, DML, migrations, or auth changes.
-- Target only: FairSwapProd kriuhwppxgxsyyrbjsau.
WITH selected_relation(rel) AS (
 VALUES ('public.vehicle_contract_versions'),('public.car_contract_versions'),
        ('public.property_contract_versions'),('public.listing_vehicle_contexts'),
        ('public.listing_car_contexts'),('public.listing_property_contexts')
), relation_states AS (
 SELECT jsonb_object_agg(rel,to_regclass(rel) IS NOT NULL) AS exists FROM selected_relation
)
SELECT jsonb_build_object(
  'mode','read_only_production_preflight',
  'postgres',current_setting('server_version'),
  'migration_count',(SELECT count(*) FROM supabase_migrations.schema_migrations),
  'migration_latest',(SELECT max(version) FROM supabase_migrations.schema_migrations),
  'category_families',(SELECT jsonb_object_agg(family,jsonb_build_object('count',n,'assignment_enabled',enabled)) FROM (
     SELECT coalesce(macro_category,'unset') AS family,count(*) AS n,count(*) FILTER(WHERE is_active AND new_listing_enabled) AS enabled
     FROM public.categories GROUP BY 1
  ) c),
  'new_family_schema', (SELECT exists FROM relation_states),
  'new_family_policy_table',to_regclass('app_security.test_submission_policies')::text,
  'moderation_enqueue_active',(SELECT tgenabled='O' FROM pg_trigger WHERE tgrelid='public.listings'::regclass AND tgname='trg_listing_moderation_enqueue'),
  'mod_automation',(SELECT setting_value FROM public.app_system_settings WHERE setting_key='moderation_automation_enabled'),
  'pending_mod_requests',(SELECT count(*) FROM public.listing_moderation_requests WHERE status IN ('pending','claimed','retry')),
  'listing_rls',(SELECT relrowsecurity FROM pg_class WHERE oid='public.listings'::regclass),
  'baseline_rpc_access',jsonb_build_object(
     'anon',has_function_privilege('anon','public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)','EXECUTE'),
     'authenticated',has_function_privilege('authenticated','public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)','EXECUTE'),
     'service_role',has_function_privilege('service_role','public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)','EXECUTE')
  ),
  'backup_recovery_verified','UNVERIFIED_EXTERNALLY',
  'apply_authorized',false
) AS result;
