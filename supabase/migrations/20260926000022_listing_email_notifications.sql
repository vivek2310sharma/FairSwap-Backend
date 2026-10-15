-- Migration 22: 20260926000022_listing_email_notifications.sql
-- Durable transactional email outbox, listing transition trigger, and worker RPCs for Issue #83

-- 1. Create Enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'email_outbox_event_type') THEN
    CREATE TYPE public.email_outbox_event_type AS ENUM (
      'listing_submitted_for_review',
      'listing_approved',
      'listing_rejected'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'email_outbox_status') THEN
    CREATE TYPE public.email_outbox_status AS ENUM (
      'pending',
      'processing',
      'retry',
      'sent',
      'dead_letter'
    );
  END IF;
END $$;

-- 2. Create public.email_outbox
CREATE TABLE IF NOT EXISTS public.email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type public.email_outbox_event_type NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  transition_id uuid NOT NULL REFERENCES public.listing_status_transitions(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.email_outbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  locked_at timestamptz,
  lock_token uuid,
  provider_message_id text,
  last_error_code text,
  last_error_status integer,
  last_error_message text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Idempotency constraint: same transition cannot create duplicate email messages for the same user
  CONSTRAINT uq_email_outbox_transition_event_recipient UNIQUE (transition_id, event_type, recipient_user_id)
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_email_outbox_claim ON public.email_outbox (status, next_attempt_at) WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_email_outbox_listing_id ON public.email_outbox (listing_id);
CREATE INDEX IF NOT EXISTS idx_email_outbox_recipient ON public.email_outbox (recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_email_outbox_transition_id ON public.email_outbox (transition_id);
CREATE INDEX IF NOT EXISTS idx_email_outbox_locked_at ON public.email_outbox (locked_at) WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_email_outbox_provider_msg_id ON public.email_outbox (provider_message_id) WHERE provider_message_id IS NOT NULL;

-- 4. Row Level Security & Fail-Closed Privileges
ALTER TABLE public.email_outbox ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.email_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.email_outbox TO service_role;

DROP POLICY IF EXISTS email_outbox_service_role_policy ON public.email_outbox;
CREATE POLICY email_outbox_service_role_policy ON public.email_outbox
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. Trigger Function on listing_status_transitions to enqueue transactional emails
CREATE OR REPLACE FUNCTION app_security.trg_fn_enqueue_listing_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_seller_id uuid;
  v_listing_title text;
  v_slug text;
  v_email_enabled boolean;
  v_approver RECORD;
BEGIN
  -- Resolve listing details
  SELECT seller_id, title, slug
  INTO v_seller_id, v_listing_title, v_slug
  FROM public.listings
  WHERE id = NEW.listing_id;

  IF v_seller_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Rule 1: Listing awaiting moderation (transitions into pending_review)
  IF NEW.to_status = 'pending_review' THEN
    -- Enqueue notification for all active staff whose role is administrator or moderator.
    -- Exclude support_agent / content_editor, and exclude the seller if they happen to be staff (self-review prohibited).
    FOR v_approver IN
      SELECT sr.user_id
      FROM public.staff_roles sr
      JOIN public.user_accounts ua ON ua.user_id = sr.user_id
      WHERE sr.role IN ('administrator', 'moderator')
        AND ua.account_status = 'active'
        AND sr.user_id != v_seller_id
    LOOP
      INSERT INTO public.email_outbox (
        event_type,
        recipient_user_id,
        listing_id,
        transition_id,
        payload
      ) VALUES (
        'listing_submitted_for_review',
        v_approver.user_id,
        NEW.listing_id,
        NEW.id,
        jsonb_build_object(
          'listing_title', v_listing_title,
          'listing_slug', v_slug,
          'revision', NEW.revision_at_transition,
          'link_path', '/admin/listings/' || NEW.listing_id::text
        )
      ) ON CONFLICT (transition_id, event_type, recipient_user_id) DO NOTHING;
    END LOOP;
  END IF;

  -- Rule 2: Listing approved (pending_review -> active)
  IF NEW.from_status = 'pending_review' AND NEW.to_status = 'active' THEN
    SELECT CASE
      WHEN notification_preferences->'email_notifications' = 'false'::jsonb THEN false
      WHEN notification_preferences->'email_notifications' = 'true'::jsonb THEN true
      WHEN notification_preferences IS NULL 
        OR notification_preferences->'email_notifications' IS NULL 
        OR jsonb_typeof(notification_preferences->'email_notifications') = 'null' THEN true
      ELSE false
    END
    INTO v_email_enabled
    FROM public.user_accounts
    WHERE user_id = v_seller_id;

    IF v_email_enabled IS NULL THEN
      v_email_enabled := true;
    END IF;

    IF v_email_enabled IS TRUE THEN
      INSERT INTO public.email_outbox (
        event_type,
        recipient_user_id,
        listing_id,
        transition_id,
        payload
      ) VALUES (
        'listing_approved',
        v_seller_id,
        NEW.listing_id,
        NEW.id,
        jsonb_build_object(
          'listing_title', v_listing_title,
          'listing_slug', v_slug,
          'revision', NEW.revision_at_transition,
          'link_path', '/listings/' || COALESCE(v_slug, NEW.listing_id::text)
        )
      ) ON CONFLICT (transition_id, event_type, recipient_user_id) DO NOTHING;
    END IF;
  END IF;

  -- Rule 3: Listing rejected (pending_review -> rejected)
  IF NEW.from_status = 'pending_review' AND NEW.to_status = 'rejected' THEN
    SELECT CASE
      WHEN notification_preferences->'email_notifications' = 'false'::jsonb THEN false
      WHEN notification_preferences->'email_notifications' = 'true'::jsonb THEN true
      WHEN notification_preferences IS NULL 
        OR notification_preferences->'email_notifications' IS NULL 
        OR jsonb_typeof(notification_preferences->'email_notifications') = 'null' THEN true
      ELSE false
    END
    INTO v_email_enabled
    FROM public.user_accounts
    WHERE user_id = v_seller_id;

    IF v_email_enabled IS NULL THEN
      v_email_enabled := true;
    END IF;

    IF v_email_enabled IS TRUE THEN
      INSERT INTO public.email_outbox (
        event_type,
        recipient_user_id,
        listing_id,
        transition_id,
        payload
      ) VALUES (
        'listing_rejected',
        v_seller_id,
        NEW.listing_id,
        NEW.id,
        jsonb_build_object(
          'listing_title', v_listing_title,
          'listing_slug', v_slug,
          'revision', NEW.revision_at_transition,
          'rejection_reason', COALESCE(NEW.reason, 'Moderation requirements not met.'),
          'link_path', '/account/listings/' || NEW.listing_id::text || '/edit'
        )
      ) ON CONFLICT (transition_id, event_type, recipient_user_id) DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_security.trg_fn_enqueue_listing_email() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.trg_fn_enqueue_listing_email() TO service_role;

DROP TRIGGER IF EXISTS trg_email_outbox_listing_transition ON public.listing_status_transitions;
CREATE TRIGGER trg_email_outbox_listing_transition
AFTER INSERT ON public.listing_status_transitions
FOR EACH ROW
EXECUTE FUNCTION app_security.trg_fn_enqueue_listing_email();

-- 6a. Private implementation: Atomically Claim Batch of Email Jobs
CREATE OR REPLACE FUNCTION app_security.impl_claim_email_outbox_batch(
  p_batch_size integer,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max_attempts CONSTANT integer := 5;
BEGIN
  -- Reclaim safety: transition stale processing jobs that exhausted max_attempts to dead_letter
  UPDATE public.email_outbox
  SET status = 'dead_letter'::public.email_outbox_status,
      locked_at = NULL,
      lock_token = NULL,
      last_error_code = 'MAX_ATTEMPTS_EXCEEDED_IN_PROCESSING',
      last_error_message = 'Job exhausted maximum attempts during crash recovery',
      updated_at = clock_timestamp()
  WHERE status = 'processing'
    AND locked_at < clock_timestamp() - (p_stale_timeout_seconds || ' seconds')::interval
    AND attempt_count >= v_max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.email_outbox
    WHERE attempt_count < v_max_attempts
      AND (
        (
          status IN ('pending', 'retry')
          AND next_attempt_at <= clock_timestamp()
        ) OR (
          status = 'processing'
          AND locked_at < clock_timestamp() - (p_stale_timeout_seconds || ' seconds')::interval
        )
      )
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_outbox o
  SET status = 'processing'::public.email_outbox_status,
      locked_at = clock_timestamp(),
      lock_token = p_lock_token,
      attempt_count = o.attempt_count + 1,
      updated_at = clock_timestamp()
  FROM claimable
  WHERE o.id = claimable.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_claim_email_outbox_batch(integer, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_claim_email_outbox_batch(integer, uuid, integer) TO service_role;

-- 6b. Public wrapper: Atomically Claim Batch of Email Jobs
CREATE OR REPLACE FUNCTION public.claim_email_outbox_batch(
  p_batch_size integer,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.email_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM app_security.impl_claim_email_outbox_batch(
    p_batch_size,
    p_lock_token,
    p_stale_timeout_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_email_outbox_batch(integer, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox_batch(integer, uuid, integer) TO service_role;

-- 7a. Private implementation: Atomically Claim a Single Email Job by ID
CREATE OR REPLACE FUNCTION app_security.impl_claim_email_outbox_job_by_id(
  p_job_id uuid,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max_attempts CONSTANT integer := 5;
BEGIN
  -- Reclaim safety: transition target job if it is stale and exhausted max_attempts
  UPDATE public.email_outbox
  SET status = 'dead_letter'::public.email_outbox_status,
      locked_at = NULL,
      lock_token = NULL,
      last_error_code = 'MAX_ATTEMPTS_EXCEEDED_IN_PROCESSING',
      last_error_message = 'Job exhausted maximum attempts during crash recovery',
      updated_at = clock_timestamp()
  WHERE id = p_job_id
    AND status = 'processing'
    AND locked_at < clock_timestamp() - (p_stale_timeout_seconds || ' seconds')::interval
    AND attempt_count >= v_max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.email_outbox
    WHERE id = p_job_id
      AND attempt_count < v_max_attempts
      AND (
        (
          status IN ('pending', 'retry')
          AND next_attempt_at <= clock_timestamp()
        ) OR (
          status = 'processing'
          AND locked_at < clock_timestamp() - (p_stale_timeout_seconds || ' seconds')::interval
        )
      )
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.email_outbox o
  SET status = 'processing'::public.email_outbox_status,
      locked_at = clock_timestamp(),
      lock_token = p_lock_token,
      attempt_count = o.attempt_count + 1,
      updated_at = clock_timestamp()
  FROM claimable
  WHERE o.id = claimable.id
  RETURNING o.*;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_claim_email_outbox_job_by_id(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_claim_email_outbox_job_by_id(uuid, uuid, integer) TO service_role;

-- 7b. Public wrapper: Atomically Claim a Single Email Job by ID
CREATE OR REPLACE FUNCTION public.claim_email_outbox_job_by_id(
  p_job_id uuid,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.email_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM app_security.impl_claim_email_outbox_job_by_id(
    p_job_id,
    p_lock_token,
    p_stale_timeout_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_email_outbox_job_by_id(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_email_outbox_job_by_id(uuid, uuid, integer) TO service_role;

-- 8a. Private implementation: Complete an Email Job
CREATE OR REPLACE FUNCTION app_security.impl_complete_email_outbox_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.email_outbox
  SET status = 'sent'::public.email_outbox_status,
      locked_at = NULL,
      lock_token = NULL,
      provider_message_id = p_provider_message_id,
      sent_at = clock_timestamp(),
      updated_at = clock_timestamp()
  WHERE id = p_job_id AND lock_token = p_lock_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_complete_email_outbox_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_complete_email_outbox_job(uuid, uuid, text) TO service_role;

-- 8b. Public wrapper: Complete an Email Job
CREATE OR REPLACE FUNCTION public.complete_email_outbox_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_provider_message_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_complete_email_outbox_job(
    p_job_id,
    p_lock_token,
    p_provider_message_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_email_outbox_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_email_outbox_job(uuid, uuid, text) TO service_role;

-- 9a. Private implementation: Fail an Email Job
CREATE OR REPLACE FUNCTION app_security.impl_fail_email_outbox_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_error_status integer,
  p_error_message text,
  p_is_permanent boolean,
  p_max_attempts integer DEFAULT 5,
  p_backoff_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_updated integer;
BEGIN
  UPDATE public.email_outbox
  SET status = CASE
        WHEN p_is_permanent OR attempt_count >= p_max_attempts THEN 'dead_letter'::public.email_outbox_status
        ELSE 'retry'::public.email_outbox_status
      END,
      locked_at = NULL,
      lock_token = NULL,
      last_error_code = p_error_code,
      last_error_status = p_error_status,
      last_error_message = p_error_message,
      next_attempt_at = CASE
        WHEN p_is_permanent OR attempt_count >= p_max_attempts THEN next_attempt_at
        ELSE clock_timestamp() + (p_backoff_seconds || ' seconds')::interval
      END,
      updated_at = clock_timestamp()
  WHERE id = p_job_id AND lock_token = p_lock_token;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_fail_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_fail_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) TO service_role;

-- 9b. Public wrapper: Fail an Email Job
CREATE OR REPLACE FUNCTION public.fail_email_outbox_job(
  p_job_id uuid,
  p_lock_token uuid,
  p_error_code text,
  p_error_status integer,
  p_error_message text,
  p_is_permanent boolean,
  p_max_attempts integer DEFAULT 5,
  p_backoff_seconds integer DEFAULT 60
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN app_security.impl_fail_email_outbox_job(
    p_job_id,
    p_lock_token,
    p_error_code,
    p_error_status,
    p_error_message,
    p_is_permanent,
    p_max_attempts,
    p_backoff_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fail_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) TO service_role;
