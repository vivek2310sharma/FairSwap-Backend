-- Public seller profile: paginated, filterable listing search for one seller.
-- Additive only. Applies the same public-visibility policy as
-- app_security.impl_search_public_listings (active, not expired, seller account active)
-- and never returns pin_code or landmark.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

CREATE OR REPLACE FUNCTION app_security.impl_search_seller_public_listings(
  p_seller_id uuid,
  p_query text DEFAULT NULL,
  p_category_slug text DEFAULT NULL,
  p_condition text DEFAULT NULL,
  p_price_min integer DEFAULT NULL,
  p_price_max integer DEFAULT NULL,
  p_sort text DEFAULT 'newest',
  p_page integer DEFAULT 1,
  p_per_page integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page integer := coalesce(p_page, 1);
  v_per_page integer := coalesce(p_per_page, 12);
  v_offset integer;
  v_total_count integer;
  v_items jsonb;
  v_categories jsonb;
  v_tsquery tsquery := NULL;
  v_cat_id uuid := NULL;
  v_cond public.listing_condition_enum := NULL;
  v_empty jsonb;
BEGIN
  -- Fail closed: any filter that is supplied but unusable yields an empty result,
  -- never a broader one.
  IF p_seller_id IS NULL THEN
    RETURN jsonb_build_object('items', '[]'::jsonb, 'total_count', 0, 'page', 1,
      'per_page', 12, 'total_pages', 0, 'categories', '[]'::jsonb);
  END IF;

  IF v_page < 1 THEN v_page := 1; END IF;
  IF v_page > 1000 THEN v_page := 1000; END IF;
  IF v_per_page < 1 THEN v_per_page := 12; END IF;
  IF v_per_page > 24 THEN v_per_page := 24; END IF;
  v_offset := (v_page - 1) * v_per_page;
  v_empty := jsonb_build_object('items', '[]'::jsonb, 'total_count', 0, 'page', v_page,
    'per_page', v_per_page, 'total_pages', 0, 'categories', '[]'::jsonb);

  IF p_category_slug IS NOT NULL AND length(trim(p_category_slug)) > 0 THEN
    SELECT id INTO v_cat_id FROM public.categories
    WHERE slug = trim(p_category_slug) AND is_active = true;
    IF v_cat_id IS NULL THEN
      RETURN v_empty; -- unknown category slug
    END IF;
  END IF;

  IF p_condition IS NOT NULL AND length(trim(p_condition)) > 0 THEN
    IF trim(p_condition) NOT IN ('new', 'like_new', 'good', 'fair', 'poor') THEN
      RETURN v_empty; -- unknown condition
    END IF;
    v_cond := trim(p_condition)::public.listing_condition_enum;
  END IF;

  IF (p_price_min IS NOT NULL AND p_price_min < 0)
     OR (p_price_max IS NOT NULL AND p_price_max < 0)
     OR (p_price_min IS NOT NULL AND p_price_max IS NOT NULL AND p_price_min > p_price_max) THEN
    RETURN v_empty; -- impossible price range
  END IF;

  IF p_query IS NOT NULL AND length(trim(p_query)) > 0 THEN
    v_tsquery := websearch_to_tsquery('english', left(trim(p_query), 100));
    IF v_tsquery = ''::tsquery THEN
      RETURN v_empty; -- stop-word/symbol-only query matches nothing, not everything
    END IF;
  END IF;

  SELECT count(*)
  INTO v_total_count
  FROM public.listings l
  JOIN public.user_accounts ua ON ua.user_id = l.seller_id
  WHERE l.seller_id = p_seller_id
    AND l.status = 'active'
    AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
    AND ua.account_status = 'active'
    AND (v_cat_id IS NULL OR l.category_id = v_cat_id)
    AND (v_cond IS NULL OR l.condition = v_cond)
    AND (p_price_min IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise >= p_price_min))
    AND (p_price_max IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise <= p_price_max))
    AND (v_tsquery IS NULL OR l.search_vector @@ v_tsquery);

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
      jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug, 'icon', c.icon) AS category,
      jsonb_build_object('id', ci.id, 'name', ci.name, 'state', ci.state) AS city,
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
    WHERE l.seller_id = p_seller_id
      AND l.status = 'active'
      AND (l.expires_at IS NULL OR l.expires_at > pg_catalog.clock_timestamp())
      AND ua.account_status = 'active'
      AND (v_cat_id IS NULL OR l.category_id = v_cat_id)
      AND (v_cond IS NULL OR l.condition = v_cond)
      AND (p_price_min IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise >= p_price_min))
      AND (p_price_max IS NULL OR (l.price_paise IS NOT NULL AND l.price_paise <= p_price_max))
      AND (v_tsquery IS NULL OR l.search_vector @@ v_tsquery)
    ORDER BY
      CASE WHEN p_sort = 'price_asc' THEN l.price_paise END ASC NULLS LAST,
      CASE WHEN p_sort = 'price_desc' THEN l.price_paise END DESC NULLS LAST,
      CASE WHEN p_sort = 'oldest' THEN l.created_at END ASC,
      CASE WHEN p_sort = 'oldest' THEN l.id END ASC,
      l.created_at DESC,
      l.id DESC
    LIMIT v_per_page
    OFFSET v_offset
  ) item;

  -- Categories the seller has visible listings in (for the filter), unaffected by other filters.
  SELECT coalesce(jsonb_agg(jsonb_build_object('slug', cat.slug, 'name', cat.name) ORDER BY cat.name), '[]'::jsonb)
  INTO v_categories
  FROM public.categories cat
  WHERE cat.is_active = true
    AND EXISTS (
      SELECT 1
      FROM public.listings l2
      JOIN public.user_accounts ua2 ON ua2.user_id = l2.seller_id
      WHERE l2.seller_id = p_seller_id
        AND l2.category_id = cat.id
        AND l2.status = 'active'
        AND (l2.expires_at IS NULL OR l2.expires_at > pg_catalog.clock_timestamp())
        AND ua2.account_status = 'active'
    );

  RETURN jsonb_build_object(
    'items', v_items,
    'total_count', v_total_count,
    'page', v_page,
    'per_page', v_per_page,
    'total_pages', CASE WHEN v_total_count > 0 THEN ceil(v_total_count::numeric / v_per_page)::integer ELSE 0 END,
    'categories', v_categories
  );
END;
$$;

REVOKE ALL ON FUNCTION app_security.impl_search_seller_public_listings(uuid, text, text, text, integer, integer, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.impl_search_seller_public_listings(uuid, text, text, text, integer, integer, text, integer, integer) TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.search_seller_public_listings(
  seller_id uuid,
  query text DEFAULT NULL,
  category_slug text DEFAULT NULL,
  condition text DEFAULT NULL,
  price_min integer DEFAULT NULL,
  price_max integer DEFAULT NULL,
  sort text DEFAULT 'newest',
  page integer DEFAULT 1,
  per_page integer DEFAULT 12
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT app_security.impl_search_seller_public_listings(
    seller_id, query, category_slug, condition, price_min, price_max, sort, page, per_page
  );
$$;

REVOKE ALL ON FUNCTION public.search_seller_public_listings(uuid, text, text, text, integer, integer, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_seller_public_listings(uuid, text, text, text, integer, integer, text, integer, integer) TO anon, authenticated, service_role;

commit;