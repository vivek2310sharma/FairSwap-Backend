-- =============================================================================
-- Test: Pending-Review Media Mutation Revision Invalidation
-- =============================================================================
-- Requires disposable local test database with pgTAP.
-- Evaluates the contract that review-visible media mutations while a listing is
-- in 'pending_review' increment listings.revision, invalidating prior review contexts.
-- =============================================================================

BEGIN;
SELECT plan(31);

-- =============================================================================
-- 1. Helper Structure and Routine Privilege Verification (15 structural checks: 5 has_function, 8 function_privs_are, 2 ok)
-- =============================================================================
SELECT has_function('app_security', 'trigger_listing_media_rereview', ARRAY['uuid'], 'trigger_listing_media_rereview exists');
SELECT has_function('app_security', 'impl_record_media_processing_result', ARRAY['uuid', 'jsonb', 'jsonb', 'text', 'text'], 'impl_record_media_processing_result exists');
SELECT has_function('app_security', 'impl_seller_reorder_listing_media', ARRAY['uuid', 'uuid[]'], 'impl_seller_reorder_listing_media exists');
SELECT has_function('app_security', 'impl_seller_set_listing_cover_photo', ARRAY['uuid', 'uuid'], 'impl_seller_set_listing_cover_photo exists');
SELECT has_function('app_security', 'impl_seller_delete_listing_media', ARRAY['uuid', 'uuid'], 'impl_seller_delete_listing_media exists');

SELECT function_privs_are('app_security', 'trigger_listing_media_rereview', ARRAY['uuid'], 'anon', ARRAY[]::text[], 'anon cannot call trigger_listing_media_rereview');
SELECT function_privs_are('app_security', 'trigger_listing_media_rereview', ARRAY['uuid'], 'authenticated', ARRAY[]::text[], 'authenticated cannot call trigger_listing_media_rereview directly');
SELECT function_privs_are('app_security', 'trigger_listing_media_rereview', ARRAY['uuid'], 'service_role', ARRAY['EXECUTE'], 'service_role can call trigger_listing_media_rereview');

SELECT function_privs_are('app_security', 'impl_seller_reorder_listing_media', ARRAY['uuid', 'uuid[]'], 'authenticated', ARRAY['EXECUTE'], 'authenticated can call impl_seller_reorder_listing_media');
SELECT function_privs_are('public', 'seller_reorder_listing_media', ARRAY['uuid', 'uuid[]'], 'authenticated', ARRAY['EXECUTE'], 'authenticated can call seller_reorder_listing_media wrapper');

SELECT function_privs_are('app_security', 'impl_seller_set_listing_cover_photo', ARRAY['uuid', 'uuid'], 'authenticated', ARRAY['EXECUTE'], 'authenticated can call impl_seller_set_listing_cover_photo');
SELECT function_privs_are('public', 'seller_set_listing_cover_photo', ARRAY['uuid', 'uuid'], 'authenticated', ARRAY['EXECUTE'], 'authenticated can call seller_set_listing_cover_photo wrapper');

SELECT function_privs_are('app_security', 'impl_record_media_processing_result', ARRAY['uuid', 'jsonb', 'jsonb', 'text', 'text'], 'service_role', ARRAY['EXECUTE'], 'service_role can call impl_record_media_processing_result');

-- Verify statement-level reorder trigger exists on public.listing_media
SELECT ok(EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgname = 'trg_listing_media_reorder_statement'
), 'statement-level reorder trigger exists');

-- Verify BEFORE DELETE trigger exists on public.listing_media
SELECT ok(EXISTS (
  SELECT 1 FROM pg_trigger WHERE tgname = 'trg_listing_media_before_delete'
), 'before delete rereview trigger exists');

-- =============================================================================
-- 2. Synthetic Test Harness Setup
-- Creates deterministic categories, cities, users with valid consent metadata,
-- explicit timestamps, and listings initialized to valid starting states.
-- =============================================================================
CREATE TEMPORARY TABLE test_ids (
  seller_id uuid,
  other_user_id uuid,
  mod_id uuid,
  cat_id uuid,
  city_id uuid,
  listing_pending_1 uuid,
  listing_pending_2 uuid,
  listing_active uuid,
  listing_reserved uuid,
  listing_paused uuid,
  listing_direct uuid,
  m_p1_1 uuid,
  m_p1_2 uuid,
  m_p1_3 uuid,
  m_p1_unready uuid,
  m_p2_1 uuid,
  m_p2_2 uuid,
  m_active_cover uuid,
  m_active_other uuid,
  m_reserved_cover uuid,
  m_paused_cover uuid,
  m_direct_1 uuid,
  m_direct_2 uuid
);

DO $setup$
DECLARE
  v_seller uuid := '11111111-0000-4000-8000-000000000001'::uuid;
  v_other uuid := '22222222-0000-4000-8000-000000000002'::uuid;
  v_mod uuid := '33333333-0000-4000-8000-000000000003'::uuid;
  v_cat uuid := '77777777-0000-4000-8000-000000000001'::uuid;
  v_city uuid := '88888888-0000-4000-8000-000000000001'::uuid;

  v_lp1 uuid := '44444444-0000-4000-8000-000000000001'::uuid;
  v_lp2 uuid := '44444444-0000-4000-8000-000000000002'::uuid;
  v_la uuid := '44444444-0000-4000-8000-000000000003'::uuid;
  v_lr uuid := '44444444-0000-4000-8000-000000000004'::uuid;
  v_lpa uuid := '44444444-0000-4000-8000-000000000005'::uuid;
  v_ldir uuid := '44444444-0000-4000-8000-000000000006'::uuid;

  v_m1 uuid := '55555555-0000-4000-8000-000000000001'::uuid;
  v_m2 uuid := '55555555-0000-4000-8000-000000000002'::uuid;
  v_m3 uuid := '55555555-0000-4000-8000-000000000003'::uuid;
  v_mu uuid := '55555555-0000-4000-8000-000000000004'::uuid;

  v_p2_1 uuid := '55555555-0000-4000-8000-000000000005'::uuid;
  v_p2_2 uuid := '55555555-0000-4000-8000-000000000006'::uuid;

  v_mac uuid := '55555555-0000-4000-8000-000000000007'::uuid;
  v_mao uuid := '55555555-0000-4000-8000-000000000008'::uuid;
  v_mrc uuid := '55555555-0000-4000-8000-000000000009'::uuid;
  v_mpc uuid := '55555555-0000-4000-8000-000000000010'::uuid;

  v_md1 uuid := '55555555-0000-4000-8000-000000000011'::uuid;
  v_md2 uuid := '55555555-0000-4000-8000-000000000012'::uuid;

  v_now timestamptz := clock_timestamp();
