-- Migration 13: 20260914000013_create_support_and_appeals.sql
-- Support Tickets, Appeals for Suspended Accounts, Segregated Replies, and Internal Notes

-- 1. Create enums
CREATE TYPE public.support_ticket_category_enum AS ENUM (
  'general',
  'account',
  'moderation_appeal',
  'safety',
  'bug'
);

CREATE TYPE public.support_ticket_status_enum AS ENUM (
  'open',
  'in_progress',
  'awaiting_user',
  'resolved',
  'closed'
);

CREATE TYPE public.support_ticket_priority_enum AS ENUM (
  'low',
  'normal',
  'high',
  'urgent'
);

-- 2. Create public.support_tickets
CREATE TABLE public.support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  category public.support_ticket_category_enum NOT NULL,
  subject text NOT NULL CHECK (length(trim(subject)) >= 3 AND length(subject) <= 150),
  status public.support_ticket_status_enum NOT NULL DEFAULT 'open',
  priority public.support_ticket_priority_enum NOT NULL DEFAULT 'normal',
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_support_tickets_user ON public.support_tickets(user_id, created_at DESC);
CREATE INDEX idx_support_tickets_status ON public.support_tickets(status, priority, created_at DESC);
CREATE INDEX idx_support_tickets_quota ON public.support_tickets(user_id, created_at DESC);

