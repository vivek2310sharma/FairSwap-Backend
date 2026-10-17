-- Migration 2: 20260914000002_create_staff_and_security.sql
-- Staff Roles, MFA (AAL2) Verification Helpers, and Staff RLS Policies

-- 1. Create staff_role_enum
CREATE TYPE public.staff_role_enum AS ENUM (
  'administrator',
  'moderator',
  'support_agent',
  'content_editor'
);

-- 2. Create public.staff_roles
CREATE TABLE public.staff_roles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.staff_role_enum NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  assigned_by uuid REFERENCES auth.users(id)
);

-- 3. Helper: is_active_staff_aal2 (SECURITY DEFINER, search_path = '')
CREATE OR REPLACE FUNCTION app_security.is_active_staff_aal2(p_required_role public.staff_role_enum)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_user_role public.staff_role_enum;
  v_status public.account_status_enum;
  v_aal text;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- 1. Check account status is active
  SELECT account_status INTO v_status
  FROM public.user_accounts
  WHERE user_id = v_user_id;

  IF v_status IS DISTINCT FROM 'active' THEN
    RETURN false;
  END IF;

  -- 2. Check JWT assurance level claim is aal2
  v_aal := (auth.jwt() ->> 'aal');
  IF v_aal IS DISTINCT FROM 'aal2' THEN
    RETURN false;
  END IF;

  -- 3. Check staff role assignment
  SELECT role INTO v_user_role
  FROM public.staff_roles
  WHERE user_id = v_user_id;

  IF v_user_role IS NULL THEN
    RETURN false;
  END IF;

  -- Administrators satisfy all role requirements
  IF v_user_role = 'administrator' THEN
    RETURN true;
  END IF;

  RETURN v_user_role = p_required_role;
END;
$$;

REVOKE ALL ON FUNCTION app_security.is_active_staff_aal2(public.staff_role_enum) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION app_security.is_active_staff_aal2(public.staff_role_enum) TO authenticated, service_role;

-- 4. Helper: get_my_staff_role (SECURITY DEFINER, search_path = '')
-- Allows authenticated user to inspect own assigned role at AAL1 to prompt MFA without lockout
CREATE OR REPLACE FUNCTION app_security.get_my_staff_role()
RETURNS public.staff_role_enum
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role FROM public.staff_roles WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION app_security.get_my_staff_role() FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION app_security.get_my_staff_role() TO authenticated, service_role;

-- 5. Row Level Security & Policies for staff_roles
ALTER TABLE public.staff_roles ENABLE ROW LEVEL SECURITY;

-- Self can view own role at AAL1; administrator with AAL2 can view all staff roles
CREATE POLICY staff_roles_select_policy ON public.staff_roles
FOR SELECT USING (
  (user_id = auth.uid()) OR (app_security.is_active_staff_aal2('administrator'))
);

-- 6. Additional Staff Policy on public.user_accounts
-- Administrator or Support Agent with AAL2 can view other accounts for support/investigation
CREATE POLICY user_accounts_staff_select_policy ON public.user_accounts
FOR SELECT USING (
  app_security.is_active_staff_aal2('administrator') OR
  app_security.is_active_staff_aal2('support_agent')
);

-- 7. Explicit Data API Grants for staff_roles
REVOKE ALL ON public.staff_roles FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.staff_roles TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_roles TO service_role;
