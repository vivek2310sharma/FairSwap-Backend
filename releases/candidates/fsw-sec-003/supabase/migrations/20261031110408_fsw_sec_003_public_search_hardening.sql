-- FSW-SEC-003. Replace only the existing private implementation; retain ACL/owner.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- Refuse an absent/drifted implementation: CREATE OR REPLACE must retain the
-- existing owner/ACL, never accidentally create a default-PUBLIC executable RPC.
-- Body fingerprint matches both hosted environments on 2026-10-31 and migration 31.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    WHERE p.oid = pg_catalog.to_regprocedure('app_security.impl_search_public_listings(text,uuid,text,uuid,uuid,text,integer,integer,text,integer,integer)')
      AND pg_catalog.md5(p.prosrc) = '0ccc07eede6a6fa06b30acc06d9cdc10'
      AND p.prosecdef AND p.provolatile = 's'
      AND p.proconfig = ARRAY['search_path=""']
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'SEARCH_IMPLEMENTATION_DRIFT';
  END IF;
END;
$guard$;

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
  v_query text;
BEGIN
  -- Bound bytes BEFORE trimming/character counting or invoking the text parser.
  -- UTF-8 needs at most 400 bytes for 100 code points; 4096 permits padding.
  IF pg_catalog.octet_length(p_query) > 4096
     OR pg_catalog.octet_length(p_category_slug) > 4096
     OR pg_catalog.octet_length(p_condition) > 64
     OR pg_catalog.octet_length(p_sort) > 64 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_SEARCH_FILTER';
  END IF;
  v_query := pg_catalog.btrim(p_query);
  IF pg_catalog.char_length(v_query) > 100 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_SEARCH_QUERY';
  END IF;
  IF v_page < 1 OR v_page > 1000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_SEARCH_PAGE';
  END IF;
  -- Preserve existing per-page default/clamping; offset is now at most 49,950.
  IF v_per_page < 1 THEN v_per_page := 20; END IF;
  IF v_per_page > 50 THEN v_per_page := 50; END IF;
  v_offset := (v_page - 1) * v_per_page;

  IF (p_condition IS NOT NULL AND p_condition NOT IN ('new', 'like_new', 'good', 'fair', 'poor'))
     OR (p_sort IS NOT NULL AND p_sort NOT IN ('newest', 'price_asc', 'price_desc', 'relevance'))
     OR p_price_min < 0 OR p_price_max < 0
     OR p_price_min > p_price_max THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_SEARCH_FILTER';
  END IF;
  v_cond := p_condition::public.listing_condition_enum;

  -- Keep ID-only filtering, but never discard a supplied slug (including conflicts).
  -- Ordinary unfiltered searches perform no category lookup; slug searches retain
  -- the existing single indexed lookup. Unknown IDs remain a restrictive predicate.
  IF p_category_slug IS NOT NULL THEN
    SELECT id INTO v_cat_id FROM public.categories
    WHERE slug = pg_catalog.btrim(p_category_slug) AND is_active = true;
    IF v_cat_id IS NULL OR (p_category_id IS NOT NULL AND p_category_id <> v_cat_id) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'INVALID_SEARCH_CATEGORY';
    END IF;
  END IF;

  -- Same parser, English configuration, stop-word behavior and ranking as before.
  IF v_query IS NOT NULL AND pg_catalog.char_length(v_query) > 0 THEN
    v_tsquery := pg_catalog.websearch_to_tsquery('english', v_query);
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

commit;
