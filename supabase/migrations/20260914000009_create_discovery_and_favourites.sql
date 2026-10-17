-- Migration 9: 20260914000009_create_discovery_and_favourites.sql
-- Full-Text Search, Indexes, Slug History, Favourites, Public RLS & Grants, and Search RPC

-- =============================================================================
-- 1. Full-Text Search Vector & GIN Index on public.listings
-- =============================================================================
ALTER TABLE public.listings
ADD COLUMN search_vector tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(description, '')), 'B')
) STORED;

CREATE INDEX idx_listings_search_vector ON public.listings USING gin(search_vector);

-- Composite indexes for filtered browsing and stable pagination tie-breakers
CREATE INDEX idx_listings_public_newest ON public.listings (status, created_at DESC, id DESC);
CREATE INDEX idx_listings_public_price_asc ON public.listings (status, price_paise ASC, id ASC);
CREATE INDEX idx_listings_public_price_desc ON public.listings (status, price_paise DESC, id DESC);
CREATE INDEX idx_listings_public_cat_newest ON public.listings (category_id, status, created_at DESC, id DESC);
CREATE INDEX idx_listings_public_city_newest ON public.listings (city_id, status, created_at DESC, id DESC);
CREATE INDEX idx_listings_public_city_locality ON public.listings (city_id, locality_id, status, created_at DESC, id DESC);
CREATE INDEX idx_listings_slug ON public.listings (slug);

-- =============================================================================
-- 2. Listing Slug History (For SEO 301 redirects after visibility check)
-- =============================================================================
CREATE TABLE public.listing_slug_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_listing_slug_history UNIQUE (listing_id, slug)
);

CREATE INDEX idx_listing_slug_history_slug ON public.listing_slug_history (slug);
CREATE INDEX idx_listing_slug_history_listing_id ON public.listing_slug_history (listing_id);

CREATE OR REPLACE FUNCTION public.handle_listing_slug_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.slug IS DISTINCT FROM NEW.slug AND OLD.slug IS NOT NULL AND length(trim(OLD.slug)) > 0 THEN
    INSERT INTO public.listing_slug_history (listing_id, slug)
    VALUES (OLD.id, OLD.slug)
    ON CONFLICT (listing_id, slug) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_slug_change
BEFORE UPDATE OF slug ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_slug_change();

ALTER TABLE public.listing_slug_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.listing_slug_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.listing_slug_history TO anon, authenticated;
GRANT ALL ON public.listing_slug_history TO service_role;

CREATE POLICY listing_slug_history_select_policy ON public.listing_slug_history
FOR SELECT USING (
  app_security.is_listing_publicly_visible(listing_id)
  OR EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_slug_history.listing_id AND l.seller_id = auth.uid()
  )
  OR app_security.is_active_staff_aal2('moderator')
  OR app_security.is_active_staff_aal2('administrator')
);

-- =============================================================================
-- 3. Favourites Table & Policies
-- =============================================================================
CREATE TABLE public.favourites (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, listing_id)
);

CREATE INDEX idx_favourites_user_created ON public.favourites (user_id, created_at DESC);
CREATE INDEX idx_favourites_listing_id ON public.favourites (listing_id);

ALTER TABLE public.favourites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.favourites FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.favourites TO authenticated;
GRANT ALL ON public.favourites TO service_role;

-- Authenticated users can view own favourites
CREATE POLICY favourites_select_policy ON public.favourites
FOR SELECT USING (
  user_id = auth.uid()
);

-- Authenticated users can only favourite active, publicly visible listings
CREATE POLICY favourites_insert_policy ON public.favourites
FOR INSERT WITH CHECK (
  user_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
  AND app_security.is_listing_publicly_visible(listing_id)
);

-- Authenticated users can delete own favourites
CREATE POLICY favourites_delete_policy ON public.favourites
FOR DELETE USING (
  user_id = auth.uid()
);

-- =============================================================================
-- 4. Public RLS & Grants for Listings and Listing Media
-- =============================================================================

-- Update listings SELECT policy to permit public reading of active listings
DROP POLICY IF EXISTS listings_select_policy ON public.listings;
CREATE POLICY listings_select_policy ON public.listings
FOR SELECT USING (
  seller_id = auth.uid()
  OR app_security.is_active_staff_aal2('moderator')
  OR app_security.is_active_staff_aal2('administrator')
  OR (
    status = 'active'
    AND (expires_at IS NULL OR expires_at > clock_timestamp())
    AND app_security.get_account_status(seller_id) = 'active'
  )
);

-- Column grants on public.listings for anon (excluding rejection_reason, removal_reason, removed_by)
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
  pin_code,
  category_attributes,
  status,
  cover_photo_id,
  created_at,
  published_at,
  expires_at
) ON public.listings TO anon;

-- Update listing_media SELECT policy to allow public reading of derivative media for active listings
DROP POLICY IF EXISTS listing_media_select_policy ON public.listing_media;
CREATE POLICY listing_media_select_policy ON public.listing_media
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND (
        l.seller_id = auth.uid()
        OR app_security.is_active_staff_aal2('moderator')
        OR app_security.is_active_staff_aal2('administrator')
        OR (
          l.status = 'active'
          AND (l.expires_at IS NULL OR l.expires_at > clock_timestamp())
          AND app_security.get_account_status(l.seller_id) = 'active'
          AND listing_media.processing_status = 'ready'
        )
      )
  )
);

-- Column grants on public.listing_media for anon (excluding original_storage_path)
GRANT SELECT (
  id,
  listing_id,
  thumbnail_storage_path,
  medium_storage_path,
  large_storage_path,
  width,
  height,
  display_order,
  processing_status,
  created_at
) ON public.listing_media TO anon;

-- =============================================================================
-- 5. Search RPC: search_public_listings
-- =============================================================================
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

  -- Fetch matching items
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
      l.pin_code,
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

REVOKE ALL ON FUNCTION app_security.impl_search_public_listings(text, uuid, text, uuid, uuid, text, integer, integer, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_security.impl_search_public_listings(text, uuid, text, uuid, uuid, text, integer, integer, text, integer, integer) TO anon, authenticated, service_role;

-- Public wrapper
CREATE OR REPLACE FUNCTION public.search_public_listings(
  query text DEFAULT NULL,
  category_id uuid DEFAULT NULL,
  category_slug text DEFAULT NULL,
  city_id uuid DEFAULT NULL,
  locality_id uuid DEFAULT NULL,
  condition text DEFAULT NULL,
  price_min integer DEFAULT NULL,
  price_max integer DEFAULT NULL,
  sort text DEFAULT 'newest',
  page integer DEFAULT 1,
  per_page integer DEFAULT 20
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT app_security.impl_search_public_listings(
    query,
    category_id,
    category_slug,
    city_id,
    locality_id,
    condition,
    price_min,
    price_max,
    sort,
    page,
    per_page
  );
$$;

REVOKE ALL ON FUNCTION public.search_public_listings(text, uuid, text, uuid, uuid, text, integer, integer, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_public_listings(text, uuid, text, uuid, uuid, text, integer, integer, text, integer, integer) TO anon, authenticated, service_role;
