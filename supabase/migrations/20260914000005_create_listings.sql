-- Migration 5: 20260914000005_create_listings.sql
-- Listings, Lifecycle Status Transitions, Triggers, RLS, and Explicit Grants

-- 1. Create Enums
CREATE TYPE public.listing_status_enum AS ENUM (
  'draft',
  'pending_review',
  'active',
  'reserved',
  'sold',
  'rejected',
  'paused',
  'expired',
  'removed'
);

CREATE TYPE public.listing_condition_enum AS ENUM (
  'new',
  'like_new',
  'good',
  'fair',
  'poor'
);

CREATE TYPE public.listing_price_type_enum AS ENUM (
  'fixed',
  'negotiable',
  'free'
);

CREATE TYPE public.transition_actor_kind_enum AS ENUM (
  'seller',
  'moderator',
  'system'
);

-- 2. Create public.listings
CREATE TABLE public.listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  slug text NOT NULL DEFAULT '' CHECK (length(slug) >= 0 AND length(slug) <= 200),
  category_id uuid NOT NULL REFERENCES public.categories(id),
  city_id uuid NOT NULL REFERENCES public.cities(id),
  locality_id uuid REFERENCES public.localities(id),
  title text NOT NULL CHECK (length(title) >= 3 AND length(title) <= 150),
  description text CHECK (description IS NULL OR length(description) <= 5000),
  condition public.listing_condition_enum,
  price_type public.listing_price_type_enum,
  price_paise integer CHECK (price_paise IS NULL OR (price_paise >= 0 AND price_paise <= 100000000)),
  pin_code text CHECK (pin_code IS NULL OR pin_code ~ '^\d{6}$'),
  category_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  status public.listing_status_enum NOT NULL DEFAULT 'draft',
  revision integer NOT NULL DEFAULT 1,
  renewal_count integer NOT NULL DEFAULT 0,
  rejection_reason text,
  removal_reason text,
  removed_by uuid REFERENCES auth.users(id),
  cover_photo_id uuid, -- FK added in Migration 6
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  sold_at timestamptz
);

-- 3. Create public.listing_status_transitions
CREATE TABLE public.listing_status_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  from_status public.listing_status_enum,
  to_status public.listing_status_enum NOT NULL,
  actor_id uuid REFERENCES auth.users(id),
  actor_kind public.transition_actor_kind_enum NOT NULL,
  reason text,
  revision_at_transition integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Consistency Constraints
  CONSTRAINT chk_transition_system_actor CHECK (
    (actor_kind = 'system' AND actor_id IS NULL) OR
    (actor_kind IN ('seller', 'moderator') AND actor_id IS NOT NULL)
  ),
  CONSTRAINT chk_transition_reason_required CHECK (
    (to_status NOT IN ('rejected', 'removed')) OR
    (reason IS NOT NULL AND length(trim(reason)) > 0)
  )
);

-- Indexes
CREATE INDEX idx_listings_seller_id ON public.listings(seller_id);
CREATE INDEX idx_listings_status ON public.listings(status);
CREATE INDEX idx_listings_category_id ON public.listings(category_id);
CREATE INDEX idx_listings_city_id ON public.listings(city_id);
CREATE INDEX idx_listings_locality_id ON public.listings(locality_id);
CREATE INDEX idx_listings_status_expires_at ON public.listings(status, expires_at);
CREATE INDEX idx_listing_transitions_listing_id ON public.listing_status_transitions(listing_id, created_at);

-- 4. Helper Function: Slug Generator
CREATE OR REPLACE FUNCTION app_security.generate_listing_slug(p_title text)
RETURNS text
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_base text;
  v_random text;
