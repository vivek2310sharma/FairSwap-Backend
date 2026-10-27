\set ON_ERROR_STOP on
begin transaction read only;
-- An authorized protected operator captures this metadata privately for review.
-- No migration bodies, credentials, messages or user rows are exported.
select jsonb_build_object(
 'observedAt',clock_timestamp(),
 'ledger',coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name,
   'statementsSha256',encode(sha256(convert_to(coalesce(to_jsonb(statements)::text,'null'),'UTF8')),'hex')) order by version),'[]'::jsonb)
) as ledger_snapshot from supabase_migrations.schema_migrations;
commit;
