-- Migration 31: 20261001000031_harden_public_listing_location_privacy.sql
-- Issue #81: Release-blocking public location privacy hardening
-- Invariant: Public listings expose locality/district/state only.
-- Never public: pin_code, landmark, exact/private location.
-- Direct table SELECT on pin_code and landmark is revoked for anon and authenticated non-owners.
-- Owner private access is preserved via get_seller_listing_location_private.

-- 1. Redefine app_security.impl_search_public_listings without l.pin_code
CREATE OR REPLACE FUNCTION app_security.impl_search_public_listings(
  p_query text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL,
  p_category_slug text DEFAULT NULL,
  p_city_id uuid DEFAULT NULL,
  p_locality_id uuid DEFAULT NULL,
  p_condition text DEFAULT NULL,
  p_price_min integer DEFAULT NULL,
  p_price_max integer DEFAULT NULL,
  p_sort text DEFAULT 'newest',
  p_page integer DEFAULT 1,
  p_per_page integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page integer := coalesce(p_page, 1);
  v_per_page integer := coalesce(p_per_page, 20);
  v_offset integer;
  v_total_count integer;
  v_items jsonb;
  v_tsquery tsquery := NULL;
  v_cat_id uuid := p_category_id;
  v_cond public.listing_condition_enum := NULL;
BEGIN
  -- Validate pagination bounds
  IF v_page < 1 THEN v_page := 1; END IF;
  IF v_per_page < 1 THEN v_per_page := 20; END IF;
  IF v_per_page > 50 THEN v_per_page := 50; END IF;
  v_offset := (v_page - 1) * v_per_page;

  -- Resolve category slug if category_id not provided
  IF v_cat_id IS NULL AND p_category_slug IS NOT NULL AND length(trim(p_category_slug)) > 0 THEN
    SELECT id INTO v_cat_id FROM public.categories WHERE slug = trim(p_category_slug) AND is_active = true;
  END IF;

  -- Cast condition if valid
  IF p_condition IS NOT NULL AND p_condition IN ('new', 'like_new', 'good', 'fair', 'poor') THEN
    v_cond := p_condition::public.listing_condition_enum;
  END IF;

  -- Parse search query safely using websearch_to_tsquery
  IF p_query IS NOT NULL AND length(trim(p_query)) > 0 THEN
    v_tsquery := websearch_to_tsquery('english', trim(p_query));
    -- If websearch returns empty (e.g. stop words only or symbols), treat as null
    IF v_tsquery = ''::tsquery THEN
      v_tsquery := NULL;
    END IF;
  END IF;

  -- Count total matching rows
  SELECT count(*)
  INTO v_total_count
  FROM public.listings l
  JOIN public.user_accounts ua ON ua.user_id = l.seller_id
  WHERE l.status = 'active'
    AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
    AND ua.account_status = 'active'
    AND (v_cat_id IS NULL OR l.category_id = v_cat_id)
    AND (p_city_id IS NULL OR l.city_id = p_city_id)
    AND (p_locality_id IS NULL OR l.locality_id = p_locality_id)
    AND (v_cond IS NULL OR l.condition = v_cond)
    AND (p_price_min IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise >= p_price_min))
    AND (p_price_max IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise <= p_price_max))
    AND (v_tsquery IS NULL OR l.search_vector @@ v_tsquery);

  -- Fetch matching items (strictly excluding pin_code and landmark)
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb)
  INTO v_items
  FROM (
    SELECT
      l.id,
      l.seller_id,
      l.slug,
      l.title,
      l.description,
      l.condition,
      l.price_type,
      l.price_paise,
      l.category_attributes,
      l.status,
      l.created_at,
      l.published_at,
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'slug', c.slug,
        'icon', c.icon
      ) AS category,
      jsonb_build_object(
        'id', ci.id,
        'name', ci.name,
        'state', ci.state
      ) AS city,
      CASE
        WHEN loc.id IS NOT NULL THEN jsonb_build_object('id', loc.id, 'name', loc.name)
        ELSE NULL
      END AS locality,
      CASE
        WHEN m.id IS NOT NULL THEN jsonb_build_object(
          'id', m.id,
          'thumbnail_storage_path', m.thumbnail_storage_path,
          'medium_storage_path', m.medium_storage_path,
          'width', m.width,
          'height', m.height
        )
        ELSE NULL
      END AS cover_photo
    FROM public.listings l
    JOIN public.user_accounts ua ON ua.user_id = l.seller_id
    JOIN public.categories c ON c.id = l.category_id
    JOIN public.cities ci ON ci.id = l.city_id
    LEFT JOIN public.localities loc ON loc.id = l.locality_id
    LEFT JOIN public.listing_media m ON m.id = l.cover_photo_id
    WHERE l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
      AND ua.account_status = 'active'
      AND (v_cat_id IS NULL OR l.category_id = v_cat_id)
      AND (p_city_id IS NULL OR l.city_id = p_city_id)
      AND (p_locality_id IS NULL OR l.locality_id = p_locality_id)
      AND (v_cond IS NULL OR l.condition = v_cond)
      AND (p_price_min IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise >= p_price_min))
      AND (p_price_max IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise <= p_price_max))
      AND (v_tsquery IS NULL OR l.search_vector @@ v_tsquery)
    ORDER BY
      CASE WHEN p_sort = 'price_asc' THEN l.price_paise END ASC NULLS LAST,
      CASE WHEN p_sort = 'price_desc' THEN l.price_paise END DESC NULLS LAST,
      CASE WHEN p_sort = 'relevance' AND v_tsquery IS NOT NULL THEN ts_rank(l.search_vector, v_tsquery) END DESC NULLS LAST,
      l.created_at DESC,
      l.id DESC
    LIMIT v_per_page
    OFFSET v_offset
  ) item;

  RETURN jsonb_build_object(
    'items', v_items,
    'total_count', v_total_count,
    'page', v_page,
    'per_page', v_per_page,
    'total_pages', CASE WHEN v_total_count > 0 THEN ceil(v_total_count::numeric / v_per_page)::integer ELSE 0 END
  );
