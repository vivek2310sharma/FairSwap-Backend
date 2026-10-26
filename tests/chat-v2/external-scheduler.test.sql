-- Disposable assertions, shared by PGlite and native PG15. No external network.
create temp table external_check_count(n integer not null);
insert into external_check_count values(0);
create function pg_temp.check_external(ok boolean) returns void language plpgsql as $$begin
 if ok is distinct from true then raise exception 'CHAT_EXTERNAL_SCHEDULER_REGRESSION_CHECK_%',(select n+1 from external_check_count);end if;
 update external_check_count set n=n+1;
end$$;
update app_security.chat_v2_flags set enabled=false;
update app_security.chat_safety_runtime set project_ref=null,external_scheduler_enabled=false,dispatch_enabled=false;
delete from vault.secrets_fixture where name='project_url';
update vault.secrets_fixture set decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-email-outbox' where name='email_outbox_worker_url';
update vault.secrets_fixture set decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-listing-moderation' where name='moderation_worker_url';
-- Restore the actual platform PUBLIC grants: external setup must NOT depend on a queue ACL repair.
set role supabase_admin;
grant all on net.http_request_queue to public;
reset role;
set role postgres;
select app_security.configure_chat_safety_external_inactive('wpppxlnbzqynvhpeuavd');
select app_security.configure_chat_safety_external_inactive('wpppxlnbzqynvhpeuavd');
select pg_temp.check_external((select project_ref='wpppxlnbzqynvhpeuavd' and not external_scheduler_enabled and not dispatch_enabled from app_security.chat_safety_runtime));
select pg_temp.check_external((select count(*)=0 from vault.secrets_fixture where name='project_url'));
select pg_temp.check_external((select count(*)=5 from app_security.chat_v2_flags where not enabled));
select pg_temp.check_external(not exists(select 1 from cron.job where jobname in ('chat-safety-fairswaptest','chat-safety-fairswapprod') and active));
select pg_temp.check_external((select pg_get_functiondef('app_security.dispatch_chat_safety()'::regprocedure) not like '%net.http_post%'));
create temp table external_queue_baseline as select count(*) as n from net.http_request_queue;
select app_security.dispatch_chat_safety();
select pg_temp.check_external((select count(*)=(select n from external_queue_baseline) from net.http_request_queue));
update vault.secrets_fixture set decrypted_secret=repeat('a',64) where name='chat_safety_worker_secret';
set role service_role;
select public.verify_chat_safety_worker_digest(encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex')) as proof_valid;
do $$begin
 if public.verify_chat_safety_worker_digest(repeat('a',64)) then raise exception 'RAW_CREDENTIAL_ACCEPTED_AS_PROOF';end if;
 begin perform public.verify_chat_safety_worker_secret(repeat('a',64));raise exception 'RAW_VERIFIER_STILL_CALLABLE';
 exception when insufficient_privilege then null;end;
end$$;
reset role;
set role postgres;
select pg_temp.check_external(public.verify_chat_safety_worker_digest(encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex')));
select pg_temp.check_external((public.chat_safety_schedule_begin('gha:101:test','test')->>'state')='disabled');
update app_security.chat_safety_runtime set external_scheduler_enabled=true;
select pg_temp.check_external((public.chat_safety_schedule_begin('gha:101:test','test')->>'state')='disabled');
update app_security.chat_v2_flags set enabled=true where name='safety_warnings';
create temp table external_lease as select public.chat_safety_schedule_begin('gha:101:test','test') as result;
select pg_temp.check_external((select result->>'state'='claimed' from external_lease));
select pg_temp.check_external((public.chat_safety_schedule_begin('gha:101:test','test')->>'state')='busy');
select pg_temp.check_external((public.chat_safety_schedule_begin('gha:102:test','test')->>'state')='busy');
select pg_temp.check_external(not public.chat_safety_schedule_finish('gha:101:test',gen_random_uuid(),0,0,0));
select pg_temp.check_external(public.chat_safety_schedule_finish('gha:101:test',(select (result->>'lease_token')::uuid from external_lease),0,0,0));
select pg_temp.check_external(public.chat_safety_schedule_finish('gha:101:test',(select (result->>'lease_token')::uuid from external_lease),0,0,0));
select pg_temp.check_external((public.chat_safety_schedule_begin('gha:101:test','test')->>'state')='completed');
select pg_temp.check_external((select attempts=1 from app_security.chat_safety_scheduler_runs where invocation_id='gha:101:test'));
do $$begin
 begin perform public.chat_safety_schedule_begin('gha:105:prod','prod');raise exception 'CROSS_ENV_ACCEPTED';exception when insufficient_privilege then null;end;
 begin perform public.chat_safety_schedule_begin('not-a-github-run','test');raise exception 'BAD_ID_ACCEPTED';exception when invalid_parameter_value then null;end;
end$$;
select public.chat_safety_schedule_begin('gha:102:test','test');
create temp table first_expired as select lease_token from app_security.chat_safety_scheduler_runs where invocation_id='gha:102:test';
update app_security.chat_safety_scheduler_runs set lease_until=clock_timestamp()-interval '1 second' where invocation_id='gha:102:test';
select public.chat_safety_schedule_begin('gha:102:test','test');
select pg_temp.check_external(not public.chat_safety_schedule_finish('gha:102:test',(select lease_token from first_expired),0,0,0));
update app_security.chat_safety_scheduler_runs set lease_until=clock_timestamp()-interval '1 second' where invocation_id='gha:102:test';
select public.chat_safety_schedule_begin('gha:102:test','test');
update app_security.chat_safety_scheduler_runs set lease_until=clock_timestamp()-interval '1 second' where invocation_id='gha:102:test';
select pg_temp.check_external((public.chat_safety_schedule_begin('gha:102:test','test')->>'state')='exhausted');
select pg_temp.check_external((select attempts=3 from app_security.chat_safety_scheduler_runs where invocation_id='gha:102:test'));
select pg_temp.check_external((public.chat_safety_scheduler_metrics()->>'completed')::integer=1);
do $$declare r text;begin
 foreach r in array array['anon','authenticated'] loop
  if has_function_privilege(r,'public.chat_safety_schedule_begin(text,text)','EXECUTE')
    or has_function_privilege(r,'public.chat_safety_scheduler_metrics()','EXECUTE')
    or has_table_privilege(r,'app_security.chat_safety_scheduler_runs','SELECT') then raise exception 'CLIENT_SCHEDULER_ACCESS';end if;
 end loop;
end$$;
update app_security.chat_v2_flags set enabled=false;
update app_security.chat_safety_runtime set external_scheduler_enabled=false,project_ref=null;
update vault.secrets_fixture set decrypted_secret='https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/process-email-outbox' where name='email_outbox_worker_url';
update vault.secrets_fixture set decrypted_secret='https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/process-listing-moderation' where name='moderation_worker_url';
select app_security.configure_chat_safety_external_inactive('kriuhwppxgxsyyrbjsau');
select app_security.configure_chat_safety_external_inactive('kriuhwppxgxsyyrbjsau');
select pg_temp.check_external((select project_ref='kriuhwppxgxsyyrbjsau' and not external_scheduler_enabled from app_security.chat_safety_runtime));
select pg_temp.check_external((select count(*)=5 from app_security.chat_v2_flags where not enabled));
select 'PASS '||n||' external scheduler idempotency/authentication/isolation checks' as result from external_check_count;
