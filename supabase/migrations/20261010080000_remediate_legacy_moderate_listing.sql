-- =============================================================================
-- Migration 37b: Remediate Legacy Moderate Listing Bypass
-- =============================================================================
-- Purpose:
-- Remove direct caller access to unversioned public.moderate_listing(uuid, text, text).
-- Prior to this migration, authenticated staff could invoke public.moderate_listing
-- without specifying expected_revision or expected_status, bypassing the concurrency
-- revision conflict gate enforced by public.moderate_listing_reviewed (PT409).
--
-- Security boundary:
-- 1. Revoke direct EXECUTE on public.moderate_listing(uuid, text, text) from PUBLIC,
--    anon, and authenticated.
-- 2. Preserve internal app_security.impl_moderate_listing for use by
--    app_security.impl_moderate_listing_reviewed.
-- 3. Replace public.moderate_listing with a fail-closed deprecation stub returning 0A000
--    if ever called, preventing silent or accidental execution.
-- =============================================================================

-- 1. Replace public wrapper with explicit deprecation error
CREATE OR REPLACE FUNCTION public.moderate_listing(
  listing_id uuid,
  action text,
  reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '0A000',
    MESSAGE = 'DEPRECATED_RPC: Direct moderation without version token is disabled. Call moderate_listing_reviewed with expected_revision and expected_status.';
END;
$$;

-- 2. Strictly revoke all EXECUTE privileges from client roles
REVOKE ALL ON FUNCTION public.moderate_listing(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- 3. Ensure internal app_security.impl_moderate_listing cannot be called directly by client roles
REVOKE ALL ON FUNCTION app_security.impl_moderate_listing(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION app_security.impl_moderate_listing(uuid, text, text) TO service_role;
