-- Migration 11: 20260914000011_create_communication.sql
-- Conversations, Messages, Read States, Keyset Pagination, Idempotency, and Realtime Publication

-- 1. Create public.conversations
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE RESTRICT,
  buyer_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  seller_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_conversation_listing_buyer UNIQUE (listing_id, buyer_id),
  CONSTRAINT chk_conversation_distinct_participants CHECK (buyer_id <> seller_id)
);

CREATE INDEX idx_conversations_buyer_last ON public.conversations(buyer_id, last_message_at DESC);
CREATE INDEX idx_conversations_seller_last ON public.conversations(seller_id, last_message_at DESC);
CREATE INDEX idx_conversations_buyer_quota ON public.conversations(buyer_id, created_at DESC);
CREATE INDEX idx_conversations_listing ON public.conversations(listing_id);

-- 2. Create public.messages
CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  client_request_id text NOT NULL CHECK (length(client_request_id) >= 8 AND length(client_request_id) <= 64),
  content text NOT NULL CHECK (length(trim(content)) >= 1 AND length(content) <= 2000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_messages_conversation_id_id UNIQUE (conversation_id, id),
  CONSTRAINT uq_message_client_request_id UNIQUE (conversation_id, sender_id, client_request_id)
);

-- Deterministic cursor index for stable pagination
CREATE INDEX idx_messages_pagination ON public.messages(conversation_id, created_at ASC, id ASC);
CREATE INDEX idx_messages_sender_quota ON public.messages(sender_id, created_at DESC);

-- 3. Create public.conversation_read_states
CREATE TABLE public.conversation_read_states (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_message_id uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (conversation_id, user_id),
  CONSTRAINT fk_read_state_message FOREIGN KEY (conversation_id, last_read_message_id)
    REFERENCES public.messages(conversation_id, id) ON DELETE CASCADE
);

-- 4. Row Level Security
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_read_states ENABLE ROW LEVEL SECURITY;

-- Conversations RLS: only participants with active or suspended account status
CREATE POLICY conversations_participant_select_policy ON public.conversations
FOR SELECT USING (
  (buyer_id = auth.uid() OR seller_id = auth.uid())
  AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended')
);

-- Messages RLS: only participants in the parent conversation with active or suspended account status
CREATE POLICY messages_participant_select_policy ON public.messages
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND (c.buyer_id = auth.uid() OR c.seller_id = auth.uid())
  )
  AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended')
);

-- Read States RLS: self only
CREATE POLICY read_states_self_select_policy ON public.conversation_read_states
FOR SELECT USING (
  user_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended')
);

-- Revoke all direct client write grants
REVOKE ALL ON public.conversations FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;

REVOKE ALL ON public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;

REVOKE ALL ON public.conversation_read_states FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.conversation_read_states TO authenticated;
GRANT ALL ON public.conversation_read_states TO service_role;

