BEGIN;
SELECT plan(28);

-- 1. Verify required tables exist in public schema
SELECT has_table('public', 'categories', 'Table public.categories exists');
SELECT has_table('public', 'category_attributes', 'Table public.category_attributes exists');
SELECT has_table('public', 'cities', 'Table public.cities exists');
SELECT has_table('public', 'localities', 'Table public.localities exists');
SELECT has_table('public', 'listings', 'Table public.listings exists');
SELECT has_table('public', 'listing_media', 'Table public.listing_media exists');
SELECT has_table('public', 'listing_status_transitions', 'Table public.listing_status_transitions exists');

-- 2. Verify custom enums exist
SELECT has_type('public', 'listing_status_enum', 'Enum listing_status_enum exists');
SELECT has_type('public', 'listing_condition_enum', 'Enum listing_condition_enum exists');
SELECT has_type('public', 'listing_price_type_enum', 'Enum listing_price_type_enum exists');
SELECT has_type('public', 'attribute_value_type_enum', 'Enum attribute_value_type_enum exists');
SELECT has_type('public', 'media_processing_status_enum', 'Enum media_processing_status_enum exists');
SELECT has_type('public', 'transition_actor_kind_enum', 'Enum transition_actor_kind_enum exists');

-- 3. Verify public RPCs exist
SELECT has_function('public', 'seller_submit_listing', ARRAY['uuid'], 'public.seller_submit_listing exists');
SELECT has_function('public', 'seller_transition_listing', ARRAY['uuid', 'text'], 'public.seller_transition_listing exists');
SELECT has_function('public', 'moderate_listing', ARRAY['uuid', 'text', 'text'], 'public.moderate_listing exists');
SELECT has_function('public', 'record_media_processing_result', ARRAY['uuid', 'jsonb', 'jsonb', 'text', 'text'], 'public.record_media_processing_result exists');
SELECT has_function('public', 'expire_listing', ARRAY['uuid'], 'public.expire_listing exists');
SELECT has_function('public', 'delete_listing_media_internal', ARRAY['uuid', 'uuid'], 'public.delete_listing_media_internal exists');
SELECT has_function('public', 'admin_manage_category', ARRAY['text', 'uuid', 'text', 'text', 'text', 'text', 'integer', 'boolean'], 'public.admin_manage_category exists');
SELECT has_function('public', 'admin_manage_location', ARRAY['text', 'uuid', 'uuid', 'text', 'text', 'text', 'boolean'], 'public.admin_manage_location exists');
SELECT has_function('app_security', 'is_listing_publicly_visible', ARRAY['uuid'], 'app_security.is_listing_publicly_visible exists');

-- 4. Verify service-role-only execution privileges on sensitive RPCs
SELECT function_privs_are('public', 'record_media_processing_result', ARRAY['uuid', 'jsonb', 'jsonb', 'text', 'text'], 'anon', ARRAY[]::text[], 'anon cannot execute record_media_processing_result');
SELECT function_privs_are('public', 'record_media_processing_result', ARRAY['uuid', 'jsonb', 'jsonb', 'text', 'text'], 'authenticated', ARRAY[]::text[], 'authenticated cannot execute record_media_processing_result');
SELECT function_privs_are('public', 'expire_listing', ARRAY['uuid'], 'anon', ARRAY[]::text[], 'anon cannot execute expire_listing');
SELECT function_privs_are('public', 'expire_listing', ARRAY['uuid'], 'authenticated', ARRAY[]::text[], 'authenticated cannot execute expire_listing');
SELECT function_privs_are('public', 'delete_listing_media_internal', ARRAY['uuid', 'uuid'], 'authenticated', ARRAY[]::text[], 'authenticated cannot execute delete_listing_media_internal');

-- 5. Verify RLS is enabled on all listings tables
SELECT results_eq(
  $$ SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('categories', 'category_attributes', 'cities', 'localities', 'listings', 'listing_media', 'listing_status_transitions') AND c.relrowsecurity = true $$,
  $$ VALUES (7) $$,
  'RLS is enabled on all 7 listings-domain public tables'
);

SELECT * FROM finish();
ROLLBACK;