BEGIN
  -- 1. Deterministic category & city
  INSERT INTO public.categories (id, slug, name, sort_order, is_active)
  VALUES (v_cat, 'test-cat', 'Test Category', 1, true)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.cities (id, name, state, slug, is_active)
  VALUES (v_city, 'Test City', 'State', 'test-city', true)
  ON CONFLICT (id) DO NOTHING;

  -- 2. Auth users with complete mandatory consent metadata AND explicit timestamps
  INSERT INTO auth.users (id, email, raw_user_meta_data, created_at, updated_at)
  VALUES
    (v_seller, 'seller@test.fairswap.local', jsonb_build_object(
      'display_name', 'Test Seller',
      'terms_accepted', 'true',
      'terms_version', '2026-09-18',
      'privacy_policy_version', '2026-09-18',
      'acceptable_use_version', '2026-09-18',
      'age_confirmed', 'true'
    ), v_now, v_now),
    (v_other, 'other@test.fairswap.local', jsonb_build_object(
      'display_name', 'Test Other',
      'terms_accepted', 'true',
      'terms_version', '2026-09-18',
      'privacy_policy_version', '2026-09-18',
      'acceptable_use_version', '2026-09-18',
      'age_confirmed', 'true'
    ), v_now, v_now),
    (v_mod, 'mod@test.fairswap.local', jsonb_build_object(
      'display_name', 'Test Moderator',
      'terms_accepted', 'true',
      'terms_version', '2026-09-18',
      'privacy_policy_version', '2026-09-18',
      'acceptable_use_version', '2026-09-18',
      'age_confirmed', 'true'
    ), v_now, v_now)
  ON CONFLICT (id) DO NOTHING;

  -- Verify provisioned accounts exist for all identities with valid NOT NULL timestamps
  IF NOT EXISTS (
    SELECT 1 FROM public.user_accounts
    WHERE user_id = v_seller AND account_status = 'active'
      AND created_at IS NOT NULL AND updated_at IS NOT NULL AND terms_accepted_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_seller AND created_at IS NOT NULL AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SETUP_FAIL: Seller account or profile was not properly provisioned';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_accounts
    WHERE user_id = v_other AND account_status = 'active'
      AND created_at IS NOT NULL AND updated_at IS NOT NULL AND terms_accepted_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_other AND created_at IS NOT NULL AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SETUP_FAIL: Other user account or profile was not properly provisioned';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_accounts
    WHERE user_id = v_mod AND account_status = 'active'
      AND created_at IS NOT NULL AND updated_at IS NOT NULL AND terms_accepted_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = v_mod AND created_at IS NOT NULL AND updated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'SETUP_FAIL: Moderator account or profile was not properly provisioned';
  END IF;

  -- Policy acceptances
  INSERT INTO public.policy_acceptance_records (user_id, terms_version, privacy_policy_version, acceptable_use_version, minimum_age_confirmed)
  VALUES
    (v_seller, '2026-09-18', '2026-09-18', '2026-09-18', 18),
    (v_other, '2026-09-18', '2026-09-18', '2026-09-18', 18),
    (v_mod, '2026-09-18', '2026-09-18', '2026-09-18', 18)
  ON CONFLICT DO NOTHING;

  -- Staff role for moderator
  INSERT INTO public.staff_roles (user_id, role)
  VALUES (v_mod, 'moderator')
  ON CONFLICT (user_id) DO UPDATE SET role = 'moderator';

  -- 3. Listings
  -- Note: INSERT triggers force draft, revision 1. We insert then update to target states.
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, condition, price_type, price_paise)
  VALUES
    (v_lp1, v_seller, 'Listing Pending 1', 'Description for listing pending 1', v_cat, v_city, 'good', 'fixed', 10000),
    (v_lp2, v_seller, 'Listing Pending 2', 'Description for listing pending 2', v_cat, v_city, 'good', 'fixed', 15000),
    (v_la, v_seller, 'Listing Active', 'Description for listing active', v_cat, v_city, 'good', 'fixed', 20000),
    (v_lr, v_seller, 'Listing Reserved', 'Description for listing reserved', v_cat, v_city, 'good', 'fixed', 25000),
    (v_lpa, v_seller, 'Listing Paused', 'Description for listing paused', v_cat, v_city, 'good', 'fixed', 30000),
    (v_ldir, v_seller, 'Listing Direct', 'Description for listing direct', v_cat, v_city, 'good', 'fixed', 35000);

  -- 4. Media rows (with full required metadata: filename, content_type, file_size_bytes)
  INSERT INTO public.listing_media (id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes)
  VALUES
    (v_m1, v_lp1, v_seller, 0, '1.jpg', 'image/jpeg', 1024),
    (v_m2, v_lp1, v_seller, 1, '2.jpg', 'image/jpeg', 1024),
    (v_m3, v_lp1, v_seller, 2, '3.jpg', 'image/jpeg', 1024),
    (v_mu, v_lp1, v_seller, 3, 'u.jpg', 'image/jpeg', 1024),

    (v_p2_1, v_lp2, v_seller, 0, 'p2_1.jpg', 'image/jpeg', 1024),
    (v_p2_2, v_lp2, v_seller, 1, 'p2_2.jpg', 'image/jpeg', 1024),

    (v_mac, v_la, v_seller, 0, 'mac.jpg', 'image/jpeg', 1024),
    (v_mao, v_la, v_seller, 1, 'mao.jpg', 'image/jpeg', 1024),
    (v_mrc, v_lr, v_seller, 0, 'mrc.jpg', 'image/jpeg', 1024),
    (v_mpc, v_lpa, v_seller, 0, 'mpc.jpg', 'image/jpeg', 1024),

    (v_md1, v_ldir, v_seller, 0, 'md1.jpg', 'image/jpeg', 1024),
    (v_md2, v_ldir, v_seller, 1, 'md2.jpg', 'image/jpeg', 1024);

  -- Transition media to ready (except v_mu which stays uploading)
  UPDATE public.listing_media
  SET processing_status = 'ready', original_storage_path = 'path/' || id || '.jpg'
  WHERE id IN (v_m1, v_m2, v_m3, v_p2_1, v_p2_2, v_mac, v_mao, v_mrc, v_mpc, v_md1, v_md2);

  -- Set covers and final initial states on listings
  UPDATE public.listings SET cover_photo_id = v_m1, status = 'pending_review', revision = 1 WHERE id = v_lp1;
  UPDATE public.listings SET cover_photo_id = v_p2_1, status = 'pending_review', revision = 1 WHERE id = v_lp2;
  UPDATE public.listings SET cover_photo_id = v_mac, status = 'active', revision = 1 WHERE id = v_la;
  UPDATE public.listings SET cover_photo_id = v_mrc, status = 'reserved', revision = 1 WHERE id = v_lr;
  UPDATE public.listings SET cover_photo_id = v_mpc, status = 'paused', revision = 1 WHERE id = v_lpa;
  UPDATE public.listings SET cover_photo_id = v_md1, status = 'pending_review', revision = 1 WHERE id = v_ldir;

  INSERT INTO test_ids VALUES (
    v_seller, v_other, v_mod, v_cat, v_city,
    v_lp1, v_lp2, v_la, v_lr, v_lpa, v_ldir,
    v_m1, v_m2, v_m3, v_mu, v_p2_1, v_p2_2,
    v_mac, v_mao, v_mrc, v_mpc, v_md1, v_md2
  );
END;
$setup$;

