-- FairSwap Post Ad Issue #133: new-listing INSERT-only eligibility.
-- Additive/fail-closed. Keeps existing owner/account/policy predicates; does not
-- alter UPDATE/SELECT, category metadata, family submission or moderation.
-- Helper is SECURITY INVOKER and checks only caller-visible active categories.
-- PL/pgSQL function avoids a catalog dependency on metadata columns, so the
-- historical disposable schema_post_ad_category_metadata replay still works.
-- One DO statement: direct execution and all assertions are atomic.
DO $post_ad_insert_guard$
DECLARE
  v_policy pg_catalog.pg_policy%ROWTYPE;
  v_before text;
  v_after text;
  v_fn oid;
BEGIN
  IF pg_catalog.to_regprocedure('app_security.is_new_listing_category_eligible(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_HELPER_ALREADY_EXISTS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.categories'::pg_catalog.regclass
      AND attname = 'macro_category' AND NOT attisdropped
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute
    WHERE attrelid = 'public.categories'::pg_catalog.regclass
      AND attname = 'new_listing_enabled' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_METADATA_NOT_INSTALLED';
  END IF;

  SELECT p.* INTO v_policy
  FROM pg_catalog.pg_policy AS p
  WHERE p.polrelid = 'public.listings'::pg_catalog.regclass
    AND p.polname = 'listings_insert_policy';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_POLICY_MISSING';
  END IF;
  v_before := pg_catalog.pg_get_expr(v_policy.polwithcheck, v_policy.polrelid, true);
  IF v_policy.polcmd <> 'a'
    OR NOT v_policy.polpermissive
    OR v_policy.polroles::text <> '{0}'
    OR v_before IS DISTINCT FROM
      'seller_id = auth.uid() AND app_security.get_account_status(auth.uid()) = ''active''::account_status_enum AND app_security.has_current_policy_acceptance(auth.uid())'
  THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_UNEXPECTED_EXISTING_POLICY';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid = 'public.listings'::pg_catalog.regclass AND relrowsecurity)
    OR NOT pg_catalog.has_schema_privilege('authenticated', 'app_security', 'USAGE')
    OR NOT pg_catalog.has_table_privilege('authenticated', 'public.categories', 'SELECT')
  THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_UNEXPECTED_SECURITY_BASELINE';
  END IF;
  -- Preserve current Goods eligibility and the deliberately unmapped legacy category.
  IF (SELECT COUNT(*) FROM public.categories
      WHERE slug IN ('electronics','furniture','home-appliances','books','hobbies')
        AND macro_category = 'goods' AND is_active AND new_listing_enabled) <> 5
    OR (SELECT COUNT(*) FROM public.categories
        WHERE slug='bicycles-sports' AND macro_category IS NULL) <> 1
  THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_CATEGORY_BASELINE_CHANGED';
  END IF;

  EXECUTE $function$
    CREATE FUNCTION app_security.is_new_listing_category_eligible(p_category_id uuid)
    RETURNS boolean
    LANGUAGE plpgsql
    STABLE
    STRICT
    SECURITY INVOKER
    SET search_path = ''
    AS $body$
    BEGIN
      RETURN EXISTS (
        SELECT 1
        FROM public.categories AS c
        WHERE c.id = p_category_id
          AND c.is_active = true
          AND c.new_listing_enabled = true
          AND c.macro_category IN ('goods', 'vehicles', 'property')
      );
    END;
    $body$;
  $function$;
  EXECUTE 'REVOKE ALL ON FUNCTION app_security.is_new_listing_category_eligible(uuid) FROM PUBLIC, anon, service_role';
  EXECUTE 'GRANT EXECUTE ON FUNCTION app_security.is_new_listing_category_eligible(uuid) TO authenticated';
  EXECUTE $policy$
    ALTER POLICY listings_insert_policy ON public.listings
    WITH CHECK (
      seller_id = auth.uid()
      AND app_security.get_account_status(auth.uid()) = 'active'::public.account_status_enum
      AND app_security.has_current_policy_acceptance(auth.uid())
      AND app_security.is_new_listing_category_eligible(category_id)
    )
  $policy$;

  SELECT p.oid INTO v_fn
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'app_security.is_new_listing_category_eligible(uuid)'::pg_catalog.regprocedure
    AND p.provolatile = 's' AND NOT p.prosecdef AND p.proisstrict
    AND p.proconfig @> ARRAY['search_path=""']::text[];
  IF v_fn IS NULL
    OR NOT pg_catalog.has_function_privilege('authenticated',v_fn,'EXECUTE')
    OR pg_catalog.has_function_privilege('anon',v_fn,'EXECUTE')
    OR pg_catalog.has_function_privilege('service_role',v_fn,'EXECUTE')
  THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_HELPER_SECURITY_FAILURE';
  END IF;
  SELECT pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,true) INTO v_after
  FROM pg_catalog.pg_policy AS p
  WHERE p.polrelid = 'public.listings'::pg_catalog.regclass
    AND p.polname = 'listings_insert_policy';
  IF v_after IS NULL OR pg_catalog.strpos(v_after, 'app_security.is_new_listing_category_eligible(category_id)') = 0
    OR pg_catalog.strpos(v_after, 'app_security.has_current_policy_acceptance(auth.uid())') = 0
    OR pg_catalog.strpos(v_after, 'app_security.get_account_status(auth.uid())') = 0
  THEN
    RAISE EXCEPTION 'POST_AD_INSERT_GUARD_POLICY_POSTCHECK_FAILURE';
  END IF;
END;
$post_ad_insert_guard$;
