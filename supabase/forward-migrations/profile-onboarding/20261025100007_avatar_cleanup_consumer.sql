-- Avatar cleanup consumer contract. The queue (20261025100005) is only a retry safety net:
-- the Web route deletes replaced/removed objects directly, and a service-role drainer calls
-- these RPCs to (re)try anything left behind (failed deletes, deleted accounts, hard-deleted
-- auth users). All consumer RPCs are service_role only, idempotent, lease-based
-- (FOR UPDATE SKIP LOCKED) and validate path shape before it can ever reach Storage.
-- Additive only; forced RLS stays on the queue.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

ALTER TABLE public.avatar_cleanup_queue
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  ADD COLUMN IF NOT EXISTS locked_until timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS dead_lettered_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS avatar_cleanup_queue_id_key ON public.avatar_cleanup_queue (id);
CREATE INDEX IF NOT EXISTS avatar_cleanup_queue_pending_idx
  ON public.avatar_cleanup_queue (next_attempt_at)
  WHERE completed_at IS NULL AND dead_lettered_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conname = 'chk_avatar_cleanup_queue_path'
      AND conrelid = 'public.avatar_cleanup_queue'::regclass
  ) THEN
    ALTER TABLE public.avatar_cleanup_queue
      ADD CONSTRAINT chk_avatar_cleanup_queue_path
      CHECK (path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8,64}\.webp$');
  END IF;
END
$$;

-- FORCE RLS applies to the table owner unless it has BYPASSRLS. Definer functions rely on the
-- owner (postgres) bypass, which the pgTAP suite asserts. service_role gets explicit,
-- narrow policies so direct reads/deletes also work where service_role lacks BYPASSRLS.
DROP POLICY IF EXISTS avatar_cleanup_queue_service_select ON public.avatar_cleanup_queue;
CREATE POLICY avatar_cleanup_queue_service_select ON public.avatar_cleanup_queue
  FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS avatar_cleanup_queue_service_delete ON public.avatar_cleanup_queue;
CREATE POLICY avatar_cleanup_queue_service_delete ON public.avatar_cleanup_queue
  FOR DELETE TO service_role USING (true);

-- ---------------------------------------------------------------------------
-- Hard-deleted auth users cascade their profile away; queue the object first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_avatar_on_profile_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.avatar_path IS NOT NULL THEN
    INSERT INTO public.avatar_cleanup_queue (path, user_id, reason)
    VALUES (OLD.avatar_path, OLD.id, 'profile_deleted')
    ON CONFLICT (path) DO NOTHING;
  END IF;
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_avatar_on_profile_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_avatar_cleanup ON public.profiles;
CREATE TRIGGER trg_profiles_avatar_cleanup
AFTER DELETE ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.enqueue_avatar_on_profile_delete();

-- ---------------------------------------------------------------------------
-- service_claim_avatar_cleanup(p_limit, p_lease_seconds) -> {success, items:[{id,bucket,path}]}
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_claim_avatar_cleanup(
  p_limit integer,
  p_lease_seconds integer
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 25), 1), 100);
  v_lease integer := LEAST(GREATEST(COALESCE(p_lease_seconds, 300), 30), 3600);
  v_items jsonb;
