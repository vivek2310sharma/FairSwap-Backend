-- Migration 12: 20260914000012_create_abuse_controls_and_reports.sql
-- User Blocks, Reports, Quotas, Reporter Privacy, and Case-Scoped Evidence Access

-- 1. Create public.user_blocks
CREATE TABLE public.user_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_user_blocks UNIQUE (blocker_id, blocked_id),
  CONSTRAINT chk_user_blocks_not_self CHECK (blocker_id <> blocked_id)
);

CREATE INDEX idx_user_blocks_lookup ON public.user_blocks(blocker_id, blocked_id);
CREATE INDEX idx_user_blocks_blocked ON public.user_blocks(blocked_id);

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

-- Block RLS: Only the blocker can view their own initiated blocks.
-- The blocked user has ZERO visibility to prevent discovering block direction.
CREATE POLICY user_blocks_select_policy ON public.user_blocks
FOR SELECT USING (
  blocker_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended')
);

REVOKE ALL ON public.user_blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.user_blocks TO authenticated;
GRANT ALL ON public.user_blocks TO service_role;

-- 2. User Block RPCs
CREATE OR REPLACE FUNCTION app_security.impl_block_user(
  p_blocked_user_id uuid,
  p_reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  IF v_caller_id = p_blocked_user_id THEN
    RAISE EXCEPTION 'Cannot block yourself';
  END IF;

  -- Verify target user exists
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_blocked_user_id) THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;

  INSERT INTO public.user_blocks (
    blocker_id,
    blocked_id,
    reason,
    created_at
  ) VALUES (
    v_caller_id,
    p_blocked_user_id,
    p_reason,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (blocker_id, blocked_id) DO UPDATE
  SET reason = EXCLUDED.reason;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_block_user(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_block_user(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.block_user(
  blocked_user_id uuid,
  reason text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_block_user(blocked_user_id, reason);
END;
$$;

REVOKE ALL ON FUNCTION public.block_user(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.block_user(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION app_security.impl_unblock_user(
  p_blocked_user_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  DELETE FROM public.user_blocks
  WHERE blocker_id = v_caller_id AND blocked_id = p_blocked_user_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_unblock_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_unblock_user(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unblock_user(
  blocked_user_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_unblock_user(blocked_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.unblock_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unblock_user(uuid) TO authenticated, service_role;

-- 3. Create public.reports
CREATE TYPE public.report_target_type_enum AS ENUM (
  'listing',
  'user',
  'message'
);

CREATE TYPE public.report_status_enum AS ENUM (
  'pending',
  'investigating',
  'resolved',
  'dismissed'
);

CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_type public.report_target_type_enum NOT NULL,
  target_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) >= 3 AND length(reason) <= 100),
  details text CHECK (details IS NULL OR length(details) <= 2000),
  status public.report_status_enum NOT NULL DEFAULT 'pending',
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_notes text,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_reports_status ON public.reports(status, created_at DESC);
CREATE INDEX idx_reports_reporter_quota ON public.reports(reporter_id, created_at DESC);
CREATE INDEX idx_reports_target ON public.reports(target_type, target_id);

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

-- Reports RLS: Only authorized staff (moderator or administrator) with AAL2 can read reports
CREATE POLICY reports_staff_select_policy ON public.reports
FOR SELECT USING (
  app_security.is_active_staff_aal2('moderator')
);

REVOKE ALL ON public.reports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.reports TO authenticated;
GRANT ALL ON public.reports TO service_role;

-- 4. RPC: create_report
CREATE OR REPLACE FUNCTION app_security.impl_create_report(
  p_target_type public.report_target_type_enum,
  p_target_id uuid,
  p_reason text,
  p_details text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_report_id uuid;
  v_clean_reason text;
  v_recent_report_count integer;
  v_msg_conv_id uuid;
  v_is_participant boolean;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  v_clean_reason := trim(p_reason);
  IF length(v_clean_reason) < 3 OR length(v_clean_reason) > 100 THEN
    RAISE EXCEPTION 'Reason must be between 3 and 100 characters';
  END IF;

  -- Validate target exists and caller is authorized to report it
  IF p_target_type = 'listing' THEN
    IF NOT EXISTS (SELECT 1 FROM public.listings WHERE id = p_target_id) THEN
      RAISE EXCEPTION 'INVALID_TARGET: Listing not found';
    END IF;
  ELSIF p_target_type = 'user' THEN
    IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = p_target_id) THEN
      RAISE EXCEPTION 'INVALID_TARGET: User not found';
    END IF;
    IF p_target_id = v_caller_id THEN
      RAISE EXCEPTION 'Cannot report yourself';
    END IF;
  ELSIF p_target_type = 'message' THEN
    SELECT conversation_id INTO v_msg_conv_id
    FROM public.messages
    WHERE id = p_target_id;

    IF v_msg_conv_id IS NULL THEN
      RAISE EXCEPTION 'INVALID_TARGET: Message not found';
    END IF;

    -- Verify caller is participant in that conversation
    SELECT EXISTS (
      SELECT 1 FROM public.conversations
      WHERE id = v_msg_conv_id AND (buyer_id = v_caller_id OR seller_id = v_caller_id)
    ) INTO v_is_participant;

    IF NOT v_is_participant THEN
      RAISE EXCEPTION 'Forbidden: cannot report a message from a conversation you are not in';
    END IF;
  END IF;

  -- Advisory lock for report rate limiting: max 5 reports per rolling 24 hours
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('report_quota_' || v_caller_id::text));

  SELECT count(*) INTO v_recent_report_count
  FROM public.reports
  WHERE reporter_id = v_caller_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '24 hours');

  IF v_recent_report_count >= 5 THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: Maximum 5 reports allowed per 24 hours';
  END IF;

  INSERT INTO public.reports (
    reporter_id,
    target_type,
    target_id,
    reason,
    details,
    status,
    assigned_to,
    resolution_notes,
    resolved_at,
    created_at
  ) VALUES (
    v_caller_id,
    p_target_type,
    p_target_id,
    v_clean_reason,
    p_details,
    'pending',
    NULL,
    NULL,
    NULL,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_report_id;

  RETURN v_report_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_create_report(public.report_target_type_enum, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_create_report(public.report_target_type_enum, uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_report(
  target_type public.report_target_type_enum,
  target_id uuid,
  reason text,
  details text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_create_report(target_type, target_id, reason, details);
END;
$$;

REVOKE ALL ON FUNCTION public.create_report(public.report_target_type_enum, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_report(public.report_target_type_enum, uuid, text, text) TO authenticated, service_role;

-- 5. Safe Projection RPC for Customer Reports
CREATE OR REPLACE FUNCTION public.get_my_reports()
RETURNS TABLE (
  id uuid,
  target_type public.report_target_type_enum,
  target_id uuid,
  reason text,
  status public.report_status_enum,
  created_at timestamptz,
  resolved_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  RETURN QUERY
  SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at, r.resolved_at
  FROM public.reports r
  WHERE r.reporter_id = v_caller_id
  ORDER BY r.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_reports() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_reports() TO authenticated, service_role;

-- 6. Staff Report Resolution RPC
CREATE OR REPLACE FUNCTION app_security.impl_staff_resolve_report(
  p_report_id uuid,
  p_new_status public.report_status_enum,
  p_resolution_notes text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_report record;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('moderator') THEN
    RAISE EXCEPTION 'Forbidden: requires active moderator with AAL2';
  END IF;

  SELECT * INTO v_report
  FROM public.reports
  WHERE id = p_report_id;

  IF v_report IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  UPDATE public.reports
  SET status = p_new_status,
      resolution_notes = p_resolution_notes,
      resolved_by_staff_id = v_caller_id,
      resolved_at = pg_catalog.clock_timestamp()
  WHERE id = p_report_id;

  -- Append audit log
  PERFORM app_security.log_audit_event(
    'report.resolved',
    'reports',
    p_report_id,
    jsonb_build_object(
      'previous_status', v_report.status,
      'new_status', p_new_status,
      'target_type', v_report.target_type,
      'target_id', v_report.target_id,
      'notes', p_resolution_notes
    )
  );

  -- Notify reporter if reporter is still a valid user
  IF v_report.reporter_id IS NOT NULL THEN
    PERFORM app_security.create_notification(
      v_report.reporter_id,
      'report_update',
      'Report Update',
      'Your report on ' || v_report.target_type::text || ' has been reviewed and marked as ' || p_new_status::text || '.',
      '/account/reports'
    );
  END IF;
END;
$$;

-- Fix table column for staff resolution attribution
ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS resolved_by_staff_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

REVOKE ALL ON FUNCTION app_security.impl_staff_resolve_report(uuid, public.report_status_enum, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_staff_resolve_report(uuid, public.report_status_enum, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_resolve_report(
  report_id uuid,
  new_status public.report_status_enum,
  resolution_notes text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_staff_resolve_report(report_id, new_status, resolution_notes);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_report(uuid, public.report_status_enum, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_resolve_report(uuid, public.report_status_enum, text) TO authenticated, service_role;

-- 7. Case-Scoped Evidence RPC
CREATE OR REPLACE FUNCTION app_security.impl_staff_get_report_evidence(
  p_report_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_report record;
  v_reported_msg record;
  v_context jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('moderator') THEN
    RAISE EXCEPTION 'Forbidden: requires active moderator with AAL2';
  END IF;

  SELECT * INTO v_report
  FROM public.reports
  WHERE id = p_report_id;

  IF v_report IS NULL THEN
    RAISE EXCEPTION 'Report not found';
  END IF;

  IF v_report.target_type <> 'message' THEN
    RAISE EXCEPTION 'Report does not target a message';
  END IF;

  SELECT m.id, m.conversation_id, m.sender_id, m.content, m.created_at, p.display_name AS sender_name
  INTO v_reported_msg
  FROM public.messages m
  LEFT JOIN public.profiles p ON p.id = m.sender_id
  WHERE m.id = v_report.target_id;

  IF v_reported_msg IS NULL THEN
    RAISE EXCEPTION 'Reported message no longer exists';
  END IF;

  -- Bounded context: retrieve up to 3 immediately preceding messages from this conversation
  SELECT COALESCE(jsonb_agg(ctx_row), '[]'::jsonb) INTO v_context
  FROM (
    SELECT m.id, m.sender_id, m.content, m.created_at, p.display_name AS sender_name
    FROM public.messages m
    LEFT JOIN public.profiles p ON p.id = m.sender_id
    WHERE m.conversation_id = v_reported_msg.conversation_id
      AND (m.created_at, m.id) < (v_reported_msg.created_at, v_reported_msg.id)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 3
  ) ctx_row;

  -- Append-only audit log of private evidence access
  PERFORM app_security.log_audit_event(
    'report.evidence_accessed',
    'reports',
    p_report_id,
    jsonb_build_object(
      'staff_id', v_caller_id,
      'message_id', v_reported_msg.id,
      'conversation_id', v_reported_msg.conversation_id
    )
  );

  RETURN jsonb_build_object(
    'report_id', p_report_id,
    'reported_message', jsonb_build_object(
      'id', v_reported_msg.id,
      'conversation_id', v_reported_msg.conversation_id,
      'sender_id', v_reported_msg.sender_id,
      'sender_name', v_reported_msg.sender_name,
      'content', v_reported_msg.content,
      'created_at', v_reported_msg.created_at
    ),
    'preceding_context', v_context
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_staff_get_report_evidence(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_staff_get_report_evidence(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_get_report_evidence(
  report_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_staff_get_report_evidence(report_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_report_evidence(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_report_evidence(uuid) TO authenticated, service_role;
