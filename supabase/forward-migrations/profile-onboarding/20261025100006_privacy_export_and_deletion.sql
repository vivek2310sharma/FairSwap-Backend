-- Privacy rights for profile private details (narrow change).
--
-- Export: the historical app_security.impl_fulfill_data_export (20260918000021) is NOT
-- copied. It is renamed to impl_fulfill_data_export_base and left byte-for-byte intact, so
-- authentication, the owner-or-administrator-AAL2 check, request resolution, the audit event
-- and every existing export field are still produced (and enforced exactly once) by the
-- original code. A thin SECURITY DEFINER function under the original name/signature calls the
-- base and appends only a "private_details" key. The base raises on any authorization
-- failure, so private details are read only after the caller was authorized. The base ACL is
-- revoked from every client role; the new function carries the original ACL
-- (authenticated, service_role). public.admin_fulfill_data_export keeps calling
-- app_security.impl_fulfill_data_export(uuid) by name and is unchanged.
-- Note: a later migration that re-declares impl_fulfill_data_export in full would replace
-- this function and drop "private_details"; such a migration must call the _base function.
--
-- Deletion: an AFTER UPDATE trigger on user_accounts removes the private row and clears
-- profiles.avatar_path/avatar_url when the account enters deletion_pending/deleted. The
-- physical object in the public avatars bucket is NOT erased by account deletion: Storage
-- erasure is deferred to a separate implementation (a later sweep can list the "<user_id>/"
-- prefix). Existing deletion functions are not redefined.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

DO $$
BEGIN
  IF pg_catalog.to_regprocedure('app_security.impl_fulfill_data_export_base(uuid)') IS NULL THEN
    ALTER FUNCTION app_security.impl_fulfill_data_export(uuid)
      RENAME TO impl_fulfill_data_export_base;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION app_security.impl_fulfill_data_export_base(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_security.impl_fulfill_data_export(
  p_request_id uuid
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_export jsonb;
  v_target_user_id uuid;
  v_private_details jsonb;
BEGIN
  -- Authentication and owner / administrator-AAL2 authorization happen inside the base
  -- function and raise on failure; nothing below runs for an unauthorized caller.
  v_export := app_security.impl_fulfill_data_export_base(p_request_id);

  SELECT user_id INTO v_target_user_id
  FROM public.privacy_requests
  WHERE id = p_request_id AND request_type = 'export_data';

  SELECT to_jsonb(pd) INTO v_private_details
  FROM (
    SELECT d.full_name, d.pin_code, l.name AS locality, c.name AS district, d.state,
           d.preferred_language, d.onboarding_completed_at, d.created_at, d.updated_at
    FROM public.user_private_details d
    LEFT JOIN public.localities l ON l.id = d.locality_id
    LEFT JOIN public.cities c ON c.id = d.city_id
    WHERE d.user_id = v_target_user_id
  ) pd;

  RETURN v_export || pg_catalog.jsonb_build_object('private_details', v_private_details);
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_fulfill_data_export(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_fulfill_data_export(uuid) TO authenticated, service_role;

-- Deletion cleanup: remove private details and stop advertising the avatar on the profile.
-- Storage objects are NOT erased here (deferred; see header).
CREATE OR REPLACE FUNCTION app_security.cleanup_profile_private_data_on_deletion()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles SET avatar_path = NULL, avatar_url = NULL WHERE id = NEW.user_id;
  DELETE FROM public.user_private_details WHERE user_id = NEW.user_id;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_security.cleanup_profile_private_data_on_deletion()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_user_accounts_profile_cleanup ON public.user_accounts;
CREATE TRIGGER trg_user_accounts_profile_cleanup
AFTER UPDATE OF account_status ON public.user_accounts
FOR EACH ROW
WHEN (NEW.account_status IN ('deletion_pending', 'deleted')
      AND OLD.account_status IS DISTINCT FROM NEW.account_status)
EXECUTE FUNCTION app_security.cleanup_profile_private_data_on_deletion();

commit;
