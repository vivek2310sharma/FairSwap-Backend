CREATE FUNCTION app_security.impl_moderate_listing_reviewed(
  p_listing_id uuid, p_action text, p_reason text,
  p_expected_revision integer, p_expected_status public.listing_status_enum
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_listing public.listings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR NOT app_security.is_active_staff_aal2('moderator'::public.staff_role_enum)
     OR NOT app_security.has_current_policy_acceptance(auth.uid()) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Staff authorization required';
  END IF;
  IF p_listing_id IS NULL OR p_expected_revision IS NULL
     OR p_expected_revision < 1 OR p_expected_status IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Reviewed identity required';
  END IF;
  SELECT * INTO v_listing FROM public.listings
    WHERE id = p_listing_id FOR UPDATE;
  IF NOT FOUND OR v_listing.seller_id = auth.uid() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Listing unavailable';
  END IF;
  IF v_listing.revision IS DISTINCT FROM p_expected_revision
     OR v_listing.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'MODERATION_REVIEW_CONFLICT';
  END IF;
  RETURN app_security.impl_moderate_listing(p_listing_id, p_action, p_reason);
END;
$$;
REVOKE ALL ON FUNCTION app_security.impl_moderate_listing_reviewed(
  uuid,text,text,integer,public.listing_status_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_security.impl_moderate_listing_reviewed(
  uuid,text,text,integer,public.listing_status_enum) TO authenticated;

CREATE FUNCTION public.moderate_listing_reviewed(
  listing_id uuid, action text, reason text,
  expected_revision integer, expected_status public.listing_status_enum
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT app_security.impl_moderate_listing_reviewed(
    listing_id,action,reason,expected_revision,expected_status);
$$;
REVOKE ALL ON FUNCTION public.moderate_listing_reviewed(
  uuid,text,text,integer,public.listing_status_enum) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.moderate_listing_reviewed(
  uuid,text,text,integer,public.listing_status_enum) TO authenticated;