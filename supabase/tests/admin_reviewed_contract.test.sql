-- Existing backend pgTAP runner. Requires its normal disposable database setup.
-- Live Test has no pgTAP extension; this file has NOT RUN there.
BEGIN;
SELECT plan(10);
SELECT has_function('public','moderate_listing_reviewed',ARRAY['uuid','text','text','integer','listing_status_enum'],'reviewed public contract exists');
SELECT has_function('app_security','impl_moderate_listing_reviewed',ARRAY['uuid','text','text','integer','listing_status_enum'],'reviewed private contract exists');
SELECT function_privs_are('public','moderate_listing_reviewed',ARRAY['uuid','text','text','integer','listing_status_enum'],'authenticated',ARRAY['EXECUTE'],'authenticated can call reviewed wrapper');
SELECT function_privs_are('public','moderate_listing_reviewed',ARRAY['uuid','text','text','integer','listing_status_enum'],'anon',ARRAY[]::text[],'anon cannot call reviewed wrapper');
SELECT function_privs_are('app_security','impl_moderate_listing_reviewed',ARRAY['uuid','text','text','integer','listing_status_enum'],'anon',ARRAY[]::text[],'anon cannot call private entry');
SELECT is((SELECT bool_or(public) FROM storage.buckets WHERE id IN ('listing-originals','listing-derivatives')),false,'listing buckets stay private');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='storage' AND tablename='objects' AND policyname='admin_pending_medium_download' AND cmd='SELECT' AND roles=ARRAY['authenticated']::name[]),'download policy has only authenticated SELECT scope');
-- Assert under actual database roles, then emit TAP after resetting the role.
-- pgTAP's transaction-local result state belongs to the runner, not these roles.
SET LOCAL ROLE anon;
DO $test$
BEGIN
  BEGIN
    PERFORM public.moderate_listing_reviewed('11111111-1111-4111-8111-111111111111','approve',NULL,1,'pending_review');
    RAISE EXCEPTION 'ANON_RPC_UNEXPECTED_SUCCESS';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;
RESET ROLE;
SELECT pass('anon decision denied with insufficient_privilege');
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  PERFORM set_config('request.jwt.claims','{}',true);
  BEGIN
    PERFORM public.moderate_listing_reviewed('11111111-1111-4111-8111-111111111111','approve',NULL,1,'pending_review');
    RAISE EXCEPTION 'MISSING_IDENTITY_RPC_UNEXPECTED_SUCCESS';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$test$;
RESET ROLE;
SELECT pass('missing-identity decision denied with insufficient_privilege');
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id IN ('listing-originals','listing-derivatives')) THEN
    RAISE EXCEPTION 'MISSING_IDENTITY_STORAGE_UNEXPECTED_ACCESS';
  END IF;
END;
$test$;
RESET ROLE;
SELECT pass('missing identity cannot read listing objects');
SELECT * FROM finish();
ROLLBACK;