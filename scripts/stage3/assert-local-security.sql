-- Read-only catalog inspection derived from accepted Stage 2B R6 evidence.
-- No worker/dispatch function is invoked. ACL exceptions are reported, not repaired.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
WITH rpc_names(signature) AS (VALUES
    ('app_security.claim_moderation_batch(integer,integer,uuid)'),
    ('app_security.get_listing_moderation_findings(uuid)'),
    ('app_security.get_seller_moderation_workflow_status(uuid)'),
    ('app_security.impl_claim_email_outbox_batch(integer,uuid,integer)'),
    ('app_security.impl_claim_email_outbox_job_by_id(uuid,uuid,integer)'),
    ('app_security.impl_complete_email_outbox_job(uuid,uuid,text)'),
    ('app_security.impl_fail_email_outbox_job(uuid,uuid,text,integer,text,boolean,integer,integer)'),
    ('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'),
    ('app_security.impl_moderate_listing_reviewed(uuid,text,text,integer,listing_status_enum)'),
    ('app_security.impl_moderate_listing(uuid,text,text)'),
    ('app_security.impl_verify_moderation_worker_secret(text)'),
    ('app_security.invoke_email_outbox_retry_batch()'),
    ('app_security.invoke_moderation_retry_batch()'),
    ('app_security.trg_fn_notify_email_outbox_worker()'),
    ('app_security.trg_fn_notify_moderation_worker()'),
    ('public.claim_email_outbox_batch(integer,uuid,integer)'),
    ('public.claim_email_outbox_job_by_id(uuid,uuid,integer)'),
    ('public.claim_moderation_batch(integer,integer,uuid)'),
    ('public.complete_email_outbox_job(uuid,uuid,text)'),
    ('public.fail_email_outbox_job(uuid,uuid,text,integer,text,boolean,integer,integer)'),
    ('public.get_listing_moderation_findings(uuid)'),
    ('public.get_seller_moderation_workflow_status(uuid)'),
    ('public.handle_listing_moderation_enqueue()'),
    ('public.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'),
    ('public.moderate_listing_reviewed(uuid,text,text,integer,listing_status_enum)'),
    ('public.moderate_listing(uuid,text,text)'),
    ('public.verify_moderation_worker_secret(text)')
), rpc_permissions AS (
  SELECT signature, to_regprocedure(signature) AS oid FROM rpc_names
), expected_triggers(signature) AS (VALUES
  ('public.handle_listing_moderation_enqueue()'),
  ('app_security.trg_fn_notify_moderation_worker()')
)
SELECT jsonb_build_object(
  'postgresVersion', split_part(current_setting('server_version'), ' ', 1),
  'version_num', current_setting('server_version_num')::integer,
  'migration_versions', (SELECT jsonb_agg(version ORDER BY version) FROM supabase_migrations.schema_migrations),
  'vault_count', (SELECT count(*) FROM vault.secrets),
  'moderation_automation_enabled', (SELECT setting_value FROM public.app_system_settings WHERE setting_key = 'moderation_automation_enabled'),
  'httpRequests', (SELECT count(*) FROM net.http_request_queue),
  'httpResponses', (SELECT count(*) FROM net._http_response),
  'checks', jsonb_build_object(
    'buckets', (SELECT jsonb_agg(jsonb_build_object('id', id, 'public', public) ORDER BY id)
      FROM storage.buckets WHERE id IN ('listing-originals','listing-derivatives')),
    'rls', (SELECT jsonb_agg(jsonb_build_object(
      'relname', c.relname, 'relrowsecurity', c.relrowsecurity, 'relforcerowsecurity', c.relforcerowsecurity,
      'policies', (SELECT count(*) FROM pg_policy WHERE polrelid = c.oid),
      'anon_any_dml', (has_table_privilege('anon',c.oid,'DELETE')
        OR has_any_column_privilege('anon',c.oid,'INSERT,UPDATE')),
      'authenticated_any_dml', (has_table_privilege('authenticated',c.oid,'DELETE')
        OR has_any_column_privilege('authenticated',c.oid,'INSERT,UPDATE'))) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('listings','listing_media','email_outbox')),
    'column_dml', (SELECT jsonb_agg(jsonb_build_object(
      'relname', c.relname,
      'anon_insert', COALESCE((SELECT jsonb_agg(a.attname ORDER BY a.attname)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege('anon',c.oid,a.attnum,'INSERT')), '[]'::jsonb),
      'anon_update', COALESCE((SELECT jsonb_agg(a.attname ORDER BY a.attname)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege('anon',c.oid,a.attnum,'UPDATE')), '[]'::jsonb),
      'authenticated_insert', COALESCE((SELECT jsonb_agg(a.attname ORDER BY a.attname)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege('authenticated',c.oid,a.attnum,'INSERT')), '[]'::jsonb),
      'authenticated_update', COALESCE((SELECT jsonb_agg(a.attname ORDER BY a.attname)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND has_column_privilege('authenticated',c.oid,a.attnum,'UPDATE')), '[]'::jsonb),
      'anon_table_insert', has_table_privilege('anon',c.oid,'INSERT'),
      'anon_table_update', has_table_privilege('anon',c.oid,'UPDATE'),
      'anon_table_delete', has_table_privilege('anon',c.oid,'DELETE'),
      'authenticated_table_insert', has_table_privilege('authenticated',c.oid,'INSERT'),
      'authenticated_table_update', has_table_privilege('authenticated',c.oid,'UPDATE'),
      'authenticated_table_delete', has_table_privilege('authenticated',c.oid,'DELETE')) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('listings','listing_media','email_outbox')),
    'extensions', (SELECT jsonb_object_agg(extname,extversion) FROM pg_extension
      WHERE extname IN ('pg_net','pg_cron','supabase_vault')),
    'sensitive_rpcs', (SELECT jsonb_agg(jsonb_build_object(
      'signature', replace(signature,'public.',''),
      'anon_execute', has_function_privilege('anon',r.oid,'EXECUTE'),
      'authenticated_execute', has_function_privilege('authenticated',r.oid,'EXECUTE'),
      'service_execute', has_function_privilege('service_role',r.oid,'EXECUTE'),
      'security_definer', p.prosecdef) ORDER BY signature)
      FROM rpc_permissions r LEFT JOIN pg_proc p ON p.oid=r.oid),
    'cron_jobs', (SELECT jsonb_agg(jsonb_build_object('active',active,'command',command,
      'database',database,'jobname',jobname,'schedule',schedule,'username',username) ORDER BY jobname)
      FROM cron.job),
    'runtime_settings', (SELECT jsonb_agg(jsonb_build_object('name',name,'setting',setting) ORDER BY name)
      FROM pg_settings WHERE name IN ('cron.database_name','cron.host','cron.launch_active_jobs'))
  ),
  'triggerAclContext', (SELECT jsonb_agg(jsonb_build_object(
    'signature',replace(t.signature,'public.',''), 'returns',format_type(p.prorettype,NULL),
    'anon_private_schema_usage', has_schema_privilege('anon','app_security','USAGE'),
    'authenticated_private_schema_usage', has_schema_privilege('authenticated','app_security','USAGE')) ORDER BY t.signature)
    FROM expected_triggers t LEFT JOIN pg_proc p ON p.oid=to_regprocedure(t.signature))
);
COMMIT;
