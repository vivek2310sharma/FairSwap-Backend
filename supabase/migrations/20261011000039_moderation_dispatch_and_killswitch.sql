-- =============================================================================
-- Migration 39: Moderation Dispatch Runtime, Vault Configuration & Kill Switch
-- =============================================================================
-- Configures pg_net asynchronous notification trigger and scheduled retry runner.
-- Provides backend-controlled activation switch (moderation_automation_enabled).
-- Default is false for safe hosted rollout; explicitly enabled in local validation.
-- Registers canonical pg_cron job for queue retries and stale lease recovery.
-- =============================================================================

-- 1. Create table for system configuration if not existing
CREATE TABLE IF NOT EXISTS public.app_system_settings (
  setting_key text PRIMARY KEY,
  setting_value text NOT NULL,
  description text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.app_system_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_system_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.app_system_settings TO service_role;

-- Initialize automation kill switch to false (disabled by default for production safety)
INSERT INTO public.app_system_settings (setting_key, setting_value, description)
VALUES ('moderation_automation_enabled', 'false', 'Kill switch for automatic moderation publication')
ON CONFLICT (setting_key) DO NOTHING;

-- 2. Immediate Dispatch Trigger Function using pg_net (Fail-Safe)
CREATE OR REPLACE FUNCTION app_security.trg_fn_notify_moderation_worker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
BEGIN
  -- Immediate dispatch is best-effort asynchronous notification.
  -- Under NO circumstances should an exception here roll back the authoritative
  -- submission transaction or the request insertion.
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'moderation_worker_url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'moderation_worker_secret'
    LIMIT 1;

    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-moderation-worker-secret', v_secret
        ),
        body := jsonb_build_object(
          'record', jsonb_build_object('id', NEW.id, 'listing_id', NEW.listing_id)
        )
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'Immediate moderation dispatch failed for request %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_moderation_request_immediate_dispatch ON public.listing_moderation_requests;
CREATE TRIGGER trg_moderation_request_immediate_dispatch
AFTER INSERT ON public.listing_moderation_requests
FOR EACH ROW
EXECUTE FUNCTION app_security.trg_fn_notify_moderation_worker();

-- 3. Scheduled Retry and Stale Lease Recovery Runner
CREATE OR REPLACE FUNCTION app_security.invoke_moderation_retry_batch()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_url text;
  v_secret text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  -- 1. Reclaim expired leases in database directly, bounded by max_attempts
  -- For requests whose attempt_count already reached max_attempts, fail, record evidence, and escalate
  WITH expired_terminal AS (
    UPDATE public.listing_moderation_requests
    SET status = 'failed'::public.moderation_request_status,
        claim_token = NULL,
        updated_at = v_now
    WHERE status = 'claimed'
      AND claim_expires_at < v_now
      AND attempt_count >= max_attempts
    RETURNING id, listing_id, listing_revision, generation_id, attempt_count
  )
  INSERT INTO public.listing_moderation_results (
    request_id, listing_id, listing_revision, generation_id, outcome,
    ruleset_version, scope, completed_rules, failed_rules, flags, errors, decision
  )
  SELECT
    et.id, et.listing_id, et.listing_revision, et.generation_id,
    'checks_incomplete'::public.moderation_outcome_enum,
    'prototype_v0.1.1', 'title_description', ARRAY[]::text[], ARRAY[]::text[],
    '[]'::jsonb, jsonb_build_array(jsonb_build_object('error', 'LEASE_EXPIRED_ABANDONED', 'attempts', et.attempt_count)),
    'escalated_to_admin'::public.moderation_decision_state
  FROM expired_terminal et;

  -- For requests under max_attempts, return to retry status with exponential backoff
  UPDATE public.listing_moderation_requests
  SET status = 'retry'::public.moderation_request_status,
      claim_token = NULL,
      next_attempt_at = v_now + (POWER(2, attempt_count) * INTERVAL '5 seconds'),
      updated_at = v_now
  WHERE status = 'claimed'
    AND claim_expires_at < v_now
    AND attempt_count < max_attempts;

  -- 2. Dispatch batch execution to Edge Worker if configured in vault
  BEGIN
    SELECT decrypted_secret INTO v_url
    FROM vault.decrypted_secrets
    WHERE name = 'moderation_worker_url'
    LIMIT 1;

    SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
    WHERE name = 'moderation_worker_secret'
    LIMIT 1;

    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-moderation-worker-secret', v_secret
        ),
        body := jsonb_build_object('batch', true)
      );
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'Scheduled moderation retry batch dispatch failed: %', SQLERRM;
  END;
END;
$$;

REVOKE ALL ON FUNCTION app_security.invoke_moderation_retry_batch() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.invoke_moderation_retry_batch() TO service_role;

-- 4. Converge Canonical pg_cron Scheduled Job
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-moderation-queue-retries') THEN
      PERFORM cron.unschedule('process-moderation-queue-retries');
    END IF;

    PERFORM cron.schedule(
      'process-moderation-queue-retries',
      '*/2 * * * *',
      'SELECT app_security.invoke_moderation_retry_batch();'
    );
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule registration skipped or not supported in this environment: %', SQLERRM;
END $$;
