-- Public avatars bucket + service-role-only avatar RPCs.
-- Public-bucket downloads bypass Storage read authorization, so ONLY server-generated,
-- EXIF-free, re-encoded WebP may ever be written here. No storage.objects policies are
-- created for anon/authenticated: all writes/deletes use the service-role client in the
-- authenticated Web route after it verifies the user. The RPCs below take the
-- already-verified user id from that trusted server and re-validate it in SQL.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 204800, ARRAY['image/webp']::text[])
ON CONFLICT (id) DO UPDATE SET
  public = true,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Objects awaiting deletion (replaced / deleted-account avatars). Service role only.
CREATE TABLE IF NOT EXISTS public.avatar_cleanup_queue (
  path text PRIMARY KEY,
  user_id uuid,
  reason text NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.avatar_cleanup_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.avatar_cleanup_queue FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.avatar_cleanup_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.avatar_cleanup_queue TO service_role;

-- ---------------------------------------------------------------------------
-- service_set_profile_avatar(p_user_id, p_old_path, p_new_path, p_public_url)
-- Compare-and-swap on profiles.avatar_path. Returns previous_path for cleanup.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_set_avatar(
  p_user_id uuid,
  p_old_path text,
  p_new_path text,
  p_public_url text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev text;
BEGIN
  -- Service-role context only (auth.uid() is NULL for the service key).
  IF auth.uid() IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  IF app_security.get_account_status(p_user_id) IS DISTINCT FROM 'active'
     OR NOT app_security.has_current_policy_acceptance(p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'ACCOUNT_RESTRICTED');
  END IF;

  -- Path must live under the user's own folder and match the server-generated shape.
  IF p_new_path IS NULL
     OR p_new_path !~ ('^' || p_user_id::text || '/[0-9a-f]{8,64}\.webp$') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_AVATAR_PATH');
  END IF;
  IF p_old_path IS NOT NULL AND p_old_path !~ ('^' || p_user_id::text || '/[0-9a-f]{8,64}\.webp$') THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_AVATAR_PATH');
  END IF;
  -- Public URL must be the https/http URL of exactly this object.
  IF p_public_url IS NULL
     OR p_public_url !~ '^https?://[^\s]+$'
     OR right(p_public_url, pg_catalog.char_length('/avatars/' || p_new_path)) <> '/avatars/' || p_new_path THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'INVALID_AVATAR_URL');
  END IF;
  -- The object must already exist in the avatars bucket.
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'avatars' AND o.name = p_new_path
  ) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'AVATAR_OBJECT_MISSING');
  END IF;

  SELECT avatar_path INTO v_prev FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'PROFILE_NOT_FOUND');
  END IF;
  IF v_prev IS DISTINCT FROM p_old_path THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'AVATAR_CONFLICT');
  END IF;

  UPDATE public.profiles
  SET avatar_path = p_new_path, avatar_url = p_public_url
  WHERE id = p_user_id;

  IF v_prev IS NOT NULL THEN
    INSERT INTO public.avatar_cleanup_queue (path, user_id, reason)
    VALUES (v_prev, p_user_id, 'replaced') ON CONFLICT (path) DO NOTHING;
  END IF;

  RETURN pg_catalog.jsonb_build_object('success', true, 'previous_path', v_prev, 'avatar_url', p_public_url);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_set_avatar(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_set_avatar(uuid, text, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.service_set_profile_avatar(
  p_user_id uuid, p_old_path text, p_new_path text, p_public_url text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_set_avatar(p_user_id, p_old_path, p_new_path, p_public_url) $$;
REVOKE ALL ON FUNCTION public.service_set_profile_avatar(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_set_profile_avatar(uuid, text, text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- service_clear_profile_avatar(p_user_id, p_old_path): CAS removal.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_security.impl_clear_avatar(
  p_user_id uuid,
  p_old_path text
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_prev text;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'FORBIDDEN');
  END IF;
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'NOT_AUTHENTICATED');
  END IF;
  IF app_security.get_account_status(p_user_id) IS DISTINCT FROM 'active'
     OR NOT app_security.has_current_policy_acceptance(p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'ACCOUNT_RESTRICTED');
  END IF;

  SELECT avatar_path INTO v_prev FROM public.profiles WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'PROFILE_NOT_FOUND');
  END IF;
  IF v_prev IS DISTINCT FROM p_old_path THEN
    RETURN pg_catalog.jsonb_build_object('success', false, 'error', 'AVATAR_CONFLICT');
  END IF;

  UPDATE public.profiles SET avatar_path = NULL, avatar_url = NULL WHERE id = p_user_id;
  IF v_prev IS NOT NULL THEN
    INSERT INTO public.avatar_cleanup_queue (path, user_id, reason)
    VALUES (v_prev, p_user_id, 'removed') ON CONFLICT (path) DO NOTHING;
  END IF;
  RETURN pg_catalog.jsonb_build_object('success', true, 'previous_path', v_prev);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_clear_avatar(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_clear_avatar(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.service_clear_profile_avatar(p_user_id uuid, p_old_path text)
RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT app_security.impl_clear_avatar(p_user_id, p_old_path) $$;
REVOKE ALL ON FUNCTION public.service_clear_profile_avatar(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_clear_profile_avatar(uuid, text) TO service_role;

commit;
