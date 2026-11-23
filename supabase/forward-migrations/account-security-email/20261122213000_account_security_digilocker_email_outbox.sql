-- Migration: 20261122213000_account_security_digilocker_email_outbox.sql
-- Description:
-- Additive forward-only migration for FairSwap account-security DigiLocker email delivery.
-- Automatically queues the approved account-security notice exactly once after a new user's
-- signup email is confirmed.
--
-- Safeguards:
-- 1. Narrow, dedicated table public.security_email_outbox avoiding foreign-key collisions
--    or invalid listing references on public.email_outbox.
-- 2. Strictly idempotent: UNIQUE (recipient_user_id, event_type).
-- 3. Zero network calls inside auth.users confirmation transaction. Pure asynchronous outbox.
-- 4. Fail-closed RLS: accessible solely by service_role.
-- 5. Hardened functions in app_security with empty search_path, explicit column grants.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ============================================================================
-- 1. Table: public.security_email_outbox
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.security_email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.email_outbox_status NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
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
  CONSTRAINT uq_security_email_outbox_user_event UNIQUE (recipient_user_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_security_email_outbox_claim 
  ON public.security_email_outbox (status, next_attempt_at) 
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_security_email_outbox_recipient 
  ON public.security_email_outbox (recipient_user_id);

CREATE INDEX IF NOT EXISTS idx_security_email_outbox_locked_at 
  ON public.security_email_outbox (locked_at) 
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_security_email_outbox_provider_msg_id 
  ON public.security_email_outbox (provider_message_id) 
  WHERE provider_message_id IS NOT NULL;

-- Enable and force Row Level Security
ALTER TABLE public.security_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_email_outbox FORCE ROW LEVEL SECURITY;

REVOKE ALL ON public.security_email_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.security_email_outbox TO service_role;

DROP POLICY IF EXISTS security_email_outbox_service_role_policy ON public.security_email_outbox;
CREATE POLICY security_email_outbox_service_role_policy ON public.security_email_outbox
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- 2. Worker RPCs for security_email_outbox
-- ============================================================================

-- 2a. Atomically claim batch
CREATE OR REPLACE FUNCTION app_security.impl_claim_security_email_outbox_batch(
  p_batch_size integer,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.security_email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max_attempts CONSTANT integer := 5;
BEGIN
  -- Reclaim stale processing jobs exceeding max_attempts
  UPDATE public.security_email_outbox
  SET status = 'dead_letter'::public.email_outbox_status,
      locked_at = NULL,
      lock_token = NULL,
      last_error_code = 'MAX_ATTEMPTS_EXCEEDED_IN_PROCESSING',
      last_error_message = 'Security email job exhausted maximum attempts during crash recovery',
      updated_at = clock_timestamp()
  WHERE status = 'processing'
    AND locked_at < clock_timestamp() - (p_stale_timeout_seconds || ' seconds')::interval
    AND attempt_count >= v_max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.security_email_outbox
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
  UPDATE public.security_email_outbox o
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

REVOKE ALL ON FUNCTION app_security.impl_claim_security_email_outbox_batch(integer, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_claim_security_email_outbox_batch(integer, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_security_email_outbox_batch(
  p_batch_size integer,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.security_email_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM app_security.impl_claim_security_email_outbox_batch(
    p_batch_size,
    p_lock_token,
    p_stale_timeout_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_security_email_outbox_batch(integer, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_security_email_outbox_batch(integer, uuid, integer) TO service_role;

-- 2b. Atomically claim single job by ID
CREATE OR REPLACE FUNCTION app_security.impl_claim_security_email_outbox_job_by_id(
  p_job_id uuid,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.security_email_outbox
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_max_attempts CONSTANT integer := 5;
BEGIN
  UPDATE public.security_email_outbox
  SET status = 'dead_letter'::public.email_outbox_status,
      locked_at = NULL,
      lock_token = NULL,
      last_error_code = 'MAX_ATTEMPTS_EXCEEDED_IN_PROCESSING',
      last_error_message = 'Security email job exhausted maximum attempts during crash recovery',
      updated_at = clock_timestamp()
  WHERE id = p_job_id
    AND status = 'processing'
    AND locked_at < clock_timestamp() - (p_stale_timeout_seconds || ' seconds')::interval
    AND attempt_count >= v_max_attempts;

  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.security_email_outbox
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
  UPDATE public.security_email_outbox o
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

REVOKE ALL ON FUNCTION app_security.impl_claim_security_email_outbox_job_by_id(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_claim_security_email_outbox_job_by_id(uuid, uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_security_email_outbox_job_by_id(
  p_job_id uuid,
  p_lock_token uuid,
  p_stale_timeout_seconds integer DEFAULT 600
)
RETURNS SETOF public.security_email_outbox
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM app_security.impl_claim_security_email_outbox_job_by_id(
    p_job_id,
    p_lock_token,
    p_stale_timeout_seconds
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_security_email_outbox_job_by_id(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_security_email_outbox_job_by_id(uuid, uuid, integer) TO service_role;

-- 2c. Complete security email job
CREATE OR REPLACE FUNCTION app_security.impl_complete_security_email_outbox_job(
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
  UPDATE public.security_email_outbox
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

REVOKE ALL ON FUNCTION app_security.impl_complete_security_email_outbox_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_complete_security_email_outbox_job(uuid, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.complete_security_email_outbox_job(
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
  RETURN app_security.impl_complete_security_email_outbox_job(
    p_job_id,
    p_lock_token,
    p_provider_message_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_security_email_outbox_job(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_security_email_outbox_job(uuid, uuid, text) TO service_role;

-- 2d. Fail security email job
CREATE OR REPLACE FUNCTION app_security.impl_fail_security_email_outbox_job(
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
  UPDATE public.security_email_outbox
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

REVOKE ALL ON FUNCTION app_security.impl_fail_security_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_fail_security_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_security_email_outbox_job(
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
  RETURN app_security.impl_fail_security_email_outbox_job(
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

REVOKE ALL ON FUNCTION public.fail_security_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_security_email_outbox_job(uuid, uuid, text, integer, text, boolean, integer, integer) TO service_role;

-- ============================================================================
-- 3. Trigger Function & Trigger on auth.users for signup email confirmation
-- ============================================================================

CREATE OR REPLACE FUNCTION app_security.trg_fn_enqueue_signup_security_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authoritative trigger: Fire exactly when email is confirmed for the first time
  -- Ignore sign-in OTP, repeat callback, routine login, and existing users
  IF OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL THEN
    INSERT INTO public.security_email_outbox (
      event_type,
      recipient_user_id,
      payload
    ) VALUES (
      'account_security_digilocker',
      NEW.id,
      jsonb_build_object(
        'user_id', NEW.id,
        'email_type', 'account_security_digilocker'
      )
    ) ON CONFLICT (recipient_user_id, event_type) DO NOTHING;
  END IF;

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    -- Fail safe: Under NO circumstances should notification failure block user confirmation
    RAISE WARNING 'Security email enqueue failed for user %: %', NEW.id, SQLERRM;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_security.trg_fn_enqueue_signup_security_email() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.trg_fn_enqueue_signup_security_email() TO postgres, service_role;

DROP TRIGGER IF EXISTS trg_auth_user_signup_security_email ON auth.users;
CREATE TRIGGER trg_auth_user_signup_security_email
AFTER UPDATE ON auth.users
FOR EACH ROW
WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
EXECUTE FUNCTION app_security.trg_fn_enqueue_signup_security_email();

commit;