-- Migration 15: 20260914000015_correct_report_notification_and_permissions.sql
-- Pre-Push Security Hardening: Direct DML Revocations, Notification Integrity, and Idempotent Report Resolution

-- 1. Explicitly revoke all direct INSERT, UPDATE, DELETE on Milestone 1.5 tables from client roles
REVOKE INSERT, UPDATE, DELETE ON public.notifications FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.conversations FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.messages FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.conversation_read_states FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.user_blocks FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.reports FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.support_tickets FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.support_messages FROM PUBLIC, anon, authenticated;

-- 2. Ensure only SELECT is granted to authenticated on these tables
GRANT SELECT ON public.notifications TO authenticated;
GRANT SELECT ON public.conversations TO authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT SELECT ON public.conversation_read_states TO authenticated;
GRANT SELECT ON public.user_blocks TO authenticated;
GRANT SELECT ON public.reports TO authenticated;
GRANT SELECT ON public.support_tickets TO authenticated;
GRANT SELECT ON public.support_messages TO authenticated;

-- Ensure service_role retains internal maintenance grants
GRANT ALL ON public.notifications TO service_role;
GRANT ALL ON public.conversations TO service_role;
GRANT ALL ON public.messages TO service_role;
GRANT ALL ON public.conversation_read_states TO service_role;
GRANT ALL ON public.user_blocks TO service_role;
GRANT ALL ON public.reports TO service_role;
GRANT ALL ON public.support_tickets TO service_role;
GRANT ALL ON public.support_messages TO service_role;

-- 3. Confirm absence of client write policies on notifications
DROP POLICY IF EXISTS notifications_update_policy ON public.notifications;
DROP POLICY IF EXISTS notifications_insert_policy ON public.notifications;
DROP POLICY IF EXISTS notifications_delete_policy ON public.notifications;

-- 4. Correct impl_staff_resolve_report for strict idempotency and reporter notification
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

  -- Idempotency check: If report already has this status, safely no-op without emitting duplicate notifications or audits
  IF v_report.status = p_new_status THEN
    RETURN;
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

  -- Notify reporter only if previous status was non-terminal and reporter still exists
  IF v_report.reporter_id IS NOT NULL AND v_report.status = 'pending' THEN
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
