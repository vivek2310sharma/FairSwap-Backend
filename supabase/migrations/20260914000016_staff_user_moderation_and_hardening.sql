-- Migration 16: 20260914000016_staff_user_moderation_and_hardening.sql
-- Staff User Moderation, Hardened Account Status RPC, and Staff User Search RPC
-- Non-destructive and backward-compatible with existing data.

-- =============================================================================
-- 1. Update Staff Select Policy on public.user_accounts
-- Allows active administrators, moderators, and support agents with AAL2 to view user accounts
-- =============================================================================

DROP POLICY IF EXISTS user_accounts_staff_select_policy ON public.user_accounts;
CREATE POLICY user_accounts_staff_select_policy ON public.user_accounts
FOR SELECT USING (
  app_security.is_active_staff_aal2('administrator') OR
  app_security.is_active_staff_aal2('moderator') OR
  app_security.is_active_staff_aal2('support_agent')
);

-- =============================================================================
-- 2. Hardened Implementation: app_security.impl_update_user_account_status
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_update_user_account_status(
  p_target_user_id uuid,
  p_new_status public.account_status_enum,
  p_reason text
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_role public.staff_role_enum;
  v_target_role public.staff_role_enum;
  v_current_status public.account_status_enum;
  v_clean_reason text;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- 1. Authorization: Must be active administrator or moderator with AAL2
  IF NOT (app_security.is_active_staff_aal2('administrator') OR app_security.is_active_staff_aal2('moderator')) THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator or moderator with AAL2';
  END IF;

  -- 2. Staff cannot modify their own account status
  IF v_caller_id = p_target_user_id THEN
    RAISE EXCEPTION 'Forbidden: staff cannot alter own account status';
  END IF;

  -- 3. Business rule: new status MUST NOT BE NULL and MUST be active or suspended only
  IF p_new_status IS NULL OR p_new_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Invalid status transition: moderation status may only be set to active or suspended';
  END IF;

  -- 4. Validate reason: NOT NULL and 10 to 500 characters after trimming
  v_clean_reason := trim(p_reason);
  IF v_clean_reason IS NULL OR length(v_clean_reason) < 10 OR length(v_clean_reason) > 500 THEN
    RAISE EXCEPTION 'Moderation reason must be between 10 and 500 characters';
  END IF;

  -- 5. Check target user exists
  SELECT account_status INTO v_current_status
  FROM public.user_accounts
  WHERE user_id = p_target_user_id;

  IF v_current_status IS NULL THEN
    RAISE EXCEPTION 'Target user does not exist';
  END IF;

  -- 6. Reject no-op status change
  IF v_current_status = p_new_status THEN
    RAISE EXCEPTION 'Target account already has status %', p_new_status;
  END IF;

  -- 7. Role boundary checks
  SELECT role INTO v_caller_role FROM public.staff_roles WHERE user_id = v_caller_id;
  SELECT role INTO v_target_role FROM public.staff_roles WHERE user_id = p_target_user_id;

  -- Moderators cannot modify any staff account
  IF v_caller_role = 'moderator' AND v_target_role IS NOT NULL THEN
    RAISE EXCEPTION 'Forbidden: moderators cannot modify staff accounts';
  END IF;

  -- 8. Mutate account status
  UPDATE public.user_accounts
  SET account_status = p_new_status, updated_at = pg_catalog.clock_timestamp()
  WHERE user_id = p_target_user_id;

  -- 9. Atomic audit logging capturing old_status, new_status, and clean reason
  PERFORM app_security.log_audit_event(
    'user_account.status_update',
    'user_accounts',
    p_target_user_id,
    jsonb_build_object(
      'old_status', v_current_status,
      'new_status', p_new_status,
      'reason', v_clean_reason
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_update_user_account_status(uuid, public.account_status_enum, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_update_user_account_status(uuid, public.account_status_enum, text) TO authenticated, service_role;

-- Ensure public wrapper exists and delegates
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

-- =============================================================================
-- 3. Staff User Search RPC
-- =============================================================================

CREATE OR REPLACE FUNCTION app_security.impl_admin_search_users(
  p_query text DEFAULT NULL,
  p_status public.account_status_enum DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  account_status public.account_status_enum,
  role public.staff_role_enum,
  created_at timestamptz,
  listings_count bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_clean_query text;
  v_clamped_limit integer;
  v_clamped_offset integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT (app_security.is_active_staff_aal2('administrator') OR app_security.is_active_staff_aal2('moderator')) THEN
    RAISE EXCEPTION 'Forbidden: requires active administrator or moderator with AAL2';
  END IF;

  v_clamped_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  v_clamped_offset := GREATEST(COALESCE(p_offset, 0), 0);
  v_clean_query := NULLIF(trim(p_query), '');

  RETURN QUERY
  SELECT
    ua.user_id,
    u.email::text,
    p.display_name,
    ua.account_status,
    sr.role,
    ua.created_at,
    COALESCE(lc.cnt, 0)::bigint AS listings_count
  FROM public.user_accounts ua
  JOIN auth.users u ON u.id = ua.user_id
  LEFT JOIN public.profiles p ON p.id = ua.user_id
  LEFT JOIN public.staff_roles sr ON sr.user_id = ua.user_id
  LEFT JOIN (
    SELECT l.seller_id, COUNT(*) AS cnt
    FROM public.listings l
    GROUP BY l.seller_id
  ) lc ON lc.seller_id = ua.user_id
  WHERE (p_status IS NULL OR ua.account_status = p_status)
    AND (
      v_clean_query IS NULL
      OR u.email ILIKE ('%' || v_clean_query || '%')
      OR p.display_name ILIKE ('%' || v_clean_query || '%')
      OR ua.user_id::text = v_clean_query
    )
  ORDER BY ua.created_at DESC
  LIMIT v_clamped_limit
  OFFSET v_clamped_offset;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_admin_search_users(text, public.account_status_enum, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_admin_search_users(text, public.account_status_enum, integer, integer) TO authenticated, service_role;

-- Public callable wrapper (SECURITY INVOKER)
CREATE OR REPLACE FUNCTION public.admin_search_users(
  p_query text DEFAULT NULL,
  p_status public.account_status_enum DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  email text,
  display_name text,
  account_status public.account_status_enum,
  role public.staff_role_enum,
  created_at timestamptz,
  listings_count bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM app_security.impl_admin_search_users(p_query, p_status, p_limit, p_offset);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_search_users(text, public.account_status_enum, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_search_users(text, public.account_status_enum, integer, integer) TO authenticated, service_role;
