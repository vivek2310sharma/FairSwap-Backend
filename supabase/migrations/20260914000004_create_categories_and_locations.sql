-- Migration 4: 20260914000004_create_categories_and_locations.sql
-- Categories, Category Attributes, Cities, Localities, RLS, Explicit Grants, and Pilot Seed Data

-- 1. Create attribute_value_type_enum
CREATE TYPE public.attribute_value_type_enum AS ENUM (
  'text',
  'number',
  'select',
  'boolean'
);

-- 2. Create public.categories
CREATE TABLE public.categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL CHECK (length(slug) >= 1 AND length(slug) <= 100),
  name text NOT NULL CHECK (length(name) >= 1 AND length(name) <= 100),
  description text CHECK (description IS NULL OR length(description) <= 500),
  icon text,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 3. Create public.category_attributes
CREATE TABLE public.category_attributes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid NOT NULL REFERENCES public.categories(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) >= 1 AND length(name) <= 100),
  label text NOT NULL CHECK (length(label) >= 1 AND length(label) <= 100),
  value_type public.attribute_value_type_enum NOT NULL,
  is_required boolean NOT NULL DEFAULT false,
  is_filterable boolean NOT NULL DEFAULT false,
  options jsonb,
  validation_rules jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_category_attribute_name UNIQUE (category_id, name)
);

-- 4. Create public.cities
CREATE TABLE public.cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) >= 1 AND length(name) <= 100),
  state text NOT NULL CHECK (length(state) >= 1 AND length(state) <= 100),
  slug text UNIQUE NOT NULL CHECK (length(slug) >= 1 AND length(slug) <= 100),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- 5. Create public.localities
CREATE TABLE public.localities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES public.cities(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) >= 1 AND length(name) <= 100),
  slug text NOT NULL CHECK (length(slug) >= 1 AND length(slug) <= 100),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uq_locality_city_slug UNIQUE (city_id, slug)
);

-- Indexes
CREATE INDEX idx_categories_is_active_sort ON public.categories(is_active, sort_order);
CREATE INDEX idx_category_attributes_category_id ON public.category_attributes(category_id, sort_order);
CREATE INDEX idx_cities_is_active ON public.cities(is_active);
CREATE INDEX idx_localities_city_id ON public.localities(city_id, is_active);

-- 6. RLS Policies
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.category_attributes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.localities ENABLE ROW LEVEL SECURITY;

-- categories SELECT: active for anon/authenticated, all for staff with content_editor or administrator
CREATE POLICY categories_select_policy ON public.categories
FOR SELECT USING (
  is_active = true
  OR app_security.is_active_staff_aal2('content_editor')
  OR app_security.is_active_staff_aal2('administrator')
  OR app_security.is_active_staff_aal2('moderator')
);

-- category_attributes SELECT: if parent category is active or caller is staff
CREATE POLICY category_attributes_select_policy ON public.category_attributes
FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.categories c
    WHERE c.id = category_attributes.category_id
      AND (c.is_active = true
           OR app_security.is_active_staff_aal2('content_editor')
           OR app_security.is_active_staff_aal2('administrator')
           OR app_security.is_active_staff_aal2('moderator'))
  )
);

-- cities SELECT: active for anon/authenticated, all for staff
CREATE POLICY cities_select_policy ON public.cities
FOR SELECT USING (
  is_active = true
  OR app_security.is_active_staff_aal2('administrator')
  OR app_security.is_active_staff_aal2('moderator')
);

-- localities SELECT: active for anon/authenticated, all for staff
CREATE POLICY localities_select_policy ON public.localities
FOR SELECT USING (
  is_active = true
  OR app_security.is_active_staff_aal2('administrator')
  OR app_security.is_active_staff_aal2('moderator')
);

-- Direct mutations denied to non-service roles (all managed via RPCs or service_role)

-- 7. Explicit PostgreSQL Grants
REVOKE ALL ON public.categories FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.category_attributes FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.cities FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.localities FROM PUBLIC, anon, authenticated;

GRANT SELECT ON public.categories TO anon, authenticated;
GRANT SELECT ON public.category_attributes TO anon, authenticated;
GRANT SELECT ON public.cities TO anon, authenticated;
GRANT SELECT ON public.localities TO anon, authenticated;

GRANT ALL ON public.categories TO service_role;
GRANT ALL ON public.category_attributes TO service_role;
GRANT ALL ON public.cities TO service_role;
GRANT ALL ON public.localities TO service_role;

