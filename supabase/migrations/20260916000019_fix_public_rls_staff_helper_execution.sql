-- Migration 19: 20260916000019_fix_public_rls_staff_helper_execution.sql
-- Grant EXECUTE on app_security.is_active_staff_aal2 to anon solely so anon can evaluate RLS expressions on public tables.
-- The function remains strictly internal to the app_security schema (not exposed via PostgREST).

GRANT EXECUTE ON FUNCTION app_security.is_active_staff_aal2(public.staff_role_enum) TO anon;