-- 5. Helper: is_blocked_bidirectional placeholder
CREATE OR REPLACE FUNCTION app_security.is_blocked_bidirectional(p_user_a uuid, p_user_b uuid)
RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF to_regclass('public.user_blocks') IS NOT NULL THEN
    RETURN EXISTS (
      SELECT 1 FROM public.user_blocks
      WHERE (blocker_id = p_user_a AND blocked_id = p_user_b)
         OR (blocker_id = p_user_b AND blocked_id = p_user_a)
    );
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION app_security.is_blocked_bidirectional(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.is_blocked_bidirectional(uuid, uuid) TO authenticated, service_role;

-- 6. RPC: send_message
CREATE OR REPLACE FUNCTION app_security.impl_send_message(
  p_conversation_id uuid,
  p_content text,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_conv record;
  v_listing record;
  v_recipient_id uuid;
  v_sender_name text;
  v_clean_content text;
  v_existing_msg record;
  v_new_msg record;
  v_recent_msg_count integer;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted: messaging requires active account';
  END IF;

  -- Validate content
  v_clean_content := trim(p_content);
  IF length(v_clean_content) < 1 OR length(v_clean_content) > 2000 THEN
    RAISE EXCEPTION 'Message length must be between 1 and 2000 characters';
  END IF;

  IF length(p_client_request_id) < 8 OR length(p_client_request_id) > 64 THEN
    RAISE EXCEPTION 'Invalid client_request_id';
  END IF;

  -- Verify conversation exists and caller is participant
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  IF v_conv.buyer_id <> v_caller_id AND v_conv.seller_id <> v_caller_id THEN
    RAISE EXCEPTION 'Forbidden: not a participant in this conversation';
  END IF;

  -- Determine recipient
  IF v_conv.buyer_id = v_caller_id THEN
    v_recipient_id := v_conv.seller_id;
  ELSE
    v_recipient_id := v_conv.buyer_id;
  END IF;

  -- Check listing status policy:
  -- Allowed: active, reserved, sold, paused
  -- Prohibited: removed, rejected
  SELECT status INTO v_listing
  FROM public.listings
  WHERE id = v_conv.listing_id;

  IF v_listing IS NULL OR v_listing.status IN ('removed', 'rejected') THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: This conversation is closed due to listing moderation';
  END IF;

  -- Check bidirectional block
  IF v_recipient_id IS NOT NULL AND app_security.is_blocked_bidirectional(v_caller_id, v_recipient_id) THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: Unable to send message to this recipient';
  END IF;

  -- Check recipient account status
  IF v_recipient_id IS NOT NULL AND app_security.get_account_status(v_recipient_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: Counterparty account is no longer active';
  END IF;

  -- Check Idempotency: replay existing message if client_request_id matches
  SELECT * INTO v_existing_msg
  FROM public.messages
  WHERE conversation_id = p_conversation_id
    AND sender_id = v_caller_id
    AND client_request_id = p_client_request_id;

  IF v_existing_msg IS NOT NULL THEN
    RETURN jsonb_build_object(
      'id', v_existing_msg.id,
      'conversation_id', v_existing_msg.conversation_id,
      'sender_id', v_existing_msg.sender_id,
      'content', v_existing_msg.content,
      'created_at', v_existing_msg.created_at,
      'is_duplicate', true
    );
  END IF;

  -- Acquire transaction-scoped advisory lock for message rate limit
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('msg_quota_' || v_caller_id::text));

  -- Check rolling quota: max 60 messages per rolling 1 hour
  SELECT count(*) INTO v_recent_msg_count
  FROM public.messages
  WHERE sender_id = v_caller_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '1 hour');

  IF v_recent_msg_count >= 60 THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: Message quota exceeded. Maximum 60 messages per hour';
  END IF;

  -- Insert message
  INSERT INTO public.messages (
    conversation_id,
    sender_id,
    client_request_id,
    content,
    created_at
  ) VALUES (
    p_conversation_id,
    v_caller_id,
    p_client_request_id,
    v_clean_content,
    pg_catalog.clock_timestamp()
  ) RETURNING * INTO v_new_msg;

  -- Update conversation last_message_at
  UPDATE public.conversations
  SET last_message_at = v_new_msg.created_at,
      updated_at = v_new_msg.created_at
  WHERE id = p_conversation_id;

  -- Mark read for sender
  INSERT INTO public.conversation_read_states (
    conversation_id,
    user_id,
    last_read_message_id,
    last_read_at
  ) VALUES (
    p_conversation_id,
    v_caller_id,
    v_new_msg.id,
    v_new_msg.created_at
  )
  ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET last_read_message_id = EXCLUDED.last_read_message_id,
      last_read_at = EXCLUDED.last_read_at;

  -- Notify recipient if recipient exists
  IF v_recipient_id IS NOT NULL THEN
    SELECT display_name INTO v_sender_name
    FROM public.profiles
    WHERE id = v_caller_id;

    PERFORM app_security.create_notification(
      v_recipient_id,
      'new_message',
      'New message from ' || COALESCE(v_sender_name, 'a buyer/seller'),
      CASE
        WHEN length(v_clean_content) > 80 THEN substring(v_clean_content from 1 for 77) || '...'
        ELSE v_clean_content
      END,
      '/account/messages/' || p_conversation_id::text
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_new_msg.id,
    'conversation_id', v_new_msg.conversation_id,
    'sender_id', v_new_msg.sender_id,
    'content', v_new_msg.content,
    'created_at', v_new_msg.created_at,
    'is_duplicate', false
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_send_message(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_send_message(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.send_message(
  conversation_id uuid,
  content text,
  client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_send_message(conversation_id, content, client_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.send_message(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_message(uuid, text, text) TO authenticated, service_role;

-- 7. RPC: start_conversation
CREATE OR REPLACE FUNCTION app_security.impl_start_conversation(
  p_listing_id uuid,
  p_content text,
  p_client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_listing record;
  v_seller_id uuid;
  v_existing_conv record;
  v_new_conv record;
  v_recent_conv_count integer;
  v_msg_result jsonb;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) <> 'active' THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  -- Validate listing exists and is publicly visible
  IF NOT app_security.is_listing_publicly_visible(p_listing_id) THEN
    RAISE EXCEPTION 'LISTING_UNAVAILABLE: New inquiries require an active, approved listing';
  END IF;

  SELECT seller_id INTO v_seller_id
  FROM public.listings
  WHERE id = p_listing_id;

  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'Listing has no valid seller';
  END IF;

  IF v_seller_id = v_caller_id THEN
    RAISE EXCEPTION 'Self-chat is prohibited: You cannot contact your own listing';
  END IF;

  -- Check bidirectional block
  IF app_security.is_blocked_bidirectional(v_caller_id, v_seller_id) THEN
    RAISE EXCEPTION 'MESSAGING_UNAVAILABLE: Unable to contact this seller';
  END IF;

  -- Acquire transaction-scoped advisory lock for conversation creation
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('conv_' || p_listing_id::text || '_' || v_caller_id::text)
  );

  -- Check if conversation already exists between this buyer and listing
  SELECT * INTO v_existing_conv
  FROM public.conversations
  WHERE listing_id = p_listing_id AND buyer_id = v_caller_id;

  IF v_existing_conv IS NOT NULL THEN
    -- Conversation exists, send message into it
    v_msg_result := app_security.impl_send_message(
      v_existing_conv.id,
      p_content,
      p_client_request_id
    );

    RETURN jsonb_build_object(
      'conversation_id', v_existing_conv.id,
      'is_new_conversation', false,
      'message', v_msg_result
    );
  END IF;

  -- Rate limit on new conversations: max 10 per rolling 1 hour
  SELECT count(*) INTO v_recent_conv_count
  FROM public.conversations
  WHERE buyer_id = v_caller_id
    AND created_at > (pg_catalog.clock_timestamp() - interval '1 hour');

  IF v_recent_conv_count >= 10 THEN
    RAISE EXCEPTION 'RATE_LIMIT_EXCEEDED: Maximum 10 new conversations per hour';
  END IF;

  -- Insert new conversation
  INSERT INTO public.conversations (
    listing_id,
    buyer_id,
    seller_id,
    last_message_at,
    created_at,
    updated_at
  ) VALUES (
    p_listing_id,
    v_caller_id,
    v_seller_id,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ) RETURNING * INTO v_new_conv;

  -- Send initial message
  v_msg_result := app_security.impl_send_message(
    v_new_conv.id,
    p_content,
    p_client_request_id
  );

  RETURN jsonb_build_object(
    'conversation_id', v_new_conv.id,
    'is_new_conversation', true,
    'message', v_msg_result
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_start_conversation(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_start_conversation(uuid, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.start_conversation(
  listing_id uuid,
  content text,
  client_request_id text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_start_conversation(listing_id, content, client_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.start_conversation(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_conversation(uuid, text, text) TO authenticated, service_role;

-- 8. RPC: mark_conversation_read
CREATE OR REPLACE FUNCTION app_security.impl_mark_conversation_read(
  p_conversation_id uuid,
  p_message_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_caller_id uuid;
  v_conv record;
  v_target_msg record;
  v_current_read record;
BEGIN
  v_caller_id := auth.uid();
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  -- Verify participant
  SELECT * INTO v_conv
  FROM public.conversations
  WHERE id = p_conversation_id;

  IF v_conv IS NULL THEN
    RAISE EXCEPTION 'Conversation not found';
  END IF;

  IF v_conv.buyer_id <> v_caller_id AND v_conv.seller_id <> v_caller_id THEN
    RAISE EXCEPTION 'Forbidden: not a participant';
  END IF;

  -- Verify message belongs to this conversation
  SELECT id, created_at INTO v_target_msg
  FROM public.messages
  WHERE id = p_message_id AND conversation_id = p_conversation_id;

  IF v_target_msg IS NULL THEN
    RAISE EXCEPTION 'Message does not belong to this conversation';
  END IF;

  -- Monotonic check: get current read marker
  SELECT m.created_at, m.id INTO v_current_read
  FROM public.conversation_read_states crs
  JOIN public.messages m ON m.id = crs.last_read_message_id
  WHERE crs.conversation_id = p_conversation_id AND crs.user_id = v_caller_id;

  IF v_current_read IS NOT NULL THEN
    -- If candidate message is older or equal, do not regress pointer
    IF (v_target_msg.created_at, v_target_msg.id) <= (v_current_read.created_at, v_current_read.id) THEN
      RETURN;
    END IF;
  END IF;

  -- Update or insert read marker
  INSERT INTO public.conversation_read_states (
    conversation_id,
    user_id,
    last_read_message_id,
    last_read_at
  ) VALUES (
    p_conversation_id,
    v_caller_id,
    p_message_id,
    pg_catalog.clock_timestamp()
  )
  ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET last_read_message_id = EXCLUDED.last_read_message_id,
      last_read_at = EXCLUDED.last_read_at;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_mark_conversation_read(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_mark_conversation_read(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_conversation_read(
  conversation_id uuid,
  message_id uuid
) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_mark_conversation_read(conversation_id, message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_conversation_read(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_conversation_read(uuid, uuid) TO authenticated, service_role;

-- 9. Add messages to Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
