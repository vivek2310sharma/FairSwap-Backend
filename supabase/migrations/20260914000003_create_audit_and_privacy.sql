-- Migration 3: 20260914000003_create_audit_and_privacy.sql
-- Audit Logs, Privacy Requests, Advisory-Locked Rate Limiting, and Two-Layer RPC Architecture

-- 1. Create enums
CREATE TYPE public.privacy_request_type_enum AS ENUM (
  'export_data',
  'delete_account'
);

CREATE TYPE public.privacy_request_status_enum AS ENUM (
  'pending',
  'in_progress',
  'resolved',
  'rejected'
);

-- 2. Create public.audit_logs
CREATE TABLE public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  target_entity text NOT NULL,
  target_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Append-only table: revoke mutation grants from all application roles
REVOKE ALL ON public.audit_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_logs TO authenticated;
GRANT SELECT, INSERT ON public.audit_logs TO service_role;

-- RLS: Administrator with AAL2 can read audit logs
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_select_policy ON public.audit_logs
FOR SELECT USING (
  app_security.is_active_staff_aal2('administrator')
);

-- 3. Private Helper: log_audit_event (SECURITY DEFINER, search_path = '')
-- Zero direct grants to anon or authenticated; only invoked internally
CREATE OR REPLACE FUNCTION app_security.log_audit_event(
  p_action text,
  p_target_entity text,
  p_target_id uuid,
  p_details jsonb
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.audit_logs (
    actor_id,
    action,
    target_entity,
    target_id,
    details,
    created_at
  ) VALUES (
    COALESCE(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid),
    p_action,
    p_target_entity,
    p_target_id,
    COALESCE(p_details, '{}'::jsonb),
    pg_catalog.clock_timestamp()
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.log_audit_event(text, text, uuid, jsonb) FROM PUBLIC, authenticated, anon;

-- 4. Create public.privacy_requests
CREATE TABLE public.privacy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  request_type public.privacy_request_type_enum NOT NULL,
  status public.privacy_request_status_enum NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id),
  resolution_notes text
);

-- Duplicate pending request prevention
CREATE UNIQUE INDEX idx_unique_pending_privacy_request
ON public.privacy_requests (user_id, request_type)
WHERE status = 'pending';

-- 5. Trigger: enforce_privacy_request_limits (Advisory Locked Rolling 30-day Limit)
CREATE OR REPLACE FUNCTION public.enforce_privacy_request_limits()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_caller_uid uuid;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 1. Force trusted metadata; browser cannot supply user_id, status, or resolution fields
  NEW.user_id := v_caller_uid;
  NEW.status := 'pending';
  NEW.requested_at := pg_catalog.clock_timestamp();
  NEW.resolved_at := NULL;
  NEW.resolved_by := NULL;
  NEW.resolution_notes := NULL;

  -- 2. Acquire transaction-scoped advisory lock serializing concurrent inserts for this user
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('privacy_request_' || v_caller_uid::text));

  -- 3. Check rolling 30-day window count (max 3 submissions)
  SELECT count(*) INTO v_count
  FROM public.privacy_requests
  WHERE user_id = v_caller_uid
    AND requested_at > (pg_catalog.clock_timestamp() - interval '30 days');

  IF v_count >= 3 THEN
    RAISE EXCEPTION 'Rate limit exceeded: maximum 3 privacy requests allowed per 30 days';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_privacy_request_limits
BEFORE INSERT ON public.privacy_requests
FOR EACH ROW
EXECUTE FUNCTION public.enforce_privacy_request_limits();

-- 6. Row Level Security & Policies for privacy_requests
ALTER TABLE public.privacy_requests ENABLE ROW LEVEL SECURITY;

-- Owner can view own requests; Administrator and Support Agent with AAL2 can view all
CREATE POLICY privacy_requests_select_policy ON public.privacy_requests
FOR SELECT USING (
  (user_id = auth.uid()) OR (
    app_security.is_active_staff_aal2('administrator') OR
    app_security.is_active_staff_aal2('support_agent')
  )
);

-- Owner can submit request if active or suspended
CREATE POLICY privacy_requests_insert_policy ON public.privacy_requests
FOR INSERT WITH CHECK (
  (user_id = auth.uid()) AND
  (app_security.get_account_status(auth.uid()) IN ('active', 'suspended'))
);

-- 7. Explicit Data API Grants for privacy_requests
REVOKE ALL ON public.privacy_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.privacy_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.privacy_requests TO service_role;

-- 8. Two-Layer RPC Architecture

-- ==========================================================
-- Layer A: Private Implementation Functions in app_security
-- (SECURITY DEFINER, search_path = '', unexposed schema)
-- ==========================================================

