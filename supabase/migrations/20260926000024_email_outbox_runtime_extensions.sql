-- Migration 24: Ensure Email Outbox Dispatch Runtime Extensions and Scheduler Convergence
-- Description:
-- 1. Enables required PostgreSQL extensions for the FairSwap transactional email runtime:
--    - pg_net: Asynchronous HTTP client for immediate trigger-based dispatch and scheduled batch execution
--    - pg_cron: Periodic job scheduler for retry recovery and stale-lease reclamation
--    - supabase_vault: Encrypted secret storage for worker URLs and authentication credentials
-- 2. Validates runtime capabilities:
--    - Fails immediately with clear diagnostic errors if any indispensable capability is unavailable.
-- 3. Converges canonical 5-minute scheduler job:
--    - Unschedule existing 'process-email-outbox-retries' if present.
--    - Schedules canonical 'SELECT app_security.invoke_email_outbox_retry_batch();' with '*/5 * * * *'.
--    - Guarantees zero secrets and zero project-specific URLs in cron.job.command.

-- ============================================================================
-- 1. Enable Required Runtime Extensions
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS supabase_vault CASCADE;

-- ============================================================================
-- 2. Verify Indispensable Runtime Capabilities
-- ============================================================================

DO $$
BEGIN
  -- Verify pg_net capability: net.http_post
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'http_post' AND pronamespace = 'net'::regnamespace
  ) THEN
    RAISE EXCEPTION 'Required extension pg_net is missing or net.http_post is not available';
  END IF;

  -- Verify pg_cron capabilities: cron.schedule and cron.unschedule
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'schedule' AND pronamespace = 'cron'::regnamespace
  ) THEN
    RAISE EXCEPTION 'Required extension pg_cron is missing or cron.schedule is not available';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'unschedule' AND pronamespace = 'cron'::regnamespace
  ) THEN
    RAISE EXCEPTION 'Required extension pg_cron is missing or cron.unschedule is not available';
  END IF;

  -- Verify Supabase Vault capabilities: vault.decrypted_secrets and vault.create_secret
  IF to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'Required Supabase Vault view vault.decrypted_secrets is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'create_secret' AND pronamespace = 'vault'::regnamespace
  ) THEN
    RAISE EXCEPTION 'Required Supabase Vault function vault.create_secret is not available';
  END IF;
END $$;

-- ============================================================================
-- 3. Converge Canonical Scheduler Job
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-outbox-retries') THEN
    PERFORM cron.unschedule('process-email-outbox-retries');
  END IF;

  PERFORM cron.schedule(
    'process-email-outbox-retries',
    '*/5 * * * *',
    'SELECT app_security.invoke_email_outbox_retry_batch();'
  );
END $$;