-- =============================================================================
-- 3. Behavioral Test 1: Non-ready to ready transitions advance revision
-- Service-role finalizer RPC caller boundary test
-- =============================================================================
DO $test1$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_rev_before integer;
  v_rev_after integer;
  v_status_after public.listing_status_enum;
  v_res jsonb;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;
  SELECT revision INTO STRICT v_rev_before FROM public.listings WHERE id = v_ctx.listing_pending_1;

  -- Call processing result RPC under service_role
  SET LOCAL ROLE service_role;
  v_res := public.record_media_processing_result(
    v_ctx.m_p1_unready,
    '{"original": "path/u.jpg", "thumbnail": "path/t.jpg", "medium": "path/m.jpg", "large": "path/l.jpg"}'::jsonb,
    '{"width": 800, "height": 600}'::jsonb,
    'ready'
  );
  RESET ROLE;

  IF (v_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST1_FAIL: Finalizer returned failure: %', v_res;
  END IF;

  SELECT revision, status INTO STRICT v_rev_after, v_status_after FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF v_rev_after != v_rev_before + 1 OR v_status_after != 'pending_review' THEN
    RAISE EXCEPTION 'TEST1_FAIL: Expected revision %, got %; status %', v_rev_before + 1, v_rev_after, v_status_after;
  END IF;
END;
$test1$;

SELECT is(
  (SELECT revision FROM public.listings WHERE id = (SELECT listing_pending_1 FROM test_ids LIMIT 1)),
  2,
  'Non-ready media reaching ready status advances revision by exactly 1 and maintains pending_review'
);

-- =============================================================================
-- 4. Behavioral Test 2: Stale review revision fails moderate_listing_reviewed with PT409
-- =============================================================================
DO $test2$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_err_code text;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- Set session to authenticated role and moderator identity with AAL2
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.mod_id,
    'role', 'authenticated',
    'aal', 'aal2'
  )::text, true);

  -- Attempt approval with stale expected_revision = 1 (current is 2)
  BEGIN
    PERFORM public.moderate_listing_reviewed(
      v_ctx.listing_pending_1,
      'approve',
      NULL,
      1, -- STALE
      'pending_review'
    );
    RAISE EXCEPTION 'CONTROL_FAIL: Stale revision approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_code = RETURNED_SQLSTATE;
    IF v_err_code != 'PT409' THEN
      RAISE EXCEPTION 'TEST2_FAIL: Expected PT409, got %: %', v_err_code, SQLERRM;
    END IF;
  END;

  -- Attempt rejection with stale expected_revision = 1 (current is 2)
  BEGIN
    PERFORM public.moderate_listing_reviewed(
      v_ctx.listing_pending_1,
      'reject',
      'Images do not match description',
      1, -- STALE
      'pending_review'
    );
    RAISE EXCEPTION 'CONTROL_FAIL: Stale revision rejection unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_code = RETURNED_SQLSTATE;
    IF v_err_code != 'PT409' THEN
      RAISE EXCEPTION 'TEST2_FAIL: Expected PT409 for rejection, got %: %', v_err_code, SQLERRM;
    END IF;
  END;
END;
$test2$;
RESET ROLE;

SELECT pass('Stale revision fails both reviewed approval and reviewed rejection with SQLSTATE PT409');

-- =============================================================================
-- 5. Behavioral Test 3: Fresh review context succeeds on separate fixture (Positive Control)
-- =============================================================================
DO $test3$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_res jsonb;
  v_status_after public.listing_status_enum;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.mod_id,
    'role', 'authenticated',
    'aal', 'aal2'
  )::text, true);

  -- Use listing_pending_2 which has matching revision 1
  v_res := public.moderate_listing_reviewed(
    v_ctx.listing_pending_2,
    'approve',
    NULL,
    1, -- MATCHING
    'pending_review'
  );

  IF (v_res->>'success')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST3_FAIL: Reviewed approval returned failure: %', v_res;
  END IF;

  SELECT status INTO STRICT v_status_after FROM public.listings WHERE id = v_ctx.listing_pending_2;
  IF v_status_after != 'active' THEN
    RAISE EXCEPTION 'TEST3_FAIL: Fresh review failed to transition status to active; got %', v_status_after;
  END IF;
END;
$test3$;
RESET ROLE;

SELECT pass('Fresh review with matching revision succeeds as authoritative decision control');

-- =============================================================================
-- 6. Behavioral Test 4: Media Reorder in pending_review
-- Order change -> revision + 1; Same order no-op -> changed=false and no revision bump
-- =============================================================================
DO $test4$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_rev_before integer;
  v_res jsonb;
  v_rev_after integer;
  v_order_persisted uuid[];
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  SELECT revision INTO STRICT v_rev_before FROM public.listings WHERE id = v_ctx.listing_pending_1;

  -- 1. Effective reorder: swap media 1 and media 2
  v_res := public.seller_reorder_listing_media(
    v_ctx.listing_pending_1,
    ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1, v_ctx.m_p1_3, v_ctx.m_p1_unready]
  );

  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'changed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST4_FAIL: Reorder call failed or changed!=true: %', v_res;
  END IF;

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_pending_1;
  SELECT array_agg(id ORDER BY display_order ASC) INTO STRICT v_order_persisted
  FROM public.listing_media WHERE listing_id = v_ctx.listing_pending_1;

  IF v_rev_after != v_rev_before + 1 THEN
    RAISE EXCEPTION 'TEST4_FAIL: Reorder failed to increment revision: % -> %', v_rev_before, v_rev_after;
  END IF;

  IF v_order_persisted IS DISTINCT FROM ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1, v_ctx.m_p1_3, v_ctx.m_p1_unready] THEN
    RAISE EXCEPTION 'TEST4_FAIL: Reorder display order was not persisted: expected %, got %', ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1, v_ctx.m_p1_3, v_ctx.m_p1_unready], v_order_persisted;
  END IF;

  -- Test-local assertion control demonstrating that wrong/truncated/null galleries are rejected:
  IF (ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1]::uuid[] IS DISTINCT FROM ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1, v_ctx.m_p1_3, v_ctx.m_p1_unready]) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST4_CONTROL_FAIL: Truncated gallery was not detected as distinct';
  END IF;
  IF ((NULL::uuid[]) IS DISTINCT FROM ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1, v_ctx.m_p1_3, v_ctx.m_p1_unready]) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST4_CONTROL_FAIL: NULL gallery was not detected as distinct';
  END IF;

  -- 2. No-op reorder: submit same order
  v_res := public.seller_reorder_listing_media(
    v_ctx.listing_pending_1,
    ARRAY[v_ctx.m_p1_2, v_ctx.m_p1_1, v_ctx.m_p1_3, v_ctx.m_p1_unready]
  );

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF (v_res->>'changed')::boolean IS NOT FALSE OR v_rev_after != 3 THEN
    RAISE EXCEPTION 'TEST4_FAIL: No-op reorder modified revision or returned changed=true: %', v_rev_after;
  END IF;
END;
$test4$;
RESET ROLE;

SELECT is(
  (SELECT revision FROM public.listings WHERE id = (SELECT listing_pending_1 FROM test_ids LIMIT 1)),
  3,
  'Media reorder advances revision on actual order change and is a no-op when unchanged'
);

