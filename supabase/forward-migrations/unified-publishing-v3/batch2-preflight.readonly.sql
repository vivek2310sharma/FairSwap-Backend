-- Pre-installation evidence only. This query reads catalogue and guard metadata.
select count(*)::integer as leaves,
  md5(string_agg(c.slug||':'||c.id::text,',' order by c.slug)) as binding_fingerprint,
  bool_and(not c.new_listing_enabled and not c.is_active and c.status='coming_soon') as all_disabled
from public.categories c join public.categories p on p.id=c.parent_id
where p.slug in ('v2-computers-gaming','v2-tvs-audio-cameras','v2-home-appliances',
  'v2-furniture-home','v2-fashion','v2-books-sports-hobbies');

select count(*) filter (where t.tgname='trg_identity_gate' and t.tgenabled in ('O','A'))::integer as identity_triggers,
  to_regprocedure('app_security.enforce_verified_actor(uuid,boolean)') is not null as identity_helper,
  to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') is not null as provider_finalizer
from pg_catalog.pg_trigger t where not t.tgisinternal and t.tgrelid in
  ('public.listings'::regclass,'public.listing_media'::regclass,'public.posting_upload_sessions'::regclass,
   'public.posting_staged_media'::regclass);
