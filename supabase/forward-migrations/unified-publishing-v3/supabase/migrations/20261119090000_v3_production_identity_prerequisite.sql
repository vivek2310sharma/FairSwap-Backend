-- Production identity gate foundation for the disabled V3 package.
-- Uses the existing verified badge, account state and revocation records.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

insert into public.app_system_settings (setting_key, setting_value, description)
values ('identity_verification_required', 'false', 'Require verified identity for gated marketplace writes')
on conflict (setting_key) do nothing;
do $$
begin
  if (select setting_value from public.app_system_settings
      where setting_key='identity_verification_required') is distinct from 'false' then
    raise exception 'V3_PRODUCTION_IDENTITY_GATE_MUST_BE_OFF';
  end if;
end $$;

-- 3. Verification predicate + gate helpers
CREATE FUNCTION app_security.is_identity_verified(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p_user_id IS NOT NULL
    AND app_security.get_account_status(p_user_id) = 'active'
    AND EXISTS (
      SELECT 1 FROM public.user_identity_verifications v
      WHERE v.user_id = p_user_id
        AND v.verification_status = 'verified'
        AND v.badge_issued = true
        AND v.revoked_at IS NULL
        AND (v.valid_until IS NULL OR v.valid_until > pg_catalog.clock_timestamp())
    );
$$;
REVOKE ALL ON FUNCTION app_security.is_identity_verified(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION app_security.identity_gate_enabled()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce((SELECT setting_value = 'true' FROM public.app_system_settings
                   WHERE setting_key = 'identity_verification_required' LIMIT 1), false);
$$;
REVOKE ALL ON FUNCTION app_security.identity_gate_enabled() FROM PUBLIC, anon, authenticated, service_role;

-- Request context. PostgREST/Supabase sets the JWT role ('anon' | 'authenticated' | 'service_role') for every API
-- request, including inside SECURITY DEFINER functions it invokes. NULL means a direct database session
-- (migration, pg_cron, owner maintenance), which already requires database credentials.
CREATE FUNCTION app_security.idv_request_role()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_role text;
BEGIN
  v_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  IF v_role IS NULL THEN
    BEGIN
      v_role := nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
    EXCEPTION WHEN others THEN
      v_role := 'unknown'; -- unparseable claims are an API request of unknown role: never "system"
    END;
  END IF;
  RETURN v_role;
END;
$$;
REVOKE ALL ON FUNCTION app_security.idv_request_role() FROM PUBLIC, anon, authenticated;

-- Explicit, auditable opt-in for a legitimate system write that creates an ownerless row from inside an API request
-- (for example a future SECURITY DEFINER system-message function). Only database-side code can set it:
-- set_config() is not exposed through PostgREST. No current code path sets it.
CREATE FUNCTION app_security.identity_gate_system_write()
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT coalesce(pg_catalog.current_setting('fairswap.identity_gate_system_write', true), '') = 'on';
$$;
REVOKE ALL ON FUNCTION app_security.identity_gate_system_write() FROM PUBLIC, anon, authenticated;

-- p_any_caller = true  (INSERTs): the row owner must be verified whoever performs the write, including
--                         service-role or SECURITY DEFINER paths acting on a user's behalf (no bypass).
-- p_any_caller = false (UPDATEs): enforced when the caller IS the owner, so moderation, media-processing
--                         workers and system status changes keep working.
-- A NULL owner is never treated as a verified actor:
--   INSERT with NULL owner -> allowed only for a direct database session or an explicit system write; any API
--                             caller (anon, authenticated, service_role, unknown) is refused.
--   UPDATE of a NULL-owner (historical) row -> refused for an end user; staff (moderator AAL2+), service-role
--                             and database sessions keep working, so historical rows and moderation are preserved.
CREATE FUNCTION app_security.enforce_verified_actor(p_actor uuid, p_any_caller boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_uid uuid;
BEGIN
  IF NOT app_security.identity_gate_enabled() THEN
    RETURN;
  END IF;
  v_uid := auth.uid();
  IF p_actor IS NULL THEN
    IF coalesce(p_any_caller, false) THEN
      IF app_security.idv_request_role() IS NULL OR app_security.identity_gate_system_write() THEN
        RETURN;
      END IF;
      RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
    END IF;
    IF v_uid IS NOT NULL AND NOT app_security.is_active_staff_aal2('moderator') THEN
      RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RETURN;
  END IF;
  IF NOT coalesce(p_any_caller, false) AND (v_uid IS NULL OR v_uid <> p_actor) THEN
    RETURN;
  END IF;
  IF NOT app_security.is_identity_verified(p_actor) THEN
    RAISE EXCEPTION 'IDENTITY_VERIFICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION app_security.enforce_verified_actor(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.enforce_verified_actor(uuid, boolean) TO service_role;

-- 4. Table triggers: fire for RLS inserts, RPCs and direct PostgREST writes alike.
CREATE FUNCTION app_security.trg_identity_gate_listings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM app_security.enforce_verified_actor(NEW.seller_id, true);
  -- Draft edits, submission, resubmission and (re)publication. Pausing, sold, removal stay open to manage own ads.
  ELSIF NEW.seller_id IS NULL AND OLD.seller_id IS NOT NULL AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    NULL; -- owner removed by account deletion (FK SET NULL); not a user edit
  ELSIF NEW.status IN ('draft', 'pending_review', 'active')
        AND (OLD.status = 'draft' OR NEW.status IS DISTINCT FROM OLD.status) THEN
    PERFORM app_security.enforce_verified_actor(OLD.seller_id, false);
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_security.trg_identity_gate_by_listing()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_seller uuid;
BEGIN
  SELECT seller_id INTO v_seller FROM public.listings WHERE id = (pg_catalog.to_jsonb(NEW) ->> 'listing_id')::uuid;
  PERFORM app_security.enforce_verified_actor(v_seller, TG_OP = 'INSERT');
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_security.trg_identity_gate_posting_session()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM app_security.enforce_verified_actor(NEW.owner_id, true);
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_security.trg_identity_gate_staged_media()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_owner uuid;
BEGIN
  SELECT owner_id INTO v_owner FROM public.posting_upload_sessions WHERE id = NEW.session_id;
  PERFORM app_security.enforce_verified_actor(v_owner, TG_OP = 'INSERT');
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_security.trg_identity_gate_listings(), app_security.trg_identity_gate_by_listing(),
  app_security.trg_identity_gate_posting_session(), app_security.trg_identity_gate_staged_media()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_identity_gate BEFORE INSERT OR UPDATE ON public.listings
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_listings();
CREATE TRIGGER trg_identity_gate BEFORE INSERT ON public.listing_media
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_by_listing();
CREATE TRIGGER trg_identity_gate BEFORE INSERT ON public.posting_upload_sessions
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_posting_session();
CREATE TRIGGER trg_identity_gate BEFORE INSERT OR UPDATE ON public.posting_staged_media
  FOR EACH ROW EXECUTE FUNCTION app_security.trg_identity_gate_staged_media();

commit;