-- A1. Update Account Status (Administrator only)
CREATE OR REPLACE FUNCTION app_security.impl_update_user_account_status(
  p_target_user_id uuid,
  p_new_status public.account_status_enum,
  p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator with AAL2';
  END IF;

  UPDATE public.user_accounts
  SET account_status = p_new_status, updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_target_user_id;

  PERFORM app_security.log_audit_event(
    'user_account.status_update',
    'user_accounts',
    p_target_user_id,
    jsonb_build_object('new_status', p_new_status, 'reason', p_reason)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_update_user_account_status(uuid, public.account_status_enum, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_update_user_account_status(uuid, public.account_status_enum, text) TO authenticated, service_role;

-- A2. Assign Staff Role (Administrator only)
CREATE OR REPLACE FUNCTION app_security.impl_assign_staff_role(
  p_target_user_id uuid,
  p_new_role public.staff_role_enum
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator with AAL2';
  END IF;

  INSERT INTO public.staff_roles (user_id, role, assigned_at, assigned_by)
  VALUES (p_target_user_id, p_new_role, pg_catalog.clock_timestamp(), auth.uid())
  ON CONFLICT (user_id) DO UPDATE
  SET role = EXCLUDED.role, assigned_at = EXCLUDED.assigned_at, assigned_by = EXCLUDED.assigned_by;

  PERFORM app_security.log_audit_event(
    'staff_role.assigned',
    'staff_roles',
    p_target_user_id,
    jsonb_build_object('new_role', p_new_role)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_assign_staff_role(uuid, public.staff_role_enum) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_assign_staff_role(uuid, public.staff_role_enum) TO authenticated, service_role;

-- A3. Revoke Staff Role (Administrator only)
CREATE OR REPLACE FUNCTION app_security.impl_revoke_staff_role(
  p_target_user_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('administrator') THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator with AAL2';
  END IF;

  DELETE FROM public.staff_roles WHERE user_id = p_target_user_id;

  PERFORM app_security.log_audit_event(
    'staff_role.revoked',
    'staff_roles',
    p_target_user_id,
    '{}'::jsonb
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_revoke_staff_role(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_revoke_staff_role(uuid) TO authenticated, service_role;

-- A4. Resolve Privacy Request (Administrator OR Support Agent)
CREATE OR REPLACE FUNCTION app_security.impl_resolve_privacy_request(
  p_request_id uuid,
  p_new_status public.privacy_request_status_enum,
  p_notes text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_req_user_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (
    app_security.is_active_staff_aal2('administrator') OR
    app_security.is_active_staff_aal2('support_agent')
  ) THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator or support agent with AAL2';
  END IF;

  SELECT user_id INTO v_req_user_id
  FROM public.privacy_requests
  WHERE id = p_request_id;

  IF v_req_user_id IS NULL THEN
    RAISE EXCEPTION 'Privacy request not found';
  END IF;

  UPDATE public.privacy_requests
  SET status = p_new_status,
      resolved_at = pg_catalog.clock_timestamp(),
      resolved_by = auth.uid(),
      resolution_notes = p_notes
  WHERE id = p_request_id;

  PERFORM app_security.log_audit_event(
    'privacy_request.resolved',
    'privacy_requests',
    p_request_id,
    jsonb_build_object('target_user_id', v_req_user_id, 'new_status', p_new_status, 'notes', p_notes)
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_resolve_privacy_request(uuid, public.privacy_request_status_enum, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_resolve_privacy_request(uuid, public.privacy_request_status_enum, text) TO authenticated, service_role;

-- ==========================================================
-- Layer B: Public Callable RPC Entry Points in public
-- (SECURITY INVOKER, search_path = '', exposed to PostgREST)
-- ==========================================================

CREATE OR REPLACE FUNCTION public.admin_update_user_account_status(
  p_target_user_id uuid,
  p_new_status public.account_status_enum,
  p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_update_user_account_status(p_target_user_id, p_new_status, p_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_user_account_status(uuid, public.account_status_enum, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_user_account_status(uuid, public.account_status_enum, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_assign_staff_role(
  p_target_user_id uuid,
  p_new_role public.staff_role_enum
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_assign_staff_role(p_target_user_id, p_new_role);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_assign_staff_role(uuid, public.staff_role_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_assign_staff_role(uuid, public.staff_role_enum) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_revoke_staff_role(
  p_target_user_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_revoke_staff_role(p_target_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_staff_role(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_revoke_staff_role(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_resolve_privacy_request(
  p_request_id uuid,
  p_new_status public.privacy_request_status_enum,
  p_notes text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_resolve_privacy_request(p_request_id, p_new_status, p_notes);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_privacy_request(uuid, public.privacy_request_status_enum, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_privacy_request(uuid, public.privacy_request_status_enum, text) TO authenticated, service_role;
