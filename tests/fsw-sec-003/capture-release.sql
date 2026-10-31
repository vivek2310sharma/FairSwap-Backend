-- Metadata only. Use psql -XqAt -v ON_ERROR_STOP=1; never returns table/user rows.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT jsonb_build_object(
 'capturedAt', clock_timestamp(),
 'connection', jsonb_build_object('host', :'HOST', 'port', :'PORT', 'user', :'USER'),
 'tls', (SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),
 'serverVersion', current_setting('server_version_num'),
 'exposedSchemas', current_setting('pgrst.db_schemas',true),
 'ledger', (SELECT coalesce(jsonb_agg(jsonb_build_object(
   'version',version,'name',name,
   'statementsSha256',encode(sha256(convert_to(btrim(array_to_string(statements,E';\n'), E' \t\r\n;'),'UTF8')),'hex')
 ) ORDER BY version),'[]') FROM supabase_migrations.schema_migrations),
 'functions', (SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'name',p.proname,'owner',pg_get_userbyid(p.proowner),
   'acl',p.proacl::text,'argNames',p.proargnames,'args',pg_get_function_arguments(p.oid),
   'identityArgs',pg_get_function_identity_arguments(p.oid),'returnType',pg_get_function_result(p.oid),
   'definer',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig,
   'bodyMd5',md5(p.prosrc),'bodySha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')
 ) ORDER BY n.nspname,p.proname)
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE p.oid IN (
  'public.search_public_listings(text,uuid,text,uuid,uuid,text,integer,integer,text,integer,integer)'::regprocedure,
  'app_security.impl_search_public_listings(text,uuid,text,uuid,uuid,text,integer,integer,text,integer,integer)'::regprocedure)),
 'security', (SELECT jsonb_agg(jsonb_build_object(
   'schema',n.nspname,'table',c.relname,'owner',pg_get_userbyid(c.relowner),
   'acl',c.relacl::text,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
   'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl::text) ORDER BY a.attnum)
     FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object(
     'name',p.polname,'cmd',p.polcmd,'permissive',p.polpermissive,'roles',p.polroles,
     'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname),'[]')
     FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)
 ) ORDER BY c.relname)
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname IN ('listings','user_accounts','categories','cities','localities','listing_media'))
);
COMMIT;