BEGIN
  -- Lowercase and replace non-alphanumeric with hyphen
  v_base := regexp_replace(lower(p_title), '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from v_base);
  IF length(v_base) = 0 THEN
    v_base := 'item';
  ELSIF length(v_base) > 80 THEN
    v_base := substr(v_base, 1, 80);
  END IF;
  v_random := substr(md5(random()::text || clock_timestamp()::text), 1, 6);
  RETURN v_base || '-' || v_random;
END;
$$;

-- 5. Trigger Functions

-- BEFORE INSERT ON public.listings
CREATE OR REPLACE FUNCTION public.handle_listing_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  -- Set trusted immutable & default fields
  IF auth.uid() IS NOT NULL THEN
    NEW.seller_id := auth.uid();
  END IF;

  IF NEW.seller_id IS NULL THEN
    RAISE EXCEPTION 'seller_id is required';
  END IF;

  -- Slugs
  IF NEW.slug IS NULL OR length(trim(NEW.slug)) = 0 THEN
    NEW.slug := app_security.generate_listing_slug(NEW.title);
  END IF;

  -- Initial state is always draft, revision 1, 0 renewals
  NEW.status := 'draft'::public.listing_status_enum;
  NEW.revision := 1;
  NEW.renewal_count := 0;
  NEW.rejection_reason := NULL;
  NEW.removal_reason := NULL;
  NEW.removed_by := NULL;
  NEW.cover_photo_id := NULL; -- Must start NULL on create
  NEW.created_at := pg_catalog.clock_timestamp();
  NEW.updated_at := pg_catalog.clock_timestamp();
  NEW.submitted_at := NULL;
  NEW.published_at := NULL;
  NEW.expires_at := NULL;
  NEW.sold_at := NULL;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listings_before_insert
BEFORE INSERT ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_before_insert();

-- BEFORE UPDATE ON public.listings
CREATE OR REPLACE FUNCTION public.handle_listing_before_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_material_edit boolean := false;
BEGIN
  -- Immutability enforcement
  IF NEW.id != OLD.id THEN
    RAISE EXCEPTION 'listing id is immutable';
  END IF;
  IF NEW.seller_id != OLD.seller_id THEN
    RAISE EXCEPTION 'listing seller_id is immutable';
  END IF;
  IF NEW.created_at != OLD.created_at THEN
    RAISE EXCEPTION 'listing created_at is immutable';
  END IF;

  -- Check if user is changing content fields on active, reserved, or paused listing
  -- Binding Amendment 1: Closed paused-listing moderation bypass (active, reserved, paused)
  IF OLD.status IN ('active', 'reserved', 'paused') THEN
    IF (NEW.title IS DISTINCT FROM OLD.title) OR
       (NEW.description IS DISTINCT FROM OLD.description) OR
       (NEW.category_id IS DISTINCT FROM OLD.category_id) OR
       (NEW.condition IS DISTINCT FROM OLD.condition) OR
       (NEW.price_type IS DISTINCT FROM OLD.price_type) OR
       (NEW.price_paise IS DISTINCT FROM OLD.price_paise) OR
       (NEW.category_attributes IS DISTINCT FROM OLD.category_attributes) OR
       (NEW.cover_photo_id IS DISTINCT FROM OLD.cover_photo_id) THEN
      v_is_material_edit := true;
    END IF;

    IF v_is_material_edit THEN
      -- Strict re-review: transition to pending_review and increment revision
      NEW.status := 'pending_review'::public.listing_status_enum;
      NEW.revision := OLD.revision + 1;
      NEW.submitted_at := pg_catalog.clock_timestamp();
    END IF;
  END IF;

  -- Binding Amendment 2: rejected -> draft edit transition
  IF OLD.status = 'rejected' THEN
    IF (NEW.title IS DISTINCT FROM OLD.title) OR
       (NEW.description IS DISTINCT FROM OLD.description) OR
       (NEW.category_id IS DISTINCT FROM OLD.category_id) OR
       (NEW.city_id IS DISTINCT FROM OLD.city_id) OR
       (NEW.locality_id IS DISTINCT FROM OLD.locality_id) OR
       (NEW.condition IS DISTINCT FROM OLD.condition) OR
       (NEW.price_type IS DISTINCT FROM OLD.price_type) OR
       (NEW.price_paise IS DISTINCT FROM OLD.price_paise) OR
       (NEW.pin_code IS DISTINCT FROM OLD.pin_code) OR
       (NEW.category_attributes IS DISTINCT FROM OLD.category_attributes) OR
       (NEW.cover_photo_id IS DISTINCT FROM OLD.cover_photo_id) THEN
      -- Transition to draft, increment revision, clear rejection_reason from listing row
      NEW.status := 'draft'::public.listing_status_enum;
      NEW.revision := OLD.revision + 1;
      NEW.rejection_reason := NULL;
    END IF;
  END IF;

  NEW.updated_at := pg_catalog.clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listings_before_update
BEFORE UPDATE ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_before_update();

-- AFTER INSERT OR UPDATE OF status ON public.listings -> Record transition
CREATE OR REPLACE FUNCTION public.handle_listing_status_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor_id uuid;
  v_actor_kind public.transition_actor_kind_enum;
  v_reason text;
  v_is_system boolean;
BEGIN
  -- Determine if system context
  v_is_system := COALESCE(current_setting('app.is_system_transition', true) = 'true', false);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.listing_status_transitions (
      listing_id,
      from_status,
      to_status,
      actor_id,
      actor_kind,
      reason,
      revision_at_transition
    ) VALUES (
      NEW.id,
      NULL,
      NEW.status,
      NEW.seller_id,
      'seller'::public.transition_actor_kind_enum,
      'Initial creation',
      NEW.revision
    );
    RETURN NEW;
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF v_is_system THEN
      v_actor_id := NULL;
      v_actor_kind := 'system'::public.transition_actor_kind_enum;
      v_reason := COALESCE(NEW.removal_reason, 'System automatic transition');
    ELSIF NEW.status = 'rejected' THEN
      v_reason := COALESCE(NEW.rejection_reason, 'Listing rejected by moderator');
      IF auth.uid() IS NOT NULL THEN
        v_actor_id := auth.uid();
        v_actor_kind := 'moderator'::public.transition_actor_kind_enum;
      ELSE
        v_actor_id := NULL;
        v_actor_kind := 'system'::public.transition_actor_kind_enum;
      END IF;
    ELSIF NEW.status = 'removed' THEN
      v_reason := COALESCE(NEW.removal_reason, 'Listing removed by moderator');
      IF auth.uid() IS NOT NULL THEN
        v_actor_id := auth.uid();
        v_actor_kind := 'moderator'::public.transition_actor_kind_enum;
      ELSE
        v_actor_id := NULL;
        v_actor_kind := 'system'::public.transition_actor_kind_enum;
      END IF;
    ELSIF auth.uid() IS NOT NULL AND auth.uid() != NEW.seller_id THEN
      v_actor_id := auth.uid();
      v_actor_kind := 'moderator'::public.transition_actor_kind_enum;
      v_reason := 'Moderator action';
    ELSE
      v_actor_id := NEW.seller_id;
      v_actor_kind := 'seller'::public.transition_actor_kind_enum;
      v_reason := CASE
        WHEN OLD.status = 'rejected' AND NEW.status = 'draft' THEN 'Seller edited rejected listing'
        WHEN OLD.status IN ('active', 'reserved', 'paused') AND NEW.status = 'pending_review' THEN 'Material edit re-review'
        ELSE 'Seller status transition'
      END;
    END IF;

    -- Ensure non-empty reason for reject/remove
    IF NEW.status IN ('rejected', 'removed') AND (v_reason IS NULL OR length(trim(v_reason)) = 0) THEN
      v_reason := 'Action taken without specified reason';
    END IF;

    INSERT INTO public.listing_status_transitions (
      listing_id,
      from_status,
      to_status,
      actor_id,
      actor_kind,
      reason,
      revision_at_transition
    ) VALUES (
      NEW.id,
      OLD.status,
      NEW.status,
      v_actor_id,
      v_actor_kind,
      v_reason,
      NEW.revision
    );
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listings_after_status_change
AFTER INSERT OR UPDATE OF status ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_status_transition();

-- 6. Row Level Security & Explicit Grants

ALTER TABLE public.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.listing_status_transitions ENABLE ROW LEVEL SECURITY;

-- Revoke all by default
REVOKE ALL ON public.listings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.listing_status_transitions FROM PUBLIC, anon, authenticated;

-- Binding Amendment 5: Tighten anonymous database privileges for 1.3
-- Anon has NO SELECT or mutations on listings
GRANT SELECT ON public.listings TO authenticated;

-- Column-level INSERT grants for authenticated
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
  category_attributes
) ON public.listings TO authenticated;

