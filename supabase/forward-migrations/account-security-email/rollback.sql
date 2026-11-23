-- Rollback (Deactivation Plan): 20261122213000_account_security_digilocker_email_outbox.sql
-- Safe, non-destructive deactivation:
-- 1. Disables the signup trigger on auth.users so no new security notice jobs are enqueued.
-- 2. Preserves public.security_email_outbox table, delivery history, and audit ledger.
-- 3. Preserves worker RPCs so already-queued in-flight jobs can finish draining without crash.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Disable trigger to immediately halt new job enqueueing
DROP TRIGGER IF EXISTS trg_auth_user_signup_security_email ON auth.users;
DROP FUNCTION IF EXISTS app_security.trg_fn_enqueue_signup_security_email();

commit;