-- =============================================================================
-- 7. Behavioral Test 5: Cover photo selection change in pending_review
-- Cover change -> revision + 1; Same cover no-op -> changed=false and no revision bump
-- =============================================================================
DO $test5$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_rev_before integer;
  v_res jsonb;
  v_rev_after integer;
  v_cover_persisted uuid;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  SELECT revision INTO STRICT v_rev_before FROM public.listings WHERE id = v_ctx.listing_pending_1;

  -- 1. Effective cover change to media 2
  v_res := public.seller_set_listing_cover_photo(v_ctx.listing_pending_1, v_ctx.m_p1_2);
  SELECT revision, cover_photo_id INTO STRICT v_rev_after, v_cover_persisted FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'changed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST5_FAIL: Cover change call failed: %', v_res;
  END IF;

  IF v_rev_after != v_rev_before + 1 OR v_cover_persisted IS DISTINCT FROM v_ctx.m_p1_2 THEN
    RAISE EXCEPTION 'TEST5_FAIL: Cover change failed: rev % -> %, cover %', v_rev_before, v_rev_after, v_cover_persisted;
  END IF;

  -- Test-local assertion control: verify null observed cover where photo expected is rejected
  IF (NULL::uuid IS DISTINCT FROM v_ctx.m_p1_2) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST5_CONTROL_FAIL: NULL cover was not detected as distinct from expected photo';
  END IF;

  -- 2. No-op cover selection: select media 2 again
  v_res := public.seller_set_listing_cover_photo(v_ctx.listing_pending_1, v_ctx.m_p1_2);
  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF (v_res->>'changed')::boolean IS NOT FALSE OR v_rev_after != 4 THEN
    RAISE EXCEPTION 'TEST5_FAIL: Same cover selection unexpectedly modified revision: %', v_rev_after;
  END IF;
END;
$test5$;
RESET ROLE;

SELECT is(
  (SELECT revision FROM public.listings WHERE id = (SELECT listing_pending_1 FROM test_ids LIMIT 1)),
  4,
  'Cover change advances revision on change and is a no-op on reselection of same cover'
);

-- =============================================================================
-- 8. Behavioral Test 6: Ready cover deletion in pending_review
-- Coordinates fallback cover and increments revision by exactly 1
-- =============================================================================
DO $test6$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_rev_before integer;
  v_res jsonb;
  v_rev_after integer;
  v_new_cover uuid;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  SELECT revision INTO STRICT v_rev_before FROM public.listings WHERE id = v_ctx.listing_pending_1;

  -- Current cover is m_p1_2. Delete m_p1_2.
  v_res := public.seller_delete_listing_media(v_ctx.listing_pending_1, v_ctx.m_p1_2);

  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'deleted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST6_FAIL: Delete call failed: %', v_res;
  END IF;

  SELECT revision, cover_photo_id INTO STRICT v_rev_after, v_new_cover
  FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF v_rev_after != v_rev_before + 1 THEN
    RAISE EXCEPTION 'TEST6_FAIL: Ready cover deletion expected revision % (+1), got %', v_rev_before + 1, v_rev_after;
  END IF;

  -- Require the exact expected canonical fallback cover photo (m_p1_1), not merely non-null
  IF v_new_cover IS DISTINCT FROM v_ctx.m_p1_1 THEN
    RAISE EXCEPTION 'TEST6_FAIL: Fallback cover photo was not properly assigned: expected %, got %', v_ctx.m_p1_1, v_new_cover;
  END IF;

  -- Test-local assertion control: verify null observed cover is rejected
  IF (NULL::uuid IS DISTINCT FROM v_ctx.m_p1_1) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST6_CONTROL_FAIL: NULL cover was not detected as distinct from expected fallback';
  END IF;

  -- 2. Idempotent delete retry: deleting already absent media returns deleted=false and does not bump revision
  v_res := public.seller_delete_listing_media(v_ctx.listing_pending_1, v_ctx.m_p1_2);
  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF (v_res->>'deleted')::boolean IS NOT FALSE OR v_rev_after != 5 THEN
    RAISE EXCEPTION 'TEST6_FAIL: Deletion retry on missing media did not return deleted=false: %', v_res;
  END IF;
END;
$test6$;
RESET ROLE;

SELECT is(
  (SELECT revision FROM public.listings WHERE id = (SELECT listing_pending_1 FROM test_ids LIMIT 1)),
  5,
  'Ready cover deletion coordinates exactly 1 revision increment and handles missing-media retry idempotently'
);

-- =============================================================================
-- 9. Behavioral Test 7: Cleanup of non-ready media does NOT advance revision
-- =============================================================================
DO $test7$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_temp_media uuid := '55555555-0000-4000-8000-000000000099'::uuid;
  v_rev_before integer;
  v_rev_after integer;
  v_res jsonb;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- Insert a failed/uploading temporary media row
  INSERT INTO public.listing_media (
    id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes, processing_status
  ) VALUES (
    v_temp_media, v_ctx.listing_pending_1, v_ctx.seller_id, 9, 'temp.jpg', 'image/jpeg', 1024, 'uploading'
  );

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  SELECT revision INTO STRICT v_rev_before FROM public.listings WHERE id = v_ctx.listing_pending_1;

  -- Delete non-ready media
  v_res := public.seller_delete_listing_media(v_ctx.listing_pending_1, v_temp_media);

  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'deleted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST7_FAIL: Delete non-ready failed: %', v_res;
  END IF;

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF v_rev_after != v_rev_before THEN
    RAISE EXCEPTION 'TEST7_FAIL: Cleanup of non-ready media unexpectedly incremented revision: % -> %', v_rev_before, v_rev_after;
  END IF;
END;
$test7$;
RESET ROLE;

SELECT is(
  (SELECT revision FROM public.listings WHERE id = (SELECT listing_pending_1 FROM test_ids LIMIT 1)),
  5,
  'Cleanup of non-ready media does not advance revision'
);

-- =============================================================================
-- 10. Behavioral Test 8: Active listing cover deletion with remaining media
-- Transitions to pending_review, increments revision by exactly 1, assigns fallback
-- =============================================================================
DO $test8$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_status_after public.listing_status_enum;
  v_rev_after integer;
  v_cover_after uuid;
  v_res jsonb;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  -- Delete active cover photo (m_active_cover). m_active_other remains.
  v_res := public.seller_delete_listing_media(v_ctx.listing_active, v_ctx.m_active_cover);

  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'deleted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST8_FAIL: Active cover delete failed: %', v_res;
  END IF;

  SELECT status, revision, cover_photo_id INTO STRICT v_status_after, v_rev_after, v_cover_after
  FROM public.listings WHERE id = v_ctx.listing_active;

  IF v_status_after != 'pending_review' OR v_rev_after != 2 THEN
    RAISE EXCEPTION 'TEST8_FAIL: Active cover deletion expected pending_review and rev=2, got status=%, rev=%', v_status_after, v_rev_after;
  END IF;

  IF v_cover_after IS DISTINCT FROM v_ctx.m_active_other THEN
    RAISE EXCEPTION 'TEST8_FAIL: Fallback cover was not assigned to remaining photo: expected %, got %', v_ctx.m_active_other, v_cover_after;
  END IF;

  -- Test-local assertion control: verify null observed cover is rejected
  IF (NULL::uuid IS DISTINCT FROM v_ctx.m_active_other) IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST8_CONTROL_FAIL: NULL cover was not detected as distinct from remaining photo';
  END IF;
END;
$test8$;
RESET ROLE;

SELECT pass('Active listing cover deletion transitions to pending_review with exactly 1 increment and fallback cover');