BEGIN
  -- Service-role context only (auth.uid() is NULL for the service key).
  IF auth.uid() IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;

  -- Never delete an object that is some profile's live avatar.
  UPDATE public.avatar_cleanup_queue q
  SET completed_at = v_now, locked_until = NULL, last_error = 'STILL_REFERENCED'
  WHERE q.completed_at IS NULL AND q.dead_lettered_at IS NULL
    AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.avatar_path = q.path);

  -- Rows whose attempts are exhausted (including crashed workers) are dead-lettered.
  UPDATE public.avatar_cleanup_queue q
  SET dead_lettered_at = v_now, locked_until = NULL,
      last_error = COALESCE(q.last_error, 'MAX_ATTEMPTS')
  WHERE q.completed_at IS NULL AND q.dead_lettered_at IS NULL
    AND q.attempts >= 8
    AND (q.locked_until IS NULL OR q.locked_until < v_now);

  DELETE FROM public.avatar_cleanup_queue
  WHERE completed_at IS NOT NULL AND completed_at < v_now - interval '30 days';

  WITH picked AS (
    SELECT q.id
    FROM public.avatar_cleanup_queue q
    WHERE q.completed_at IS NULL AND q.dead_lettered_at IS NULL
      AND q.attempts < 8
      AND q.next_attempt_at <= v_now
      AND (q.locked_until IS NULL OR q.locked_until < v_now)
    ORDER BY q.next_attempt_at, q.queued_at
    LIMIT v_limit
    FOR UPDATE SKIP LOCKED
  ), upd AS (
    UPDATE public.avatar_cleanup_queue q
    SET attempts = q.attempts + 1,
        locked_until = v_now + pg_catalog.make_interval(secs => v_lease)
    FROM picked
    WHERE q.id = picked.id
    RETURNING q.id, q.path
  )
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', upd.id, 'bucket', 'avatars', 'path', upd.path)), '[]'::jsonb)
  INTO v_items FROM upd;

  RETURN pg_catalog.jsonb_build_object('success', true, 'items', v_items);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_claim_avatar_cleanup(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_claim_avatar_cleanup(integer, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.service_claim_avatar_cleanup(
  p_limit integer DEFAULT 25,
  p_lease_seconds integer DEFAULT 300
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_claim_avatar_cleanup(p_limit, p_lease_seconds) $$;
REVOKE ALL ON FUNCTION public.service_claim_avatar_cleanup(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_claim_avatar_cleanup(integer, integer) TO service_role;

-- ---------------------------------------------------------------------------
-- service_complete_avatar_cleanup(p_ids) -> {success, completed}  (idempotent)
-- Call after Storage reports the object deleted (or already gone).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_complete_avatar_cleanup(p_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;
  UPDATE public.avatar_cleanup_queue q
  SET completed_at = COALESCE(q.completed_at, pg_catalog.clock_timestamp()),
      locked_until = NULL,
      last_error = NULL
  WHERE q.id = ANY ((COALESCE(p_ids, ARRAY[]::uuid[]))[1:100])
    AND q.dead_lettered_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object('success', true, 'completed', v_count);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_complete_avatar_cleanup(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_complete_avatar_cleanup(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.service_complete_avatar_cleanup(p_ids uuid[])
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_complete_avatar_cleanup(p_ids) $$;
REVOKE ALL ON FUNCTION public.service_complete_avatar_cleanup(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_complete_avatar_cleanup(uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- service_fail_avatar_cleanup(p_id, p_error) -> {success, updated, dead_lettered}
-- Exponential backoff (2^attempts minutes, capped at 6h); dead-letter after 8 attempts.
-- The error text is sanitised (URLs/JWT-like tokens/control chars) and truncated to 200 chars.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_fail_avatar_cleanup(p_id uuid, p_error text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_attempts integer;
  v_err text;
  v_dead boolean;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;

  SELECT q.attempts INTO v_attempts
  FROM public.avatar_cleanup_queue q
  WHERE q.id = p_id AND q.completed_at IS NULL AND q.dead_lettered_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', true, 'updated', false);
  END IF;

  v_err := pg_catalog.left(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(COALESCE(p_error, ''), 'https?://\S+', '[url]', 'gi'),
        'eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]+)*', '[redacted]', 'g'),
      '[[:cntrl:]]+', ' ', 'g'),
    200);
  v_dead := v_attempts >= 8;

  UPDATE public.avatar_cleanup_queue q
  SET locked_until = NULL,
      last_error = v_err,
      next_attempt_at = v_now + pg_catalog.make_interval(
        mins => LEAST(pg_catalog.power(2, GREATEST(v_attempts, 1))::integer, 360)),
      dead_lettered_at = CASE WHEN v_dead THEN v_now ELSE NULL END
  WHERE q.id = p_id;

  RETURN pg_catalog.jsonb_build_object('success', true, 'updated', true, 'dead_lettered', v_dead);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_fail_avatar_cleanup(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_fail_avatar_cleanup(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.service_fail_avatar_cleanup(p_id uuid, p_error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_fail_avatar_cleanup(p_id, p_error) $$;
REVOKE ALL ON FUNCTION public.service_fail_avatar_cleanup(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_fail_avatar_cleanup(uuid, text) TO service_role;

commit;
