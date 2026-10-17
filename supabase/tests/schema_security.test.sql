BEGIN;
SELECT plan(22);

-- 1. Verify required tables exist in public schema
SELECT has_table('public', 'user_accounts', 'Table public.user_accounts exists');
SELECT has_table('public', 'profiles', 'Table public.profiles exists');
SELECT has_table('public', 'staff_roles', 'Table public.staff_roles exists');
SELECT has_table('public', 'audit_logs', 'Table public.audit_logs exists');
SELECT has_table('public', 'privacy_requests', 'Table public.privacy_requests exists');

-- 2. Verify private schema app_security exists
SELECT has_schema('app_security', 'Schema app_security exists');

-- 3. Verify custom enums exist
SELECT has_type('public', 'account_status_enum', 'Enum account_status_enum exists');
SELECT has_type('public', 'staff_role_enum', 'Enum staff_role_enum exists');
SELECT has_type('public', 'privacy_request_type_enum', 'Enum privacy_request_type_enum exists');
SELECT has_type('public', 'privacy_request_status_enum', 'Enum privacy_request_status_enum exists');

-- 4. Verify public administrative RPC functions exist
SELECT has_function('public', 'admin_update_user_account_status', ARRAY['uuid', 'public.account_status_enum', 'text'], 'public.admin_update_user_account_status exists');
SELECT has_function('public', 'admin_assign_staff_role', ARRAY['uuid', 'public.staff_role_enum'], 'public.admin_assign_staff_role exists');
SELECT has_function('public', 'admin_revoke_staff_role', ARRAY['uuid'], 'public.admin_revoke_staff_role exists');
SELECT has_function('public', 'admin_resolve_privacy_request', ARRAY['uuid', 'public.privacy_request_status_enum', 'text'], 'public.admin_resolve_privacy_request exists');

-- 5. Verify security definer helpers exist
SELECT has_function('app_security', 'log_audit_event', ARRAY['text', 'text', 'uuid', 'jsonb'], 'app_security.log_audit_event exists');
SELECT has_function('app_security', 'is_active_staff_aal2', ARRAY['public.staff_role_enum'], 'app_security.is_active_staff_aal2 exists');
SELECT has_function('app_security', 'get_my_staff_role', ARRAY[]::text[], 'app_security.get_my_staff_role exists');

-- 6. Verify routine ACLs: log_audit_event must NOT be executable by anon, authenticated, or public
SELECT function_privs_are('app_security', 'log_audit_event', ARRAY['text', 'text', 'uuid', 'jsonb'], 'anon', ARRAY[]::text[], 'anon has no execute privilege on log_audit_event');
SELECT function_privs_are('app_security', 'log_audit_event', ARRAY['text', 'text', 'uuid', 'jsonb'], 'authenticated', ARRAY[]::text[], 'authenticated has no execute privilege on log_audit_event');
SELECT function_privs_are('app_security', 'log_audit_event', ARRAY['text', 'text', 'uuid', 'jsonb'], 'public', ARRAY[]::text[], 'public has no execute privilege on log_audit_event');

-- 7. Verify RLS is enabled on all tables
SELECT results_eq(
  $$ SELECT count(*)::integer FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('user_accounts', 'profiles', 'staff_roles', 'audit_logs', 'privacy_requests') AND c.relrowsecurity = true $$,
  $$ VALUES (5) $$,
  'RLS is enabled on all 5 public domain tables'
);

-- 8. Verify unique pending privacy request index exists
SELECT has_index('public', 'privacy_requests', 'idx_unique_pending_privacy_request', ARRAY['user_id', 'request_type'], 'Index idx_unique_pending_privacy_request exists');

SELECT * FROM finish();
ROLLBACK;