-- =============================================================================
-- 11. Behavioral Test 9: Reserved & Paused listing cover deletion
-- =============================================================================
DO $test9$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_status_res public.listing_status_enum;
  v_rev_res integer;
  v_res_cover uuid;
  v_status_pau public.listing_status_enum;
  v_rev_pau integer;
  v_pau_cover uuid;
  v_res jsonb;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  -- Reserved listing
  v_res := public.seller_delete_listing_media(v_ctx.listing_reserved, v_ctx.m_reserved_cover);
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'deleted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST9_FAIL: Reserved delete failed: %', v_res;
  END IF;

  -- Require NULL cover, absent media, expected pending_review status and incremented revision
  SELECT status, revision, cover_photo_id INTO STRICT v_status_res, v_rev_res, v_res_cover
  FROM public.listings WHERE id = v_ctx.listing_reserved;

  IF v_status_res != 'pending_review' OR v_rev_res != 2 OR v_res_cover IS NOT NULL THEN
    RAISE EXCEPTION 'TEST9_FAIL: Reserved listing deletion expected pending_review, rev=2, and NULL cover, got status=%, rev=%, cover=%', v_status_res, v_rev_res, v_res_cover;
  END IF;

  IF EXISTS (SELECT 1 FROM public.listing_media WHERE id = v_ctx.m_reserved_cover) THEN
    RAISE EXCEPTION 'TEST9_FAIL: Reserved deleted cover media row still exists';
  END IF;

  -- Paused listing
  v_res := public.seller_delete_listing_media(v_ctx.listing_paused, v_ctx.m_paused_cover);
  IF (v_res->>'success')::boolean IS NOT TRUE OR (v_res->>'deleted')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST9_FAIL: Paused delete failed: %', v_res;
  END IF;

  -- Require NULL cover, absent media, expected pending_review status and incremented revision
  SELECT status, revision, cover_photo_id INTO STRICT v_status_pau, v_rev_pau, v_pau_cover
  FROM public.listings WHERE id = v_ctx.listing_paused;

  IF v_status_pau != 'pending_review' OR v_rev_pau != 2 OR v_pau_cover IS NOT NULL THEN
    RAISE EXCEPTION 'TEST9_FAIL: Paused listing deletion expected pending_review, rev=2, and NULL cover, got status=%, rev=%, cover=%', v_status_pau, v_rev_pau, v_pau_cover;
  END IF;

  IF EXISTS (SELECT 1 FROM public.listing_media WHERE id = v_ctx.m_paused_cover) THEN
    RAISE EXCEPTION 'TEST9_FAIL: Paused deleted cover media row still exists';
  END IF;
END;
$test9$;
RESET ROLE;

SELECT pass('Reserved and paused listings transition to pending_review with exactly 1 increment on cover deletion');

-- =============================================================================
-- 12. Behavioral Test 10: Unauthorized caller cannot mutate media
-- Observes resulting state under authorized seller role with SELECT INTO STRICT
-- =============================================================================
DO $test10$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_err_sqlstate text;
  v_err_msg text;
  v_rev_before integer;
  v_status_before public.listing_status_enum;
  v_cover_before uuid;
  v_rev_after integer;
  v_status_after public.listing_status_enum;
  v_cover_after uuid;
  v_media_before uuid[];
  v_media_after uuid[];
  v_control_res jsonb;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- 1. Read initial state as authorized seller
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  SELECT revision, status, cover_photo_id INTO STRICT v_rev_before, v_status_before, v_cover_before
  FROM public.listings WHERE id = v_ctx.listing_pending_1;
  SELECT array_agg(id ORDER BY display_order ASC) INTO STRICT v_media_before
  FROM public.listing_media WHERE listing_id = v_ctx.listing_pending_1;

  -- 2. Switch to unrelated other user and attempt cover change to a DIFFERENT ready photo (m_p1_3)
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.other_user_id,
    'role', 'authenticated'
  )::text, true);

  BEGIN
    PERFORM public.seller_set_listing_cover_photo(v_ctx.listing_pending_1, v_ctx.m_p1_3);
    RAISE EXCEPTION 'CONTROL_FAIL: Unrelated user was able to modify listing cover photo';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err_sqlstate = RETURNED_SQLSTATE, v_err_msg = MESSAGE_TEXT;
    -- Production ownership branch raises bare RAISE EXCEPTION 'LISTING_NOT_FOUND: Listing not found' (SQLSTATE P0001)
    IF v_err_sqlstate != 'P0001' OR v_err_msg != 'LISTING_NOT_FOUND: Listing not found' THEN
      RAISE EXCEPTION 'TEST10_FAIL: Expected P0001 and "LISTING_NOT_FOUND: Listing not found", got %: %', v_err_sqlstate, v_err_msg;
    END IF;
  END;

  -- 3. Restore authorized observer (seller) to inspect post-attempt state
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.seller_id,
    'role', 'authenticated'
  )::text, true);

  SELECT revision, status, cover_photo_id INTO STRICT v_rev_after, v_status_after, v_cover_after
  FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF v_rev_after != v_rev_before OR v_status_after != v_status_before OR v_cover_after IS DISTINCT FROM v_cover_before THEN
    RAISE EXCEPTION 'TEST10_FAIL: Unauthorized call mutated data: rev %->%, status %->%, cover %->%', v_rev_before, v_rev_after, v_status_before, v_status_after, v_cover_before, v_cover_after;
  END IF;

  -- Verify media set membership and order remain intact under authorized observer
  SELECT array_agg(id ORDER BY display_order ASC) INTO STRICT v_media_after
  FROM public.listing_media WHERE listing_id = v_ctx.listing_pending_1;

  IF v_media_after IS DISTINCT FROM v_media_before THEN
    RAISE EXCEPTION 'TEST10_FAIL: Unauthorized call mutated media set: % -> %', v_media_before, v_media_after;
  END IF;

  -- 4. Authorized positive control: seller modifying cover photo succeeds
  v_control_res := public.seller_set_listing_cover_photo(v_ctx.listing_pending_1, v_ctx.m_p1_3);

  IF (v_control_res->>'success')::boolean IS NOT TRUE OR (v_control_res->>'changed')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'TEST10_FAIL: Authorized seller cover change control returned failure: %', v_control_res;
  END IF;

  SELECT revision, cover_photo_id INTO STRICT v_rev_after, v_cover_after
  FROM public.listings WHERE id = v_ctx.listing_pending_1;

  IF v_rev_after != v_rev_before + 1 OR v_cover_after IS DISTINCT FROM v_ctx.m_p1_3 THEN
    RAISE EXCEPTION 'TEST10_FAIL: Authorized seller cover change control failed: rev %, cover %', v_rev_after, v_cover_after;
  END IF;
END;
$test10$;
RESET ROLE;

SELECT pass('Unauthorized user mutations fail with specific LISTING_NOT_FOUND and leave data unchanged');

