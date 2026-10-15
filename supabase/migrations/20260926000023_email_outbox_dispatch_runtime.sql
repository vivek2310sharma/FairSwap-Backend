-- Migration 23: Codify Email Outbox Immediate Dispatch and Retry Scheduler Runtime
-- Description:
-- Provisions the environment-portable database-side dispatch runtime for FairSwap Issue #83:
-- 1. app_security.trg_fn_notify_email_outbox_worker(): Immediate asynchronous dispatch trigger function using pg_net.
--    - Retrieves endpoint URL ('email_outbox_worker_url') and worker secret ('email_worker_secret') from Supabase Vault.
--    - Fail-safe: Catches all dispatch exceptions to guarantee authoritative listing transitions never roll back.
-- 2. public.trg_email_outbox_immediate_dispatch: Trigger on public.email_outbox AFTER INSERT.
-- 3. app_security.invoke_email_outbox_retry_batch(): Scheduled batch runner for retries and stale-lease recovery.
--    - Retrieves endpoint URL and secret from Vault and posts '{}'::jsonb to the Edge Function.
-- 4. cron.job 'process-email-outbox-retries': Canonical 5-minute schedule calling app_security.invoke_email_outbox_retry_batch().
--    - Contains no plaintext secrets or project-specific URLs in cron.job.command.

-- ============================================================================
-- 1. Immediate Dispatch Trigger Function (Fail-Safe, SECURITY DEFINER)
-- ============================================================================

CREATE OR REPLACE FUNCTION app_security.trg_fn_notify_email_outbox_worker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  -- Immediate dispatch is best-effort downstream notification infrastructure.
  -- Under NO circumstances should an exception here roll back the authoritative
  -- listing transition or the public.email_outbox insert.
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'email_outbox_worker_url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'email_worker_secret'
    LIMIT 1;

    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-email-worker-secret', v_secret
        ),
        body := jsonb_build_object(
          'record', jsonb_build_object('id', NEW.id)
        )
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      -- Log warning safely without re-throwing, allowing parent transaction to commit.
      -- The recurring 5-minute retry scheduler will claim and process pending jobs.
      RAISE WARNING 'Immediate email outbox dispatch failed for job %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

-- Secure execution permissions
REVOKE ALL ON FUNCTION app_security.trg_fn_notify_email_outbox_worker() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.trg_fn_notify_email_outbox_worker() TO service_role;

-- Attach trigger to public.email_outbox
DROP TRIGGER IF EXISTS trg_email_outbox_immediate_dispatch ON public.email_outbox;
CREATE TRIGGER trg_email_outbox_immediate_dispatch
  AFTER INSERT ON public.email_outbox
  FOR EACH ROW
  EXECUTE FUNCTION app_security.trg_fn_notify_email_outbox_worker();

-- ============================================================================
-- 2. Retry Scheduler Batch Invoker Function (SECURITY DEFINER)
-- ============================================================================

CREATE OR REPLACE FUNCTION app_security.invoke_email_outbox_retry_batch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'email_outbox_worker_url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'email_worker_secret'
    LIMIT 1;

    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-email-worker-secret', v_secret
        ),
        body := '{}'::jsonb
      );
    ELSE
      RAISE WARNING 'Email outbox retry batch skipped: email_outbox_worker_url or email_worker_secret missing in Vault';
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'Email outbox retry batch invocation failed: %', SQLERRM;
  END;
END;
$$;

-- Secure execution permissions
REVOKE ALL ON FUNCTION app_security.invoke_email_outbox_retry_batch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.invoke_email_outbox_retry_batch() TO postgres, service_role;

-- ============================================================================
-- 3. Canonical pg_cron Retry Job
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-outbox-retries') THEN
      PERFORM cron.unschedule('process-email-outbox-retries');
    END IF;

    PERFORM cron.schedule(
      'process-email-outbox-retries',
      '*/5 * * * *',
      'SELECT app_security.invoke_email_outbox_retry_batch();'
    );
  END IF;
END $$;
