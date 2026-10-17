-- PREPARED ONLY: apply only after review and separately authorized verification.
-- Read contract matches owner-private location/listings SELECT: authenticated
-- owners may read their listing in any status. Posting account/policy/status
-- gates remain at the existing write boundary; this read grants no write rights.
-- app_security is already private and has authenticated USAGE in migration 1.
-- Definer access is necessary because ordinary reference RLS hides inactive
-- categories AND their attributes. Only the owned listing's references escape
-- that filter; discovery policies, table grants and default privileges stay intact.
BEGIN;

CREATE FUNCTION app_security.impl_get_seller_listing_category_context(p_listing_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_category_id uuid;
  v_context jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Authentication required';
  END IF;

  -- Ownership is enforced here too: direct private calls have no staff bypass.
  SELECT l.category_id INTO v_category_id
  FROM public.listings AS l
  WHERE l.id = p_listing_id AND l.seller_id = v_uid;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Listing unavailable';
  END IF;

  SELECT pg_catalog.jsonb_build_object(
    'category', pg_catalog.jsonb_build_object(
      'id', c.id, 'name', c.name, 'is_active', c.is_active,
      'macro_category', c.macro_category, 'new_listing_enabled', c.new_listing_enabled
    ),
    'attributes', COALESCE((
      SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', a.id, 'category_id', a.category_id, 'name', a.name,
        'label', a.label, 'value_type', a.value_type, 'is_required', a.is_required,
        'options', a.options, 'validation_rules', a.validation_rules,
        'sort_order', a.sort_order
      ) ORDER BY a.sort_order, a.id)
      FROM public.category_attributes AS a WHERE a.category_id = c.id
    ), '[]'::jsonb)
  ) INTO v_context
  FROM public.categories AS c WHERE c.id = v_category_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Listing unavailable';
  END IF;
  RETURN v_context;
END;
$$;

CREATE FUNCTION public.get_seller_listing_category_context(p_listing_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT app_security.impl_get_seller_listing_category_context(p_listing_id);
$$;

-- New-function ACLs only. Invoker wrapper needs the caller to execute the private
-- implementation; its own auth.uid()/ownership checks protect that direct path.
REVOKE ALL ON FUNCTION app_security.impl_get_seller_listing_category_context(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION app_security.impl_get_seller_listing_category_context(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.get_seller_listing_category_context(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_seller_listing_category_context(uuid)
  TO authenticated;

COMMENT ON FUNCTION public.get_seller_listing_category_context(uuid) IS
  'Owner-only saved category and attribute definitions, including inactive references. Retention read only; no assignment or write authorization.';
COMMENT ON FUNCTION app_security.impl_get_seller_listing_category_context(uuid) IS
  'Private owner-checked definer read of exact saved references hidden by ordinary discovery RLS. No staff override or write side effects.';

COMMIT;