-- =============================================================================
-- 13. Behavioral Test 11 (Path C): Direct privileged multi-row reorder
-- Asserts complete persisted order, status, and revision
-- =============================================================================
DO $test11$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_owner uuid;
  v_rev_before integer;
  v_status_before public.listing_status_enum;
  v_cover_before uuid;
  v_order_before uuid[];
  v_rev_after integer;
  v_status_after public.listing_status_enum;
  v_cover_after uuid;
  v_order_after uuid[];
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- Assert fixture owner, status, revision, readiness, and cover/order before scenario
  SELECT seller_id, status, revision, cover_photo_id
  INTO STRICT v_owner, v_status_before, v_rev_before, v_cover_before
  FROM public.listings WHERE id = v_ctx.listing_direct;

  SELECT array_agg(id ORDER BY display_order ASC) INTO STRICT v_order_before
  FROM public.listing_media WHERE listing_id = v_ctx.listing_direct;

  IF v_owner != v_ctx.seller_id OR v_status_before != 'pending_review' OR v_rev_before != 1
     OR v_cover_before IS DISTINCT FROM v_ctx.m_direct_1
     OR v_order_before IS DISTINCT FROM ARRAY[v_ctx.m_direct_1, v_ctx.m_direct_2] THEN
    RAISE EXCEPTION 'TEST11_FIXTURE_FAIL: Unexpected initial state for listing_direct';
  END IF;

  -- Verify media readiness
  IF (SELECT count(*) FROM public.listing_media WHERE listing_id = v_ctx.listing_direct AND processing_status = 'ready') != 2 THEN
    RAISE EXCEPTION 'TEST11_FIXTURE_FAIL: Expected 2 ready media rows on listing_direct';
  END IF;

  -- Direct table update as service_role with clean context
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '', true);

  UPDATE public.listing_media
  SET display_order = CASE WHEN id = v_ctx.m_direct_1 THEN 1 ELSE 0 END
  WHERE id IN (v_ctx.m_direct_1, v_ctx.m_direct_2);
  RESET ROLE;

  SELECT revision, status, cover_photo_id INTO STRICT v_rev_after, v_status_after, v_cover_after
  FROM public.listings WHERE id = v_ctx.listing_direct;

  SELECT array_agg(id ORDER BY display_order ASC) INTO STRICT v_order_after
  FROM public.listing_media WHERE listing_id = v_ctx.listing_direct;

  IF v_rev_after != v_rev_before + 1 THEN
    RAISE EXCEPTION 'TEST11_FAIL: Direct privileged reorder failed to advance revision: % -> %', v_rev_before, v_rev_after;
  END IF;

  IF v_status_after != 'pending_review' THEN
    RAISE EXCEPTION 'TEST11_FAIL: Status unexpectedly changed: %', v_status_after;
  END IF;

  IF v_order_after IS DISTINCT FROM ARRAY[v_ctx.m_direct_2, v_ctx.m_direct_1] THEN
    RAISE EXCEPTION 'TEST11_FAIL: Persisted complete order unexpected: %', v_order_after;
  END IF;

  IF v_cover_after IS DISTINCT FROM v_ctx.m_direct_1 THEN
    RAISE EXCEPTION 'TEST11_FAIL: Cover photo unexpectedly modified: %', v_cover_after;
  END IF;
END;
$test11$;

SELECT is(
  (SELECT revision FROM public.listings WHERE id = (SELECT listing_direct FROM test_ids LIMIT 1)),
  2,
  'Direct privileged display_order update triggers statement-level re-review, advances revision, and persists complete order'
);

-- =============================================================================
-- 14. Behavioral Test 12 (Path A): Direct service-role DELETE of ready cover and non-cover
-- Covers pending_review and reviewable/published (active) starting states.
-- Direct SQL deletion does not invoke seller-RPC fallback: expects NULL cover when cover is deleted.
-- =============================================================================
DO $test12$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_lid_pend uuid := '44444444-0000-4000-8000-000000000021'::uuid;
  v_m_pend_cov uuid := '55555555-0000-4000-8000-000000000021'::uuid;
  v_m_pend_nc  uuid := '55555555-0000-4000-8000-000000000022'::uuid;
  v_lid_act  uuid := '44444444-0000-4000-8000-000000000022'::uuid;
  v_m_act_cov  uuid := '55555555-0000-4000-8000-000000000023'::uuid;
  v_m_act_nc   uuid := '55555555-0000-4000-8000-000000000024'::uuid;
  v_rev integer;
  v_status public.listing_status_enum;
  v_cover uuid;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- Setup isolated listings and media for Test 12
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, condition, price_type, price_paise)
  VALUES
    (v_lid_pend, v_ctx.seller_id, 'Direct Del Pend', 'Desc', v_ctx.cat_id, v_ctx.city_id, 'good', 'fixed', 10000),
    (v_lid_act,  v_ctx.seller_id, 'Direct Del Act',  'Desc', v_ctx.cat_id, v_ctx.city_id, 'good', 'fixed', 10000);

  INSERT INTO public.listing_media (id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes)
  VALUES
    (v_m_pend_cov, v_lid_pend, v_ctx.seller_id, 0, 'dcov.jpg', 'image/jpeg', 1024),
    (v_m_pend_nc,  v_lid_pend, v_ctx.seller_id, 1, 'dnc.jpg',  'image/jpeg', 1024),
    (v_m_act_cov,  v_lid_act,  v_ctx.seller_id, 0, 'acov.jpg', 'image/jpeg', 1024),
    (v_m_act_nc,   v_lid_act,  v_ctx.seller_id, 1, 'anc.jpg',  'image/jpeg', 1024);

  UPDATE public.listing_media SET processing_status = 'ready', original_storage_path = 'path/' || id || '.jpg'
  WHERE id IN (v_m_pend_cov, v_m_pend_nc, v_m_act_cov, v_m_act_nc);

  UPDATE public.listings SET cover_photo_id = v_m_pend_cov, status = 'pending_review', revision = 1 WHERE id = v_lid_pend;
  UPDATE public.listings SET cover_photo_id = v_m_act_cov,  status = 'active',         revision = 1 WHERE id = v_lid_act;

  -- 1. Direct DELETE of non-cover ready media on pending_review listing
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM public.listing_media WHERE id = v_m_pend_nc;
  RESET ROLE;

  SELECT revision, status, cover_photo_id INTO STRICT v_rev, v_status, v_cover
  FROM public.listings WHERE id = v_lid_pend;

  IF v_rev != 2 OR v_status != 'pending_review' OR v_cover IS DISTINCT FROM v_m_pend_cov THEN
    RAISE EXCEPTION 'TEST12_FAIL: Pending non-cover delete failed: rev=%, status=%, cover=%', v_rev, v_status, v_cover;
  END IF;
  IF EXISTS (SELECT 1 FROM public.listing_media WHERE id = v_m_pend_nc) THEN
    RAISE EXCEPTION 'TEST12_FAIL: Deleted non-cover media row still exists';
  END IF;

  -- 2. Direct DELETE of cover ready media on pending_review listing
  -- Direct DELETE does not run seller RPC fallback, so FK ON DELETE SET NULL clears cover_photo_id to NULL
  SET LOCAL ROLE service_role;
  DELETE FROM public.listing_media WHERE id = v_m_pend_cov;
  RESET ROLE;

  SELECT revision, status, cover_photo_id INTO STRICT v_rev, v_status, v_cover
  FROM public.listings WHERE id = v_lid_pend;

  IF v_rev != 3 OR v_status != 'pending_review' OR v_cover IS NOT NULL THEN
    RAISE EXCEPTION 'TEST12_FAIL: Pending cover delete failed: rev=%, status=%, cover=% (expected NULL)', v_rev, v_status, v_cover;
  END IF;
  IF EXISTS (SELECT 1 FROM public.listing_media WHERE id = v_m_pend_cov) THEN
    RAISE EXCEPTION 'TEST12_FAIL: Deleted cover media row still exists';
  END IF;

  -- 3. Direct DELETE of cover ready media on active listing
  -- BEFORE DELETE trigger transitions active listing to pending_review and increments revision to 2.
  -- FK ON DELETE SET NULL clears cover_photo_id to NULL.
  SET LOCAL ROLE service_role;
  DELETE FROM public.listing_media WHERE id = v_m_act_cov;
  RESET ROLE;

  SELECT revision, status, cover_photo_id INTO STRICT v_rev, v_status, v_cover
  FROM public.listings WHERE id = v_lid_act;

  IF v_rev != 2 OR v_status != 'pending_review' OR v_cover IS NOT NULL THEN
    RAISE EXCEPTION 'TEST12_FAIL: Active cover delete failed: rev=%, status=%, cover=% (expected pending_review, rev 2, NULL cover)', v_rev, v_status, v_cover;
  END IF;
