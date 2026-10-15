-- A1-P only: intended metadata, not posting/submission enforcement.
-- One DO statement keeps DDL/assertions/backfill atomic, including direct execution.
-- Identity signatures come from migration 4; actual UUIDs are resolved, never invented.
DO $category_metadata$
DECLARE
  expected record;
  category_row public.categories%ROWTYPE;
  expected_attributes jsonb;
  actual_attributes jsonb;
BEGIN
  LOCK TABLE public.categories IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.category_attributes IN SHARE MODE;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.categories'::regclass AND NOT attisdropped
      AND attname IN ('macro_category', 'new_listing_enabled')
  ) THEN
    RAISE EXCEPTION 'A1P_UNEXPECTED_EXISTING_METADATA_COLUMNS';
  END IF;

  -- Repository history defines no category timestamp/audit triggers. Unexpected
  -- local triggers require review, not disabling or accepting hidden side effects.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.categories'::regclass AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'A1P_UNEXPECTED_CATEGORY_TRIGGER';
  END IF;

  FOR expected IN
    SELECT * FROM (VALUES
      ('electronics', 'Electronics', 'Phones, computers, audio, gadgets and accessories', 'laptop', 1,
       'goods', '[["brand","Brand","text",true,true,null,null,1],["model","Model","text",false,false,null,null,2],["storage_gb","Storage (GB)","number",false,true,null,null,3]]'::jsonb),
      ('furniture', 'Furniture', 'Sofas, tables, beds, storage, and home decor', 'armchair', 2,
       'goods', '[["material","Material","select",true,true,["wood","metal","plastic","fabric"],null,1],["dimensions","Dimensions (LxWxH cm)","text",false,false,null,null,2]]'::jsonb),
      ('home-appliances', 'Home Appliances', 'Kitchen, laundry, cooling, and heating appliances', 'refrigerator', 3,
       'goods', '[["appliance_type","Appliance Type","select",true,true,["kitchen","laundry","cooling","heating"],null,1],["brand","Brand","text",false,false,null,null,2]]'::jsonb),
      ('books', 'Books', 'Fiction, non-fiction, textbooks, comics, and stationery', 'book-open', 5,
       'goods', '[["author","Author","text",true,false,null,null,1],["language","Language","select",true,true,["English","Hindi","Other"],null,2],["isbn","ISBN","text",false,false,null,null,3]]'::jsonb),
      ('hobbies', 'Hobbies', 'Musical instruments, arts, crafts, and games', 'palette', 6,
       'goods', '[["hobby_type","Hobby Type","text",true,false,null,null,1]]'::jsonb),
      ('bicycles-sports', 'Bicycles & Sports', 'Bicycles, gym equipment, sportswear, and outdoor gear', 'bike', 4,
       NULL, '[["type","Bicycle / Equipment Type","select",true,true,["road","mountain","hybrid","kids"],null,1],["frame_size","Frame Size","text",false,false,null,null,2]]'::jsonb)
    ) AS identities(slug, name, description, icon, sort_order, macro_category, attributes)
  LOOP
    IF (SELECT count(*) FROM public.categories WHERE slug = expected.slug) <> 1 THEN
      RAISE EXCEPTION 'A1P_CATEGORY_IDENTITY_MISSING_OR_AMBIGUOUS: %', expected.slug;
    END IF;

    SELECT * INTO STRICT category_row FROM public.categories WHERE slug = expected.slug;
    IF ROW(category_row.name, category_row.description, category_row.icon, category_row.sort_order)
       IS DISTINCT FROM ROW(expected.name, expected.description, expected.icon, expected.sort_order) THEN
      RAISE EXCEPTION 'A1P_CATEGORY_FIELDS_MISMATCH: %', expected.slug;
    END IF;

    SELECT jsonb_agg(item ORDER BY item->>0) INTO expected_attributes
    FROM jsonb_array_elements(expected.attributes) AS definition(item);
    SELECT jsonb_agg(jsonb_build_array(
      name, label, value_type::text, is_required, is_filterable,
      options, validation_rules, sort_order
    ) ORDER BY name) INTO actual_attributes
    FROM public.category_attributes WHERE category_id = category_row.id;
    IF actual_attributes IS DISTINCT FROM expected_attributes THEN
      RAISE EXCEPTION 'A1P_CATEGORY_ATTRIBUTES_MISMATCH: %', expected.slug;
    END IF;
  END LOOP;

  ALTER TABLE public.categories
    ADD COLUMN macro_category text,
    ADD COLUMN new_listing_enabled boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT categories_macro_category_check
      CHECK (macro_category IS NULL OR macro_category IN ('goods', 'vehicles', 'property'));

  COMMENT ON COLUMN public.categories.macro_category IS
    'NULL means legacy mixed/unmapped, never Goods. A1-P metadata only; category_id remains canonical.';
  COMMENT ON COLUMN public.categories.new_listing_enabled IS
    'Intended new-assignment eligibility metadata; A1-P does not enforce posting. is_active remains independent.';

  UPDATE public.categories
  SET macro_category = CASE WHEN slug = 'bicycles-sports' THEN NULL ELSE 'goods' END,
      new_listing_enabled = true
  WHERE slug IN ('electronics', 'furniture', 'home-appliances', 'books', 'hobbies', 'bicycles-sports');
END;
$category_metadata$;