-- 3. Create public.support_messages
CREATE TABLE public.support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.support_tickets(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  content text NOT NULL CHECK (length(trim(content)) >= 1 AND length(content) <= 3000),
  is_internal_note boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX idx_support_messages_ticket ON public.support_messages(ticket_id, created_at ASC);

-- 4. Row Level Security
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

-- Ticket RLS
CREATE POLICY support_tickets_select_policy ON public.support_tickets
FOR SELECT USING (
  (user_id = auth.uid() AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended'))
  OR app_security.is_active_staff_aal2('support_agent')
);

-- Message RLS: Customers NEVER see is_internal_note = true
CREATE POLICY support_messages_select_policy ON public.support_messages
FOR SELECT USING (
  (
    EXISTS (
      SELECT 1 FROM public.support_tickets t
      WHERE t.id = support_messages.ticket_id AND t.user_id = auth.uid()
    )
    AND is_internal_note = false
    AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended')
  )
  OR app_security.is_active_staff_aal2('support_agent')
);

REVOKE ALL ON public.support_tickets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_tickets TO authenticated;
GRANT ALL ON public.support_tickets TO service_role;

REVOKE ALL ON public.support_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.support_messages TO authenticated;
GRANT ALL ON public.support_messages TO service_role;

-- 5. RPC: create_support_ticket
CREATE OR REPLACE FUNCTION app_security.impl_create_support_ticket(
  p_category public.support_ticket_category_enum,
  p_subject text,
  p_message text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_caller_status public.account_status_enum;
  v_clean_subject text;
  v_clean_message text;
  v_recent_ticket_count integer;
  v_ticket_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  v_caller_status := app_security.get_account_status(v_caller_id);

  -- Moderation appeals can be filed by suspended users; all other categories require active status
  IF v_caller_status = 'suspended' AND p_category <> 'moderation_appeal' THEN
    RAISE EXCEPTION 'Suspended accounts may only submit moderation appeals';
  ELSIF v_caller_status NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  v_clean_subject := trim(p_subject);
  IF length(v_clean_subject) < 3 OR length(v_clean_subject) > 150 THEN
    RAISE EXCEPTION 'Subject must be between 3 and 150 characters';
  END IF;

  v_clean_message := trim(p_message);
  IF length(v_clean_message) < 1 OR length(v_clean_message) > 3000 THEN
    RAISE EXCEPTION 'Message must be between 1 and 3000 characters';
  END IF;

  -- Advisory lock for ticket quota: max 3 tickets per rolling 24 hours
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('support_quota_' || v_caller_id::text));

  SELECT count(*) INTO v_recent_ticket_count
  FROM public.support_tickets
  WHERE user_id = v_caller_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '24 hours');

  IF v_recent_ticket_count >= 3 THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: Maximum 3 support tickets allowed per 24 hours';
  END IF;

  INSERT INTO public.support_tickets (
    user_id,
    category,
    subject,
    status,
    priority,
    assigned_to,
    created_at,
    updated_at
  ) VALUES (
    v_caller_id,
    p_category,
    v_clean_subject,
    'open',
    'normal',
    NULL,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_ticket_id;

  INSERT INTO public.support_messages (
    ticket_id,
    sender_id,
    content,
    is_internal_note,
    created_at
  ) VALUES (
    v_ticket_id,
    v_caller_id,
    v_clean_message,
    false,
    pg_catalog.clock_timestamp()
  );

  RETURN v_ticket_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_create_support_ticket(public.support_ticket_category_enum, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_create_support_ticket(public.support_ticket_category_enum, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_support_ticket(
  category public.support_ticket_category_enum,
  subject text,
  message text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_create_support_ticket(category, subject, message);
END;
$$;

REVOKE ALL ON FUNCTION public.create_support_ticket(public.support_ticket_category_enum, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_support_ticket(public.support_ticket_category_enum, text, text) TO authenticated, service_role;

-- 6. RPC: customer_reply_support_ticket
CREATE OR REPLACE FUNCTION app_security.impl_customer_reply_support_ticket(
  p_ticket_id uuid,
  p_content text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_ticket record;
  v_clean_content text;
  v_msg_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket IS NULL THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  IF v_ticket.user_id <> v_caller_id THEN
    RAISE EXCEPTION 'Forbidden: not ticket owner';
  END IF;

  IF v_ticket.status = 'closed' THEN
    RAISE EXCEPTION 'Cannot reply to a closed support ticket';
  END IF;

  IF app_security.get_account_status(v_caller_id) = 'suspended' AND v_ticket.category <> 'moderation_appeal' THEN
    RAISE EXCEPTION 'Account restricted';
  ELSIF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  v_clean_content := trim(p_content);
  IF length(v_clean_content) < 1 OR length(v_clean_content) > 3000 THEN
    RAISE EXCEPTION 'Content must be between 1 and 3000 characters';
  END IF;

  -- Insert customer message with forced is_internal_note = false
  INSERT INTO public.support_messages (
    ticket_id,
    sender_id,
    content,
    is_internal_note,
    created_at
  ) VALUES (
    p_ticket_id,
    v_caller_id,
    v_clean_content,
    false,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_msg_id;

  -- Update ticket status to in_progress if currently awaiting_user
  UPDATE public.support_tickets
  SET status = CASE WHEN status = 'awaiting_user' THEN 'in_progress' ELSE status END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_ticket_id;

  RETURN v_msg_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_customer_reply_support_ticket(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_customer_reply_support_ticket(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.customer_reply_support_ticket(
  ticket_id uuid,
  content text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_customer_reply_support_ticket(ticket_id, content);
END;
$$;

REVOKE ALL ON FUNCTION public.customer_reply_support_ticket(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_reply_support_ticket(uuid, text) TO authenticated, service_role;

-- 7. Staff RPC: staff_reply_support_ticket
CREATE OR REPLACE FUNCTION app_security.impl_staff_reply_support_ticket(
  p_ticket_id uuid,
  p_content text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_ticket record;
  v_clean_content text;
  v_msg_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('support_agent') THEN
    RAISE EXCEPTION 'Forbidden: requires active support agent with AAL2';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket IS NULL THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  v_clean_content := trim(p_content);
  IF length(v_clean_content) < 1 OR length(v_clean_content) > 3000 THEN
    RAISE EXCEPTION 'Content must be between 1 and 3000 characters';
  END IF;

  -- Insert customer-visible staff reply
  INSERT INTO public.support_messages (
    ticket_id,
    sender_id,
    content,
    is_internal_note,
    created_at
  ) VALUES (
    p_ticket_id,
    v_caller_id,
    v_clean_content,
    false,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_msg_id;

  -- Update ticket status to awaiting_user
  UPDATE public.support_tickets
  SET status = 'awaiting_user',
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_ticket_id;

  -- Notify ticket owner
  IF v_ticket.user_id IS NOT NULL THEN
    PERFORM app_security.create_notification(
      v_ticket.user_id,
      'support_reply',
      'Support Team Reply',
      'A support agent has replied to your ticket: "' || v_ticket.subject || '".',
      '/account/support/' || p_ticket_id::text
    );
  END IF;

  RETURN v_msg_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_staff_reply_support_ticket(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_staff_reply_support_ticket(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_reply_support_ticket(
  ticket_id uuid,
  content text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_staff_reply_support_ticket(ticket_id, content);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reply_support_ticket(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reply_support_ticket(uuid, text) TO authenticated, service_role;

-- 8. Staff RPC: staff_add_ticket_internal_note
CREATE OR REPLACE FUNCTION app_security.impl_staff_add_ticket_internal_note(
  p_ticket_id uuid,
  p_content text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_ticket record;
  v_clean_content text;
  v_msg_id uuid;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('support_agent') THEN
    RAISE EXCEPTION 'Forbidden: requires active support agent with AAL2';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket IS NULL THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  v_clean_content := trim(p_content);
  IF length(v_clean_content) < 1 OR length(v_clean_content) > 3000 THEN
    RAISE EXCEPTION 'Content must be between 1 and 3000 characters';
  END IF;

  -- Insert staff internal note (strictly invisible to customer via RLS)
  INSERT INTO public.support_messages (
    ticket_id,
    sender_id,
    content,
    is_internal_note,
    created_at
  ) VALUES (
    p_ticket_id,
    v_caller_id,
    v_clean_content,
    true,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_msg_id;

  UPDATE public.support_tickets
  SET updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_ticket_id;

  RETURN v_msg_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_staff_add_ticket_internal_note(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_staff_add_ticket_internal_note(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_add_ticket_internal_note(
  ticket_id uuid,
  content text
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_staff_add_ticket_internal_note(ticket_id, content);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_add_ticket_internal_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_add_ticket_internal_note(uuid, text) TO authenticated, service_role;

-- 9. Staff RPC: staff_update_ticket_status
CREATE OR REPLACE FUNCTION app_security.impl_staff_update_ticket_status(
  p_ticket_id uuid,
  p_status public.support_ticket_status_enum,
  p_priority public.support_ticket_priority_enum,
  p_assigned_to uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_ticket record;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT app_security.is_active_staff_aal2('support_agent') THEN
    RAISE EXCEPTION 'Forbidden: requires active support agent with AAL2';
  END IF;

  SELECT * INTO v_ticket
  FROM public.support_tickets
  WHERE id = p_ticket_id;

  IF v_ticket IS NULL THEN
    RAISE EXCEPTION 'Support ticket not found';
  END IF;

  UPDATE public.support_tickets
  SET status = p_status,
      priority = p_priority,
      assigned_to = p_assigned_to,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_ticket_id;

  PERFORM app_security.log_audit_event(
    'support_ticket.updated',
    'support_tickets',
    p_ticket_id,
    jsonb_build_object(
      'status', p_status,
      'priority', p_priority,
      'assigned_to', p_assigned_to
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_staff_update_ticket_status(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_staff_update_ticket_status(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_update_ticket_status(
  ticket_id uuid,
  status public.support_ticket_status_enum,
  priority public.support_ticket_priority_enum,
  assigned_to uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_staff_update_ticket_status(ticket_id, status, priority, assigned_to);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_ticket_status(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_update_ticket_status(uuid, public.support_ticket_status_enum, public.support_ticket_priority_enum, uuid) TO authenticated, service_role;
