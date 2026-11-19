-- Owner-side evidence only. Run independently in Test and Production.
begin read only;
set local statement_timeout='15s';

select version,name
from supabase_migrations.schema_migrations
where version in ('20261026183000','20261117090000','20261119120000',
  '20261117185218','20261118092010','20261119092042','20261119100640',
  '20261119102359','20261119103516','20261119105021','20261119111559','20261119114512')
order by version;

select setting_key,setting_value from public.app_system_settings
where setting_key in ('identity_verification_required','moderation_automation_enabled','moderation_azure_enabled')
order by setting_key;

with expected(relation_name,handler_name) as (values
 ('public.listings','trg_identity_gate_listings'),
 ('public.listing_media','trg_identity_gate_by_listing'),
 ('public.posting_upload_sessions','trg_identity_gate_posting_session'),
 ('public.posting_staged_media','trg_identity_gate_staged_media'))
select e.relation_name, e.handler_name, p.oid is not null and n.nspname='app_security'
  and p.proname=e.handler_name and t.tgenabled in ('O','A') as expected_handler_enabled,
  case when p.oid is not null then pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) end as source_fingerprint
from expected e left join pg_catalog.pg_trigger t
  on t.tgrelid=pg_catalog.to_regclass(e.relation_name) and t.tgname='trg_identity_gate' and not t.tgisinternal
left join pg_catalog.pg_proc p on p.oid=t.tgfoid
left join pg_catalog.pg_namespace n on n.oid=p.pronamespace
order by e.relation_name;

with expected(signature) as (values
 ('app_security.enforce_verified_actor(uuid,boolean)'),
 ('app_security.identity_gate_enabled()'),
 ('app_security.is_identity_verified(uuid)'),
 ('app_security.v3_seller_identity_enforced()'),
 ('public.moderate_listing_reviewed(uuid,text,text,integer,public.listing_status_enum)'),
 ('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'))
select e.signature, p.oid is not null as installed,
  case when p.oid is not null then pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)) end as source_fingerprint
from expected e left join pg_catalog.pg_proc p on p.oid=pg_catalog.to_regprocedure(e.signature);

select c.slug,p.slug as parent_slug,c.id,c.status,c.is_active,c.new_listing_enabled,c.posting_flow
from public.categories c join public.categories p on p.id=c.parent_id
where p.slug like 'v2-%' and c.posting_flow is not null
order by c.slug;

select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where (n.nspname='app_security' and c.relname in ('ordinary_goods_contracts_v3','ordinary_goods_sessions_v3','specialist_vehicle_draft_refs_v3'))
   or (n.nspname='public' and c.relname in ('listings','listing_media','posting_upload_sessions','posting_staged_media'));

select n.nspname,c.relname,
  pg_catalog.has_table_privilege('anon',c.oid,'SELECT') as anon_select,
  pg_catalog.has_table_privilege('authenticated',c.oid,'INSERT') as client_insert,
  pg_catalog.has_table_privilege('authenticated',c.oid,'UPDATE') as client_update,
  pg_catalog.has_table_privilege('service_role',c.oid,'UPDATE') as service_update
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
where n.nspname='app_security' and c.relname in
 ('ordinary_goods_contracts_v3','ordinary_goods_sessions_v3','specialist_vehicle_draft_refs_v3');

select id,public from storage.buckets
where id in ('listing-originals','listing-derivatives','posting-staged')
order by id;
commit;
