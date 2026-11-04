-- Read-only release-owner receipt; run only in an authorized target environment.
-- A match is a prerequisite, not hosted acceptance or permission to deploy.
select p.oid::regprocedure::text as signature,pg_catalog.pg_get_userbyid(p.proowner) as owner,p.proacl,p.prosecdef,p.proconfig,md5(p.prosrc) as source_md5,
 pg_catalog.pg_get_functiondef(p.oid) as definition
from pg_catalog.pg_proc p where p.oid in (
 pg_catalog.to_regprocedure('app_security.impl_submit_mobile_v2(jsonb)'),
 pg_catalog.to_regprocedure('public.submit_mobile_v2(jsonb)'));
