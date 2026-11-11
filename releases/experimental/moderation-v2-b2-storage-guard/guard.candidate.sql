-- FAIRSWAP MODERATION V2 B2 STORAGE MUTATION GUARD (EXPERIMENTAL CANDIDATE)
-- NOT a production forward migration. Do not execute against hosted projects.
-- Based on Web PR #180 disposable Supabase Storage API experiment.
--
-- Security property: once an object lives under
--   <listing_uuid>/<media_uuid>/v2/<asset_version_uuid>/<sha256>/<variant>.<ext>
-- in a listing media bucket, ordinary Storage API UPDATE/MOVE/DELETE operations
-- MUST NOT change or delete that object's physical bytes.
--
-- This guard targets the reserved third path segment "v2", including malformed
-- candidate paths (fail closed). Creation by INSERT remains possible and MUST be
-- gated by a separate sealer writer boundary and registry verification.
--
-- Must not be promoted to a versioned forward migration until Storage vendor
-- compatibility, S3/TUS coverage, race/physical-byte checks, and privacy-safe
-- trusted retirement are independently verified.

CREATE OR REPLACE FUNCTION app_security.reject_v2_sealed_storage_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $fairswap_guard$
BEGIN
  IF OLD.bucket_id IN ('listing-originals', 'listing-derivatives')
     AND split_part(OLD.name, '/', 3) = 'v2' THEN
    RAISE EXCEPTION 'FS_V2_SEALED_OBJECT_IMMUTABLE'
      USING ERRCODE = '23514';
  END IF;

  -- Reject attempts to rename/move an ordinary object INTO the sealed namespace.
  -- Before DELETE triggers must not inspect NEW (it is unavailable for DELETE).
  IF TG_OP = 'UPDATE' THEN
    IF NEW.bucket_id IN ('listing-originals', 'listing-derivatives')
       AND split_part(NEW.name, '/', 3) = 'v2' THEN
      RAISE EXCEPTION 'FS_V2_SEALED_OBJECT_IMMUTABLE'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$fairswap_guard$;

REVOKE ALL ON FUNCTION app_security.reject_v2_sealed_storage_mutation()
  FROM PUBLIC, anon, authenticated;

-- These DDL statements are provisional. A future reviewed forward migration
-- must check exact host version/permissions, feature-gate state and existing
-- trigger identity before installing. Do NOT use DROP/REPLACE on existing
-- hosted Storage triggers to force installation.
CREATE TRIGGER trg_fairswap_v2_sealed_storage_immutable
  BEFORE UPDATE OR DELETE ON storage.objects
  FOR EACH ROW
  EXECUTE FUNCTION app_security.reject_v2_sealed_storage_mutation();
