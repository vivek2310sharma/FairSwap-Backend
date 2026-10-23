-- Metadata only: never call the aggregate as a privileged operator to test users.
begin transaction read only;
do $hdr03_postflight$
begin
  if to_regprocedure('public.get_unread_counts()') is null
    or (select prosecdef from pg_proc where oid='public.get_unread_counts()'::regprocedure)
    or has_function_privilege('anon','public.get_unread_counts()','execute')
    or not has_function_privilege('authenticated','public.get_unread_counts()','execute') then
    raise exception 'HDR03 STOP: aggregate execution boundary';
  end if;
  if (select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='get_unread_counts') <> 1 then
    raise exception 'HDR03 STOP: unexpected aggregate overload';
  end if;
  if not (select relrowsecurity and relforcerowsecurity and relreplident='d'
          from pg_class where oid='public.unread_count_signals'::regclass)
     or has_table_privilege('anon','public.unread_count_signals','select')
     or not has_table_privilege('authenticated','public.unread_count_signals','select')
     or has_table_privilege('authenticated','public.unread_count_signals','insert,update,delete')
     or (select count(*) from information_schema.columns where table_schema='public' and table_name='unread_count_signals') <> 3 then
    raise exception 'HDR03 STOP: signal security or payload drift';
  end if;
  if (select count(*) from pg_trigger where tgname in ('hdr03_message_arrival','hdr03_read_state_insert','hdr03_read_state_update') and not tgisinternal and tgenabled='O') <> 3
     or has_function_privilege('authenticated','app_security.hdr03_signal_message()','execute')
     or has_function_privilege('authenticated','app_security.hdr03_signal_read_state()','execute') then
    raise exception 'HDR03 STOP: trigger boundary';
  end if;
  if not exists(select 1 from pg_policies where schemaname='public' and tablename='unread_count_signals'
       and policyname='unread_count_signals_owner_select' and cmd='SELECT'
       and qual like '%auth.uid()%')
     or (select count(*) from pg_policies where schemaname='public' and tablename='unread_count_signals') <> 1 then
    raise exception 'HDR03 STOP: owner policy drift';
  end if;
  if (select array_agg(tablename::text order by tablename) from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public')
       is distinct from array['messages','notifications','unread_count_signals']::text[] then
    raise exception 'HDR03 STOP: publication drift';
  end if;
end;
$hdr03_postflight$;
commit;
