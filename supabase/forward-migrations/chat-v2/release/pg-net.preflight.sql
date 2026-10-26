-- Read-only metadata; no queued headers/body/URLs, Vault values or function source.
-- Execute only under separately authorized owner release review. Does not grant ownership.
begin read only;
select current_user as operator,
  pg_get_userbyid(c.relowner) as queue_owner,
  has_table_privilege('postgres',c.oid,'INSERT') as postgres_insert,
  has_table_privilege('postgres',c.oid,'SELECT') as postgres_select,
  has_table_privilege('postgres',c.oid,'DELETE') as postgres_delete,
  has_sequence_privilege('postgres',pg_get_serial_sequence('net.http_request_queue','id'),'USAGE') as postgres_sequence_usage,
  current_setting('pg_net.username',true) as configured_worker_role
from pg_class c where c.oid=to_regclass('net.http_request_queue');
select rolname,has_any_column_privilege(oid,'net.http_request_queue','SELECT') as queue_readable
from pg_roles where rolname in ('anon','authenticated','service_role','authenticator','supabase_functions_admin');
select p.oid::regprocedure as caller,pg_get_userbyid(p.proowner) as owner,p.prosecdef
from pg_proc p where p.oid in (
  to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)'),
  to_regprocedure('app_security.trg_fn_notify_email_outbox_worker()'),
  to_regprocedure('app_security.invoke_email_outbox_retry_batch()'),
  to_regprocedure('app_security.trg_fn_notify_moderation_worker()'),
  to_regprocedure('app_security.invoke_moderation_retry_batch()'));
select e.evtname,e.evtenabled,pg_get_userbyid(p.proowner) as owner,
  md5(pg_get_functiondef(p.oid)) as definition_fingerprint
from pg_event_trigger e join pg_proc p on p.oid=e.evtfoid
where e.evtname='issue_pg_net_access' or p.proname='grant_pg_net_access';
-- Raises a generic exception on exposed queues, missing producer/worker rights or unknown worker role.
select app_security.assert_chat_safety_net_privileges();
commit;