END;
$test12$;

SELECT pass('Direct service-role DELETE of ready cover and non-cover enforces revision increment, status transition, and FK cover nulling');

-- =============================================================================
-- 15. Behavioral Test 13 (Path B): Non-mutating and zero-row AFTER UPDATE triggers
-- Verifies: zero affected rows, unrelated-column update on ready media, and true no-change display_order update
-- none of which trigger invalidation.
-- =============================================================================
DO $test13$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_rev_before integer;
  v_rev_after integer;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;
  SELECT revision INTO STRICT v_rev_before FROM public.listings WHERE id = v_ctx.listing_direct;

  -- 1. Zero rows affected UPDATE statement
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE public.listing_media
  SET display_order = 99
  WHERE id = 'ffffffff-ffff-4fff-bfff-ffffffffffff'::uuid;
  RESET ROLE;

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_direct;
  IF v_rev_after != v_rev_before THEN
    RAISE EXCEPTION 'TEST13_FAIL: Zero-row UPDATE mutated revision: % -> %', v_rev_before, v_rev_after;
  END IF;

  -- 2. Unrelated column update on ready media (original_filename / thumbnail_storage_path)
  SET LOCAL ROLE service_role;
  UPDATE public.listing_media
  SET original_filename = 'renamed.jpg'
  WHERE listing_id = v_ctx.listing_direct;
  RESET ROLE;

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_direct;
  IF v_rev_after != v_rev_before THEN
    RAISE EXCEPTION 'TEST13_FAIL: Unrelated-column UPDATE mutated revision: % -> %', v_rev_before, v_rev_after;
  END IF;

  -- 3. True no-change display_order update: assign same display_order value
  SET LOCAL ROLE service_role;
  UPDATE public.listing_media
  SET display_order = display_order
  WHERE listing_id = v_ctx.listing_direct;
  RESET ROLE;

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_ctx.listing_direct;
  IF v_rev_after != v_rev_before THEN
    RAISE EXCEPTION 'TEST13_FAIL: Identical display_order UPDATE mutated revision: % -> %', v_rev_before, v_rev_after;
  END IF;
END;
$test13$;

SELECT pass('Zero-row, unrelated-column, and identical display_order UPDATE statements do not trigger review invalidation');

-- =============================================================================
-- 16. Behavioral Test 14 (Path D): Transaction rollback on failed delete and parent deletion cascade
-- Verifies all-or-nothing rollback semantics and clean parent deletion cascade without orphaned triggers
-- =============================================================================
DO $test14$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_lid_rb uuid := '44444444-0000-4000-8000-000000000031'::uuid;
  v_mid_rb uuid := '55555555-0000-4000-8000-000000000031'::uuid;
  v_lid_casc uuid := '44444444-0000-4000-8000-000000000032'::uuid;
  v_mid_casc uuid := '55555555-0000-4000-8000-000000000032'::uuid;
  v_rev integer;
  v_status public.listing_status_enum;
  v_cover uuid;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- Setup rollback test fixture
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, condition, price_type, price_paise)
  VALUES (v_lid_rb, v_ctx.seller_id, 'Rollback Test', 'Desc', v_ctx.cat_id, v_ctx.city_id, 'good', 'fixed', 10000);

  INSERT INTO public.listing_media (id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes)
  VALUES (v_mid_rb, v_lid_rb, v_ctx.seller_id, 0, 'rb.jpg', 'image/jpeg', 1024);

  UPDATE public.listing_media SET processing_status = 'ready', original_storage_path = 'path/' || id || '.jpg' WHERE id = v_mid_rb;
  UPDATE public.listings SET cover_photo_id = v_mid_rb, status = 'pending_review', revision = 1 WHERE id = v_lid_rb;

  -- 1. Failed transaction block: delete ready media then raise exception -> MUST roll back completely
  BEGIN
    SET LOCAL ROLE service_role;
    DELETE FROM public.listing_media WHERE id = v_mid_rb;
    RAISE EXCEPTION 'SIMULATED_FAILURE_AFTER_DELETE';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM != 'SIMULATED_FAILURE_AFTER_DELETE' THEN
      RAISE EXCEPTION 'TEST14_FAIL: Unexpected error during rollback test: %', SQLERRM;
    END IF;
  END;

  RESET ROLE;
  SELECT revision, status, cover_photo_id INTO STRICT v_rev, v_status, v_cover
  FROM public.listings WHERE id = v_lid_rb;

  IF v_rev != 1 OR v_status != 'pending_review' OR v_cover IS DISTINCT FROM v_mid_rb THEN
    RAISE EXCEPTION 'TEST14_FAIL: Rollback failed to restore listing state: rev=%, status=%, cover=%', v_rev, v_status, v_cover;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.listing_media WHERE id = v_mid_rb) THEN
    RAISE EXCEPTION 'TEST14_FAIL: Rollback failed to restore deleted media row';
  END IF;

  -- 2. Parent-listing deletion cascade
  -- When a listing is deleted, ON DELETE CASCADE deletes all associated listing_media rows.
  -- In handle_listing_media_before_delete(), trigger_listing_media_rereview(OLD.listing_id)
  -- performs a SELECT ... FOR UPDATE on public.listings. If the listing is already absent/deleting,
  -- it returns cleanly without failing or causing deadlocks.
  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, condition, price_type, price_paise)
  VALUES (v_lid_casc, v_ctx.seller_id, 'Cascade Test', 'Desc', v_ctx.cat_id, v_ctx.city_id, 'good', 'fixed', 10000);

  INSERT INTO public.listing_media (id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes)
  VALUES (v_mid_casc, v_lid_casc, v_ctx.seller_id, 0, 'casc.jpg', 'image/jpeg', 1024);

  UPDATE public.listing_media SET processing_status = 'ready', original_storage_path = 'path/' || id || '.jpg' WHERE id = v_mid_casc;
  UPDATE public.listings SET cover_photo_id = v_mid_casc, status = 'pending_review', revision = 1 WHERE id = v_lid_casc;

  SET LOCAL ROLE service_role;
  DELETE FROM public.listings WHERE id = v_lid_casc;
  RESET ROLE;

  IF EXISTS (SELECT 1 FROM public.listings WHERE id = v_lid_casc) THEN
    RAISE EXCEPTION 'TEST14_FAIL: Listing was not deleted';
  END IF;

  IF EXISTS (SELECT 1 FROM public.listing_media WHERE id = v_mid_casc) THEN
    RAISE EXCEPTION 'TEST14_FAIL: Media row was not cascaded on listing delete';
  END IF;
END;
$test14$;

SELECT pass('Failed deletion transaction rolls back all-or-nothing and parent listing cascade cleanly removes children');

