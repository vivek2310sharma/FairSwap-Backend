-- Executed against the disposable engine after all Ratings migrations.
do $$ declare t record; f record; n integer; begin
 for t in select c.oid,c.relname,c.relrowsecurity from pg_class c join pg_namespace s on s.oid=c.relnamespace
 where c.relkind='r' and ((s.nspname='public' and c.relname in ('rating_trades','rating_reviews','rating_replies','profile_rating_stats','trade_system_events')) or (s.nspname='app_security' and c.relname like 'rating%')) loop
  if not t.relrowsecurity then raise exception 'Missing RLS: %',t.relname; end if;
  if has_table_privilege('authenticated',t.oid,'INSERT,UPDATE,DELETE,SELECT') or has_table_privilege('anon',t.oid,'INSERT,UPDATE,DELETE,SELECT') then raise exception 'Direct table access: %',t.relname; end if;
 end loop;
 for f in select p.oid,p.proname,p.proconfig,p.prosecdef,s.nspname from pg_proc p join pg_namespace s on s.oid=p.pronamespace
 where (s.nspname='app_security' and (p.proname like 'rating%' or p.proname like 'impl_ratings%' or p.proname like 'impl_admin_ratings_%' or p.proname='publish_due_reviews')) or (s.nspname='public' and (p.proname like 'ratings_%' or p.proname like 'admin_ratings_%')) loop
  if not ('search_path=""'=any(f.proconfig)) then raise exception 'Unsafe search_path: %',f.proname; end if;
  if f.nspname='public' and f.prosecdef then raise exception 'Public definer: %',f.proname; end if;
  if exists(select 1 from aclexplode(coalesce((select proacl from pg_proc where oid=f.oid),acldefault('f',(select proowner from pg_proc where oid=f.oid)))) a where a.grantee=0 and privilege_type='EXECUTE') then raise exception 'PUBLIC execute: %',f.proname; end if;
 end loop;
 if has_function_privilege('authenticated','app_security.publish_due_reviews()','EXECUTE') or has_function_privilege('service_role','app_security.publish_due_reviews()','EXECUTE') then raise exception 'Scheduler exposed'; end if;
 select count(*) into n from public.rating_reviews where score<0 or score>10;
 if n<>0 then raise exception 'Invalid score'; end if;
end $$;