-- Column-level UPDATE grants for authenticated (includes cover_photo_id)
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
  category_attributes,
  cover_photo_id
) ON public.listings TO authenticated;

-- Service role has full permissions
GRANT ALL ON public.listings TO service_role;
GRANT ALL ON public.listing_status_transitions TO service_role;
GRANT SELECT ON public.listing_status_transitions TO authenticated;

-- RLS Policies on public.listings
CREATE POLICY listings_select_policy ON public.listings
FOR SELECT USING (
  -- Owner can view own listings in any status
  seller_id = auth.uid()
  -- Staff with moderator or administrator role can view all
  OR app_security.is_active_staff_aal2('moderator')
  OR app_security.is_active_staff_aal2('administrator')
);

CREATE POLICY listings_insert_policy ON public.listings
FOR INSERT WITH CHECK (
  seller_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
);

CREATE POLICY listings_update_policy ON public.listings
FOR UPDATE USING (
  seller_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
  AND status IN ('draft', 'active', 'reserved', 'paused', 'rejected')
) WITH CHECK (
  seller_id = auth.uid()
  AND app_security.get_account_status(auth.uid()) = 'active'
);

-- RLS Policy on public.listing_status_transitions
CREATE POLICY listing_status_transitions_select_policy ON public.listing_status_transitions
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_status_transitions.listing_id
      AND (l.seller_id = auth.uid()
           OR app_security.is_active_staff_aal2('moderator')
           OR app_security.is_active_staff_aal2('administrator'))
  )
);
