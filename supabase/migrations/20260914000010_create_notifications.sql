-- Migration 10: 20260914000010_create_notifications.sql
-- In-App Notifications, Read Management RPCs, Transition Trigger, and Realtime Publication

-- 1. Create notification_type_enum
CREATE TYPE public.notification_type_enum AS ENUM (
  'new_message',
  'listing_approved',
  'listing_rejected',
  'report_update',
  'support_reply'
);

-- 2. Create public.notifications
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type public.notification_type_enum NOT NULL,
  title text NOT NULL CHECK (length(title) >= 1 AND length(title) <= 120),
  body text NOT NULL CHECK (length(body) >= 1 AND length(body) <= 500),
  link text CHECK (link IS NULL OR length(link) <= 300),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Indexes
CREATE INDEX idx_notifications_user_unread ON public.notifications(user_id, read_at, created_at DESC);
CREATE INDEX idx_notifications_user_created ON public.notifications(user_id, created_at DESC);

-- 3. Row Level Security
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY notifications_select_policy ON public.notifications
FOR SELECT USING (
  user_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) IN ('active', 'suspended')
);

-- Revoke all direct client write grants
REVOKE ALL ON public.notifications FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT ALL ON public.notifications TO service_role;

-- 4. Internal Helper: create_notification (SECURITY DEFINER, search_path = '')
CREATE OR REPLACE FUNCTION app_security.create_notification(
  p_user_id uuid,
  p_type public.notification_type_enum,
  p_title text,
  p_body text,
  p_link text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_notification_id uuid;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.notifications (
    user_id,
    type,
    title,
    body,
    link,
    created_at
  ) VALUES (
    p_user_id,
    p_type,
    p_title,
    p_body,
    p_link,
    pg_catalog.clock_timestamp()
  ) RETURNING id INTO v_notification_id;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION app_security.create_notification(uuid, public.notification_type_enum, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.create_notification(uuid, public.notification_type_enum, text, text, text) TO service_role;

-- 5. RPC: mark_notification_read
CREATE OR REPLACE FUNCTION app_security.impl_mark_notification_read(p_id uuid)
RETURNS void
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

  IF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  UPDATE public.notifications
  SET read_at = pg_catalog.clock_timestamp()
  WHERE id = p_id AND user_id = v_caller_id AND read_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_mark_notification_read(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_mark_notification_read(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_notification_read(notification_id uuid)
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_mark_notification_read(notification_id);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_notification_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(uuid) TO authenticated, service_role;

-- 6. RPC: mark_all_notifications_read
CREATE OR REPLACE FUNCTION app_security.impl_mark_all_notifications_read()
RETURNS void
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

  IF app_security.get_account_status(v_caller_id) NOT IN ('active', 'suspended') THEN
    RAISE EXCEPTION 'Account restricted';
  END IF;

  UPDATE public.notifications
  SET read_at = pg_catalog.clock_timestamp()
  WHERE user_id = v_caller_id AND read_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_mark_all_notifications_read() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_mark_all_notifications_read() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.impl_mark_all_notifications_read();
END;
$$;

REVOKE ALL ON FUNCTION public.mark_all_notifications_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated, service_role;

-- 7. Trigger on listing_status_transitions to generate moderation notifications
CREATE OR REPLACE FUNCTION public.trg_fn_listing_transition_notification()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid;
  v_listing_title text;
  v_slug text;
BEGIN
  -- Retrieve seller and title
  SELECT seller_id, title, slug INTO v_seller_id, v_listing_title, v_slug
  FROM public.listings
  WHERE id = NEW.listing_id;

  IF v_seller_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 1. Listing approved (pending_review -> active)
  IF NEW.from_status = 'pending_review' AND NEW.to_status = 'active' THEN
    PERFORM app_security.create_notification(
      v_seller_id,
      'listing_approved',
      'Listing Approved',
      'Your listing "' || v_listing_title || '" has been approved and is now live.',
      '/listings/' || COALESCE(v_slug, NEW.listing_id::text)
    );
  END IF;

  -- 2. Listing rejected (pending_review -> rejected)
  IF NEW.from_status = 'pending_review' AND NEW.to_status = 'rejected' THEN
    PERFORM app_security.create_notification(
      v_seller_id,
      'listing_rejected',
      'Listing Needs Attention',
      'Your listing "' || v_listing_title || '" was not approved: ' || COALESCE(NEW.reason, 'Moderation requirements not met.'),
      '/account/listings'
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_status_transition_notifications
AFTER INSERT ON public.listing_status_transitions
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_listing_transition_notification();

-- 8. Add notifications to Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