-- =============================================================================
-- 17. Behavioral Test 15 (Path E): Multi-row DELETE semantics
-- Row-level trigger handle_listing_media_before_delete executes one invalidation per deleted ready row.
-- Direct privileged deletion of 2 ready photos increments revision by 2.
-- =============================================================================
DO $test15$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_lid_multi uuid := '44444444-0000-4000-8000-000000000041'::uuid;
  v_mid_1 uuid := '55555555-0000-4000-8000-000000000041'::uuid;
  v_mid_2 uuid := '55555555-0000-4000-8000-000000000042'::uuid;
  v_rev_after integer;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  INSERT INTO public.listings (id, seller_id, title, description, category_id, city_id, condition, price_type, price_paise)
  VALUES (v_lid_multi, v_ctx.seller_id, 'Multi Delete Test', 'Desc', v_ctx.cat_id, v_ctx.city_id, 'good', 'fixed', 10000);

  INSERT INTO public.listing_media (id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes)
  VALUES
    (v_mid_1, v_lid_multi, v_ctx.seller_id, 0, 'm1.jpg', 'image/jpeg', 1024),
    (v_mid_2, v_lid_multi, v_ctx.seller_id, 1, 'm2.jpg', 'image/jpeg', 1024);

  UPDATE public.listing_media SET processing_status = 'ready', original_storage_path = 'path/' || id || '.jpg'
  WHERE id IN (v_mid_1, v_mid_2);

  UPDATE public.listings SET cover_photo_id = v_mid_1, status = 'pending_review', revision = 1 WHERE id = v_lid_multi;

  -- Delete both ready photos in a single SQL DELETE statement as service_role
  SET LOCAL ROLE service_role;
  PERFORM set_config('request.jwt.claims', '', true);
  DELETE FROM public.listing_media WHERE listing_id = v_lid_multi;
  RESET ROLE;

  SELECT revision INTO STRICT v_rev_after FROM public.listings WHERE id = v_lid_multi;

  -- Per row-level BEFORE DELETE trigger design: 2 ready rows deleted -> 2 invalidation calls -> revision 1 + 2 = 3
  IF v_rev_after != 3 THEN
    RAISE EXCEPTION 'TEST15_FAIL: Multi-row DELETE expected revision 3, got %', v_rev_after;
  END IF;
END;
$test15$;

SELECT pass('Multi-row direct DELETE executes one invalidation per deleted ready row in accordance with row-trigger semantics');

-- =============================================================================
-- 18. Behavioral Test 16: Review-Generation Invalidation on Seller Resubmission
-- Verifies that when a rejected listing is resubmitted without edits, revision
-- increments (1 -> 2), rejecting prior review tokens with PT409 while accepting
-- current review tokens.
-- =============================================================================
DO $test16$
DECLARE
  v_ctx test_ids%ROWTYPE;
  v_lid_resub uuid := '44444444-0000-4000-8000-000000000051'::uuid;
  v_mid_resub uuid := '55555555-0000-4000-8000-000000000051'::uuid;
  v_rec record;
  v_res jsonb;
  v_first_rev integer;
  v_first_status public.listing_status_enum;
BEGIN
  SELECT * INTO STRICT v_ctx FROM test_ids LIMIT 1;

  -- 1. Create draft listing with required fields
  INSERT INTO public.listings (
    id, seller_id, title, description, category_id, city_id, condition, price_type, price_paise,
    pin_code, category_attributes
  ) VALUES (
    v_lid_resub, v_ctx.seller_id, 'Resubmit Regression Test', 'Valid detailed description meeting minimum length requirements.',
    v_ctx.cat_id, v_ctx.city_id, 'good', 'fixed', 10000,
    '302017', jsonb_build_object('brand', 'Generic')
  );

  INSERT INTO public.listing_media (id, listing_id, uploader_id, display_order, original_filename, content_type, file_size_bytes)
  VALUES (v_mid_resub, v_lid_resub, v_ctx.seller_id, 0, 'resub.jpg', 'image/jpeg', 1024);

  UPDATE public.listing_media SET processing_status = 'ready', original_storage_path = 'path/' || id || '.jpg'
  WHERE id = v_mid_resub;

  -- 2. First submission as seller -> pending_review, rev 1
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_ctx.seller_id::text, 'role', 'authenticated')::text, true);
  v_res := app_security.impl_seller_submit_listing(v_lid_resub);

  SELECT status, revision INTO STRICT v_rec FROM public.listings WHERE id = v_lid_resub;
  v_first_rev := v_rec.revision;
  v_first_status := v_rec.status;

  IF v_first_rev != 1 OR v_first_status != 'pending_review' THEN
    RAISE EXCEPTION 'TEST16_FAIL: Initial submission expected rev 1 pending_review, got rev % %', v_first_rev, v_first_status;
  END IF;

  -- 3. Moderator rejects listing
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.mod_id::text, 'role', 'authenticated', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from clock_timestamp())::bigint))
  )::text, true);

  v_res := app_security.impl_moderate_listing_reviewed(
    p_listing_id => v_lid_resub,
    p_action => 'reject',
    p_reason => 'Initial rejection note',
    p_expected_revision => v_first_rev,
    p_expected_status => v_first_status
  );

  -- 4. Seller resubmits UNCHANGED listing -> revision must advance to 2
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_ctx.seller_id::text, 'role', 'authenticated')::text, true);
  v_res := app_security.impl_seller_submit_listing(v_lid_resub);

  SELECT status, revision, rejection_reason INTO STRICT v_rec FROM public.listings WHERE id = v_lid_resub;
  IF v_rec.status != 'pending_review' OR v_rec.revision != 2 OR v_rec.rejection_reason IS NOT NULL THEN
    RAISE EXCEPTION 'TEST16_FAIL: Resubmission expected rev 2 pending_review with null rejection_reason, got rev % % reason=%',
      v_rec.revision, v_rec.status, v_rec.rejection_reason;
  END IF;

  -- 5. Old token (rev 1) MUST fail with PT409
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
    'sub', v_ctx.mod_id::text, 'role', 'authenticated', 'aal', 'aal2',
    'amr', jsonb_build_array(jsonb_build_object('method', 'totp', 'timestamp', extract(epoch from clock_timestamp())::bigint))
  )::text, true);

  BEGIN
    v_res := app_security.impl_moderate_listing_reviewed(
      p_listing_id => v_lid_resub,
      p_action => 'approve',
      p_reason => NULL,
      p_expected_revision => v_first_rev,
      p_expected_status => 'pending_review'::public.listing_status_enum
    );
    RAISE EXCEPTION 'TEST16_FAIL: Stale review token unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE != 'PT409' THEN
      RAISE EXCEPTION 'TEST16_FAIL: Expected PT409 on stale token, got %: %', SQLSTATE, SQLERRM;
    END IF;
  END;

  -- 6. Current token (rev 2) MUST succeed
  v_res := app_security.impl_moderate_listing_reviewed(
    p_listing_id => v_lid_resub,
    p_action => 'approve',
    p_reason => NULL,
    p_expected_revision => 2,
    p_expected_status => 'pending_review'::public.listing_status_enum
  );

  SELECT status, revision INTO STRICT v_rec FROM public.listings WHERE id = v_lid_resub;
  IF v_rec.status != 'active' OR v_rec.revision != 2 THEN
    RAISE EXCEPTION 'TEST16_FAIL: Valid review token failed to approve listing cleanly: status=% rev=%', v_rec.status, v_rec.revision;
  END IF;
END;
$test16$;

SELECT pass('Resubmission of rejected listing increments revision, rejecting stale review tokens with PT409 and accepting current token');


-- Clean up temporary test table
DROP TABLE test_ids;

SELECT * FROM finish();
ROLLBACK;
