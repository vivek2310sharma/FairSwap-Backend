-- Migration 32: 20261001000032_add_staff_private_listing_location_access.sql
-- Issue #81: Provide authorized staff (moderator / administrator at AAL2) access to private listing location data.
-- Enforces authoritative database check: app_security.is_active_staff_aal2('moderator')

CREATE OR REPLACE FUNCTION public.get_staff_listing_location_private(p_listing_id uuid)
RETURNS TABLE (
  listing_id uuid,
  pin_code text,
  landmark text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Authoritative database authorization check:
  -- Requires active account_status, AAL2 assurance level, and moderator (or administrator) role.
  IF NOT app_security.is_active_staff_aal2('moderator') THEN
    RAISE EXCEPTION 'FORBIDDEN: Active staff session with AAL2 required';
  END IF;

  RETURN QUERY
  SELECT
    l.id AS listing_id,
    l.pin_code,
    l.landmark
  FROM public.listings l
  WHERE l.id = p_listing_id;
END;
$$;

-- Secure execution privileges
REVOKE ALL ON FUNCTION public.get_staff_listing_location_private(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_staff_listing_location_private(uuid) TO authenticated;
