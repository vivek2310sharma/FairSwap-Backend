-- Operation-helper regression only; not positive staff RLS or image rendering.
-- Requires the existing approved pgTAP test database; NOT RUN on live Test.
BEGIN;
SELECT plan(6);
SELECT ok(EXISTS (
  SELECT 1 FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND policyname='admin_pending_medium_download'
    AND cmd='SELECT' AND roles=ARRAY['authenticated']::name[]
    AND qual LIKE '%allow_any_operation%'
    AND qual LIKE '%object.get_authenticated_info%'
    AND qual LIKE '%object.get_authenticated%'
), 'medium policy preserves authenticated SELECT and explicit operation allowlist');
SELECT is((SELECT bool_or(public) FROM storage.buckets WHERE id IN ('listing-originals','listing-derivatives')),false,'listing buckets remain private');
SELECT set_config('storage.operation','storage.object.get_authenticated_info',true);
SELECT is(storage.allow_any_operation(ARRAY['object.get_authenticated_info','object.get_authenticated']),true,'metadata prerequisite operation permitted');
SELECT set_config('storage.operation','storage.object.get_authenticated',true);
SELECT is(storage.allow_any_operation(ARRAY['object.get_authenticated_info','object.get_authenticated']),true,'download operation permitted');
SELECT set_config('storage.operation','storage.object.list',true);
SELECT is(storage.allow_any_operation(ARRAY['object.get_authenticated_info','object.get_authenticated']),false,'listing operation excluded');
SELECT set_config('storage.operation','storage.object.sign',true);
SELECT is(storage.allow_any_operation(ARRAY['object.get_authenticated_info','object.get_authenticated']),false,'signing operation excluded');
SELECT * FROM finish();
ROLLBACK;