-- 8. Deterministic Pilot Seed Data
DO $$
DECLARE
  v_electronics_id uuid;
  v_furniture_id uuid;
  v_appliances_id uuid;
  v_sports_id uuid;
  v_books_id uuid;
  v_hobbies_id uuid;
  v_jaipur_id uuid;
BEGIN
  -- Categories
  INSERT INTO public.categories (slug, name, description, icon, sort_order)
  VALUES ('electronics', 'Electronics', 'Phones, computers, audio, gadgets and accessories', 'laptop', 1)
  RETURNING id INTO v_electronics_id;

  INSERT INTO public.categories (slug, name, description, icon, sort_order)
  VALUES ('furniture', 'Furniture', 'Sofas, tables, beds, storage, and home decor', 'armchair', 2)
  RETURNING id INTO v_furniture_id;

  INSERT INTO public.categories (slug, name, description, icon, sort_order)
  VALUES ('home-appliances', 'Home Appliances', 'Kitchen, laundry, cooling, and heating appliances', 'refrigerator', 3)
  RETURNING id INTO v_appliances_id;

  INSERT INTO public.categories (slug, name, description, icon, sort_order)
  VALUES ('bicycles-sports', 'Bicycles & Sports', 'Bicycles, gym equipment, sportswear, and outdoor gear', 'bike', 4)
  RETURNING id INTO v_sports_id;

  INSERT INTO public.categories (slug, name, description, icon, sort_order)
  VALUES ('books', 'Books', 'Fiction, non-fiction, textbooks, comics, and stationery', 'book-open', 5)
  RETURNING id INTO v_books_id;

  INSERT INTO public.categories (slug, name, description, icon, sort_order)
  VALUES ('hobbies', 'Hobbies', 'Musical instruments, arts, crafts, and games', 'palette', 6)
  RETURNING id INTO v_hobbies_id;

  -- Category Attributes: Electronics
  INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, is_filterable, sort_order)
  VALUES
    (v_electronics_id, 'brand', 'Brand', 'text', true, true, 1),
    (v_electronics_id, 'model', 'Model', 'text', false, false, 2),
    (v_electronics_id, 'storage_gb', 'Storage (GB)', 'number', false, true, 3);

  -- Category Attributes: Furniture
  INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, is_filterable, options, sort_order)
  VALUES
    (v_furniture_id, 'material', 'Material', 'select', true, true, '["wood", "metal", "plastic", "fabric"]'::jsonb, 1),
    (v_furniture_id, 'dimensions', 'Dimensions (LxWxH cm)', 'text', false, false, NULL, 2);

  -- Category Attributes: Home Appliances
  INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, is_filterable, options, sort_order)
  VALUES
    (v_appliances_id, 'appliance_type', 'Appliance Type', 'select', true, true, '["kitchen", "laundry", "cooling", "heating"]'::jsonb, 1),
    (v_appliances_id, 'brand', 'Brand', 'text', false, false, NULL, 2);

  -- Category Attributes: Bicycles & Sports
  INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, is_filterable, options, sort_order)
  VALUES
    (v_sports_id, 'type', 'Bicycle / Equipment Type', 'select', true, true, '["road", "mountain", "hybrid", "kids"]'::jsonb, 1),
    (v_sports_id, 'frame_size', 'Frame Size', 'text', false, false, NULL, 2);

  -- Category Attributes: Books
  INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, is_filterable, options, sort_order)
  VALUES
    (v_books_id, 'author', 'Author', 'text', true, false, NULL, 1),
    (v_books_id, 'language', 'Language', 'select', true, true, '["English", "Hindi", "Other"]'::jsonb, 2),
    (v_books_id, 'isbn', 'ISBN', 'text', false, false, NULL, 3);

  -- Category Attributes: Hobbies
  INSERT INTO public.category_attributes (category_id, name, label, value_type, is_required, is_filterable, sort_order)
  VALUES
    (v_hobbies_id, 'hobby_type', 'Hobby Type', 'text', true, false, 1);

  -- Pilot Location: Jaipur, Rajasthan
  INSERT INTO public.cities (name, state, slug, is_active)
  VALUES ('Jaipur', 'Rajasthan', 'jaipur', true)
  RETURNING id INTO v_jaipur_id;

  INSERT INTO public.localities (city_id, name, slug, is_active)
  VALUES
    (v_jaipur_id, 'Malviya Nagar', 'malviya-nagar', true),
    (v_jaipur_id, 'Vaishali Nagar', 'vaishali-nagar', true),
    (v_jaipur_id, 'Mansarovar', 'mansarovar', true),
    (v_jaipur_id, 'C-Scheme', 'c-scheme', true),
    (v_jaipur_id, 'Raja Park', 'raja-park', true);
END $$;
