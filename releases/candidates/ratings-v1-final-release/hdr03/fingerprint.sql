-- Metadata only; same canonical expression runs on reviewed SQL fixture and hosted DB.
select jsonb_build_object(
 'functions',(select jsonb_agg(jsonb_build_object(
   'signature',p.oid::regprocedure::text,
   'definition',replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),
   'acl',(select jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by a.grantee=0,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
 ) order by p.oid::regprocedure::text) from pg_proc p where p.oid in (
 to_regprocedure('public.get_unread_counts()'),to_regprocedure('app_security.hdr03_signal_message()'),to_regprocedure('app_security.hdr03_signal_read_state()'))),
 'overloads',(select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='get_unread_counts'),
 'table',(select jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'replicaIdentity',c.relreplident,
 'acl',(select jsonb_agg(jsonb_build_array(case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,a.is_grantable) order by a.grantee=0,case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type) from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a)) from pg_class c where c.oid=to_regclass('public.unread_count_signals')),
 'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'acl',a.attacl::text) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=to_regclass('public.unread_count_signals') and a.attnum>0 and not a.attisdropped),
 'constraints',(select jsonb_agg(jsonb_build_object('name',conname,'definition',pg_get_constraintdef(oid,true),'validated',convalidated) order by conname) from pg_constraint where conrelid=to_regclass('public.unread_count_signals')),
 'indexes',(select jsonb_agg(jsonb_build_object('name',indexname,'definition',indexdef) order by indexname) from pg_indexes where schemaname='public' and tablename='unread_count_signals'),
 'policies',(select jsonb_agg(jsonb_build_object('name',policyname,'permissive',permissive,'roles',roles,'cmd',cmd,'qual',qual,'check',with_check) order by policyname) from pg_policies where schemaname='public' and tablename='unread_count_signals'),
 'triggers',(select jsonb_agg(jsonb_build_object('name',t.tgname,'enabled',t.tgenabled,'definition',pg_get_triggerdef(t.oid,true)) order by t.tgname) from pg_trigger t where not t.tgisinternal and (t.tgname like 'hdr03_%' or t.tgfoid in (to_regprocedure('app_security.hdr03_signal_message()'),to_regprocedure('app_security.hdr03_signal_read_state()')))),
 'publication',(select jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename,'columns',case when tablename='unread_count_signals' then attnames else null end,'rowFilter',rowfilter) order by schemaname,tablename) from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename in ('messages','notifications','unread_count_signals')),
 'sourceRls',(select jsonb_agg(jsonb_build_object('name',c.relname,'rls',c.relrowsecurity) order by c.relname) from pg_class c where c.oid in (to_regclass('public.messages'),to_regclass('public.conversations'),to_regclass('public.conversation_read_states'),to_regclass('public.notifications')))
) as contract;
