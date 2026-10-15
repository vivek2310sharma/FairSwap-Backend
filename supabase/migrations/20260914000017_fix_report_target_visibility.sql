-- Migration 17: 20260914000017_fix_report_target_visibility.sql
-- Enforce legitimate target visibility and self-reporting prohibition on listing reports (Point 11)

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

    -- Prohibit self-reporting on seller's own listing
    IF EXISTS (SELECT 1 FROM public.listings WHERE id = p_target_id AND seller_id = v_caller_id) THEN
      RAISE EXCEPTION 'Cannot report your own listing';
    END IF;

    -- Enforce legitimate target visibility: listing must be publicly visible, or caller is moderator/administrator
    IF NOT (app_security.is_listing_publicly_visible(p_target_id) OR app_security.is_active_staff_aal2('moderator')) THEN
      RAISE EXCEPTION 'INVALID_TARGET: Listing not accessible';
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