END;
$$;

-- 2. Revoke and tighten grants on public.listings
-- Revoke all table-wide and column grants from PUBLIC, anon, and authenticated
REVOKE ALL ON public.listings FROM PUBLIC, anon, authenticated;

-- Grant column-level SELECT on public-safe columns to anon (EXCLUDES pin_code and landmark)
GRANT SELECT (
  id,
  seller_id,
  slug,
  category_id,
  city_id,
  locality_id,
  title,
  description,
  condition,
  price_type,
  price_paise,
  category_attributes,
  status,
  cover_photo_id,
  created_at,
  published_at,
  expires_at
) ON public.listings TO anon;

-- Grant column-level SELECT on public-safe and seller-safe columns to authenticated (EXCLUDES pin_code and landmark)
GRANT SELECT (
  id,
  seller_id,
  slug,
  category_id,
  city_id,
  locality_id,
  title,
  description,
  condition,
  price_type,
  price_paise,
  category_attributes,
  status,
  cover_photo_id,
  created_at,
  updated_at,
  submitted_at,
  published_at,
  expires_at,
  sold_at,
  revision,
  renewal_count,
  rejection_reason,
  removal_reason,
  removed_by
) ON public.listings TO authenticated;

-- Preserve seller INSERT privileges on mutable listing columns (including pin_code and landmark)
GRANT INSERT (
  category_id,
  city_id,
  locality_id,
  title,
  description,
  condition,
  price_type,
  price_paise,
  pin_code,
  landmark,
  category_attributes
) ON public.listings TO authenticated;

-- Preserve seller UPDATE privileges on mutable listing columns (including pin_code and landmark)
GRANT UPDATE (
  category_id,
  city_id,
  locality_id,
  title,
  description,
  condition,
  price_type,
  price_paise,
  pin_code,
  landmark,
  category_attributes,
  cover_photo_id
) ON public.listings TO authenticated;

-- Ensure service_role has full access
GRANT ALL ON public.listings TO service_role;

-- 3. Owner-private RPC for private location details (pin_code, landmark)
-- Strictly validates auth.uid() and restricts seller_id to current owner.
CREATE OR REPLACE FUNCTION public.get_seller_listing_location_private(p_listing_id uuid)
RETURNS TABLE (
  listing_id uuid,
  pin_code text,
  landmark text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'UNAUTHENTICATED: Authentication required';
  END IF;

  RETURN QUERY
  SELECT
    l.id AS listing_id,
    l.pin_code,
    l.landmark
  FROM public.listings l
  WHERE l.id = p_listing_id
    AND l.seller_id = v_uid;
END;
$$;

-- Secure execution privileges
REVOKE ALL ON FUNCTION public.get_seller_listing_location_private(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_seller_listing_location_private(uuid) TO authenticated, service_role;
