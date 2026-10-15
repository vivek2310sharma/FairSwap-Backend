-- Migration 6: 20260914000006_create_listing_media.sql
-- Listing Media, Image Processing Tracking, Material Edit Re-Review Triggers, and RLS

-- 1. Create media_processing_status_enum
CREATE TYPE public.media_processing_status_enum AS ENUM (
  'uploading',
  'processing',
  'ready',
  'failed'
);

-- 2. Create public.listing_media
CREATE TABLE public.listing_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES public.listings(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  original_storage_path text,
  thumbnail_storage_path text,
  medium_storage_path text,
  large_storage_path text,
  original_filename text NOT NULL CHECK (length(original_filename) >= 1 AND length(original_filename) <= 255),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  file_size_bytes integer NOT NULL CHECK (file_size_bytes > 0 AND file_size_bytes <= 5242880),
  width integer,
  height integer,
  display_order integer NOT NULL DEFAULT 0,
  processing_status public.media_processing_status_enum NOT NULL DEFAULT 'uploading',
  processing_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Indexes
CREATE INDEX idx_listing_media_listing_id ON public.listing_media(listing_id, display_order);
CREATE INDEX idx_listing_media_processing_status ON public.listing_media(processing_status);

-- 3. Add FK from listings.cover_photo_id to listing_media(id)
ALTER TABLE public.listings
ADD CONSTRAINT fk_listings_cover_photo
FOREIGN KEY (cover_photo_id) REFERENCES public.listing_media(id)
ON DELETE SET NULL;

-- 4. Validate cover_photo_id on listings
CREATE OR REPLACE FUNCTION public.validate_listing_cover_photo()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_media_listing_id uuid;
  v_media_status public.media_processing_status_enum;
BEGIN
  IF NEW.cover_photo_id IS NOT NULL THEN
    SELECT listing_id, processing_status
    INTO v_media_listing_id, v_media_status
    FROM public.listing_media
    WHERE id = NEW.cover_photo_id;

    IF v_media_listing_id IS NULL OR v_media_listing_id != NEW.id THEN
      RAISE EXCEPTION 'cover photo must belong to the same listing';
    END IF;

    IF v_media_status != 'ready' THEN
      RAISE EXCEPTION 'cover photo must have processing_status = ready';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listings_validate_cover_photo
BEFORE INSERT OR UPDATE OF cover_photo_id ON public.listings
FOR EACH ROW
EXECUTE FUNCTION public.validate_listing_cover_photo();

-- 5. Trigger: BEFORE INSERT ON public.listing_media
CREATE OR REPLACE FUNCTION public.handle_listing_media_before_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_count integer;
  v_seller_id uuid;
  v_max_order integer;
BEGIN
  -- Verify listing exists and get seller_id
  SELECT seller_id INTO v_seller_id
  FROM public.listings
  WHERE id = NEW.listing_id;

  IF v_seller_id IS NULL THEN
    RAISE EXCEPTION 'listing not found';
  END IF;

  -- Verify ownership
  IF auth.uid() IS NOT NULL AND auth.uid() != v_seller_id THEN
    RAISE EXCEPTION 'caller does not own this listing';
  END IF;

  IF auth.uid() IS NOT NULL THEN
    NEW.uploader_id := auth.uid();
  ELSIF NEW.uploader_id IS NULL THEN
    NEW.uploader_id := v_seller_id;
  END IF;

  -- Enforce photo count limit (max 8)
  SELECT count(*) INTO v_count
  FROM public.listing_media
  WHERE listing_id = NEW.listing_id;

  IF v_count >= 8 THEN
    RAISE EXCEPTION 'maximum 8 photos per listing exceeded';
  END IF;

  -- Default display_order to next available if 0 or default
  IF NEW.display_order = 0 THEN
    SELECT COALESCE(max(display_order) + 1, 0) INTO v_max_order
    FROM public.listing_media
    WHERE listing_id = NEW.listing_id;
    NEW.display_order := v_max_order;
  END IF;

  NEW.processing_status := 'uploading'::public.media_processing_status_enum;
  NEW.created_at := pg_catalog.clock_timestamp();

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_media_before_insert
BEFORE INSERT ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_before_insert();

-- 6. Helper: Trigger Material Re-Review on Parent Listing
CREATE OR REPLACE FUNCTION app_security.trigger_listing_media_rereview(p_listing_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_status public.listing_status_enum;
  v_revision integer;
BEGIN
  SELECT status, revision INTO v_status, v_revision
  FROM public.listings
  WHERE id = p_listing_id
  FOR UPDATE;

  -- Binding Amendment 1: closed paused-listing moderation bypass (active, reserved, paused)
  IF v_status IN ('active', 'reserved', 'paused') THEN
    UPDATE public.listings
    SET status = 'pending_review'::public.listing_status_enum,
        revision = v_revision + 1,
        submitted_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_listing_id;

    -- Note: handle_listing_status_transition trigger automatically records the transition
  END IF;
END;
$$;

-- AFTER INSERT ON listing_media
CREATE OR REPLACE FUNCTION public.handle_listing_media_after_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.trigger_listing_media_rereview(NEW.listing_id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_media_after_insert
AFTER INSERT ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_after_insert();

-- AFTER DELETE ON listing_media
CREATE OR REPLACE FUNCTION public.handle_listing_media_after_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM app_security.trigger_listing_media_rereview(OLD.listing_id);
  RETURN OLD;
END;
$$;

CREATE TRIGGER trg_listing_media_after_delete
AFTER DELETE ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_after_delete();

-- AFTER UPDATE OF display_order ON listing_media (reorder re-review)
CREATE OR REPLACE FUNCTION public.handle_listing_media_after_reorder()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.display_order IS DISTINCT FROM NEW.display_order THEN
    PERFORM app_security.trigger_listing_media_rereview(NEW.listing_id);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_listing_media_after_reorder
AFTER UPDATE OF display_order ON public.listing_media
FOR EACH ROW
EXECUTE FUNCTION public.handle_listing_media_after_reorder();

-- 7. RLS & Grants for listing_media

ALTER TABLE public.listing_media ENABLE ROW LEVEL SECURITY;

-- Revoke all by default
REVOKE ALL ON public.listing_media FROM PUBLIC, anon, authenticated;

-- Binding Amendment 3: Remove direct authenticated DELETE access from listing_media
-- Authenticated gets SELECT, column-level INSERT, and column-level UPDATE (display_order) ONLY
GRANT SELECT ON public.listing_media TO authenticated;

GRANT INSERT (
  listing_id,
  original_filename,
  content_type,
  file_size_bytes
) ON public.listing_media TO authenticated;

GRANT UPDATE (
  display_order
) ON public.listing_media TO authenticated;

-- Full access to service_role (used by server route handlers and processing RPCs)
GRANT ALL ON public.listing_media TO service_role;

-- RLS Policies on public.listing_media
CREATE POLICY listing_media_select_policy ON public.listing_media
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND (l.seller_id = auth.uid()
           OR app_security.is_active_staff_aal2('moderator')
           OR app_security.is_active_staff_aal2('administrator'))
  )
);

CREATE POLICY listing_media_insert_policy ON public.listing_media
FOR INSERT WITH CHECK (
  uploader_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'
  )
);

CREATE POLICY listing_media_update_policy ON public.listing_media
FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.listings l
    WHERE l.id = listing_media.listing_id
      AND l.seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'
  )
);

-- NOTICE: No DELETE policy for authenticated. Any attempt to DELETE from Data API will be rejected by RLS and lack of GRANT.
