-- SAME regression fixture runs under PGlite and native PG15. NO HTTP extension/real credentials.
create temp table privilege_check_count(n integer not null);
insert into privilege_check_count values(0);
create function pg_temp.check_privilege(ok boolean) returns void language plpgsql as $$
begin
 if ok is distinct from true then raise exception 'CHAT_NET_PRIVILEGE_REGRESSION'; end if;
 update privilege_check_count set n=n+1;
end$$;
select pg_temp.check_privilege(not (select rolsuper from pg_roles where rolname='postgres'));
select pg_temp.check_privilege((select pg_get_userbyid(relowner)='supabase_admin' from pg_class where oid='net.http_request_queue'::regclass));
select pg_temp.check_privilege(not (select prosecdef from pg_proc where oid='net.http_post(text,jsonb,jsonb,jsonb,integer)'::regprocedure));
select pg_temp.check_privilege(has_table_privilege('anon','net.http_request_queue','SELECT'));
do $$begin
 begin perform app_security.assert_chat_safety_net_privileges(); raise exception 'EXPOSED_QUEUE_ACCEPTED';
 exception when insufficient_privilege then null; end;
 begin perform app_security.provision_chat_safety_project_url('wpppxlnbzqynvhpeuavd'); raise exception 'EXPOSED_QUEUE_PROVISIONED';
 exception when insufficient_privilege then null; end;
end$$;
select pg_temp.check_privilege((select count(*)=0 from vault.secrets_fixture));
-- Non-owner revoke cannot be a security solution. It must not change the owner's PUBLIC ACL.
do $$begin
 begin execute 'revoke all on net.http_request_queue from public';
 exception when insufficient_privilege then null; end;
end$$;
select pg_temp.check_privilege(has_table_privilege('anon','net.http_request_queue','SELECT'));
insert into vault.secrets_fixture(name,decrypted_secret) values
 ('email_outbox_worker_url','https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-email-outbox'),
 ('moderation_worker_url','https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-listing-moderation'),
 ('email_worker_secret',repeat('e',64)),('moderation_worker_secret',repeat('f',64));
create trigger email_fixture after insert on public.email_outbox for each row execute function app_security.trg_fn_notify_email_outbox_worker();
create trigger moderation_fixture after insert on public.listing_moderation_requests for each row execute function app_security.trg_fn_notify_moderation_worker();
insert into public.email_outbox default values;
select app_security.invoke_email_outbox_retry_batch();
insert into public.listing_moderation_requests default values;
select app_security.invoke_moderation_retry_batch();
select pg_temp.check_privilege((select count(*)=4 from net.http_request_queue));

-- HYPOTHETICAL OWNER REPAIR, FIXTURE ONLY. Supabase project ACL edits are unsupported.
-- Never extract/run this test block against a hosted project or grant role membership there.
set role supabase_admin;
grant select,insert,delete on net.http_request_queue to postgres;
grant insert on net.http_request_queue to supabase_functions_admin;
grant select(id) on net.http_request_queue to supabase_functions_admin;
grant usage on net.http_request_queue_id_seq to postgres,supabase_functions_admin;
revoke all on net.http_request_queue from public,anon,authenticated,service_role;
revoke all on net.http_request_queue_id_seq from public,anon,authenticated,service_role;
reset role;
set role postgres;
select app_security.assert_chat_safety_net_privileges();
select pg_temp.check_privilege(has_table_privilege('postgres','net.http_request_queue','INSERT'));
select pg_temp.check_privilege(has_sequence_privilege('postgres','net.http_request_queue_id_seq','USAGE'));
insert into public.email_outbox default values;
select app_security.invoke_email_outbox_retry_batch();
insert into public.listing_moderation_requests default values;
select app_security.invoke_moderation_retry_batch();
select pg_temp.check_privilege((select count(*)=8 from net.http_request_queue));
set role supabase_functions_admin;
select net.http_post('https://fixture.invalid');
reset role;
set role postgres;
select pg_temp.check_privilege(not has_column_privilege('supabase_functions_admin','net.http_request_queue','headers','SELECT'));
do $$declare r text;
begin
 foreach r in array array['anon','authenticated','service_role'] loop
  perform pg_temp.check_privilege(not has_any_column_privilege(r,'net.http_request_queue','SELECT'));
  perform pg_temp.check_privilege(not has_table_privilege(r,'net.http_request_queue','INSERT'));
 end loop;
end$$;
-- INSERT + RETURNING id needs both producer INSERT and return-column SELECT.
set role supabase_admin;
revoke insert on net.http_request_queue from postgres;
reset role;
set role postgres;
do $$begin
 begin perform net.http_post('https://fixture.invalid');raise exception 'MISSING_INSERT_ACCEPTED';
 exception when insufficient_privilege then null;end;
 begin perform app_security.assert_chat_safety_net_privileges();raise exception 'MISSING_INSERT_PREFLIGHT_ACCEPTED';
 exception when insufficient_privilege then null;end;
end$$;
set role supabase_admin;
grant insert on net.http_request_queue to postgres;
revoke usage on net.http_request_queue_id_seq from postgres;
reset role;
set role postgres;
do $$begin
 begin perform net.http_post('https://fixture.invalid');raise exception 'MISSING_SEQUENCE_ACCEPTED';
 exception when insufficient_privilege then null;end;
end$$;
set role supabase_admin;
grant usage on net.http_request_queue_id_seq to postgres;
revoke select on net.http_request_queue from postgres;
reset role;
set role postgres;
do $$begin
 begin perform net.http_post('https://fixture.invalid');raise exception 'MISSING_RETURNING_SELECT_ACCEPTED';
 exception when insufficient_privilege then null;end;
end$$;
set role supabase_admin;
grant select on net.http_request_queue to postgres;
-- Simulate managed extension grant restoration. Dispatcher must fail closed before reading Vault.
grant select on net.http_request_queue to public;
reset role;
set role postgres;
update app_security.chat_safety_runtime set project_ref='wpppxlnbzqynvhpeuavd',dispatch_enabled=true;
update app_security.chat_v2_flags set enabled=true where name='safety_warnings';
select app_security.dispatch_chat_safety();
select pg_temp.check_privilege((select count(*)=9 from net.http_request_queue));
select pg_temp.check_privilege((select last_dispatch_status='blocked' and dispatch_failures=1 from app_security.chat_safety_runtime));
set role supabase_admin;
revoke select on net.http_request_queue from public;
truncate net.http_request_queue;
reset role;
set role postgres;
update app_security.chat_safety_runtime set project_ref=null,dispatch_enabled=false;
update app_security.chat_v2_flags set enabled=false;
select app_security.assert_chat_safety_net_privileges();
select 'PASS ' || n || ' owner/invoker queue privilege checks (fixture-only repair; no hosted grant authority)' as result from privilege_check_count;
