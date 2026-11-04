-- Activate only after matching Web (POST_AD_WEARABLES_V1_ENABLED) and automated Test verification; no generic writes.
-- R4 (W-AZ-1): before the category is enabled, the installed Azure moderation finalizer (20261104113705, left untouched in
-- history) is wrapped so that a wearable carrying a risk flag can never be finalized as auto-approved; it is routed to staff.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$begin
 if (select rows_approved from public.wearable_catalogue_revision_v1)<>(select count(*) from public.wearable_models_v1 where status='approved')
  or to_regprocedure('public.submit_wearable_v1(jsonb)') is null or to_regprocedure('public.wearable_v1_session(uuid,text,uuid)') is null
  or to_regprocedure('app_security.impl_posting_session_core_v1(uuid,text,uuid,uuid)') is null
  or not exists(select 1 from pg_catalog.pg_trigger where tgname='zz_wearable_listing_guard_v1' and tgrelid='public.listings'::regclass) then raise exception 'WEARABLES_ACTIVATION_PREREQUISITE_MISSING';end if;
end $$;

-- W-AZ-1 compatibility. Strict preconditions, all fail closed:
--  * the finalizer, if present, must be EXACTLY the reviewed Azure body (sha256 of pg_proc.prosrc pinned below), definer, empty search_path;
--  * it must not already be wrapped. If no finalizer exists there is no moderation publication path to correct (the hosted release
--    preflight requires Azure, so this branch cannot occur in Test or Production).
-- The Azure function is renamed, not edited; the wrapper keeps the original name/signature so every caller, the public
-- wrapper and the Azure postflight resolve to it. Authority is the listing's own risk-flag rows only: never the caller's
-- claims, Azure's outcome or any setting.
do $$
declare
 v_inner constant text:='app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)';
 v_oid oid:=pg_catalog.to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)');
 p pg_catalog.pg_proc;
begin
 if v_oid is null then
  if pg_catalog.to_regprocedure(v_inner) is not null then raise exception 'WEARABLES_AZURE_FINALIZER_INCONSISTENT';end if;
  raise notice 'WEARABLES_AZURE_FINALIZER_ABSENT: no moderation finalizer to wrap';
  return;
 end if;
 if pg_catalog.to_regprocedure(v_inner) is not null then raise exception 'WEARABLES_AZURE_FINALIZER_ALREADY_WRAPPED';end if;
 select * into p from pg_catalog.pg_proc where oid=v_oid;
 if pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc,'UTF8')),'hex')<>'fb49b713b5e37b784df6c43cad18ad63a036796d0463a2ad7350acf011ee30be'
  or not p.prosecdef or p.prokind<>'f' or p.prorettype<>'jsonb'::regtype or p.provolatile<>'v'
  or not coalesce(p.proconfig @> array['search_path=""'],false) then raise exception 'WEARABLES_AZURE_BASELINE_DRIFT: installed finalizer is not the reviewed Azure 20261104113705 body';end if;
 if pg_catalog.to_regclass('public.listing_wearable_risk_flags_v1') is null or pg_catalog.to_regclass('app_security.listing_moderation_scan_receipts') is null then raise exception 'WEARABLES_AZURE_PREREQUISITE_MISSING';end if;
 alter function app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) rename to impl_finalize_moderation_result_azure_v1;
 revoke all on function app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) from public,anon,authenticated,service_role;
 execute $ddl$
create function app_security.impl_finalize_moderation_result(p_request_id uuid,p_claim_token uuid,p_outcome text,p_ruleset_version text,p_scope text,p_completed_rules text[],p_failed_rules text[],p_flags jsonb,p_errors jsonb default '[]'::jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $w$
declare v_listing uuid;v_outcome text:=p_outcome;
begin
 -- Only a would-be approval can publish. Lock order is the Azure order (listing row first, then request), so concurrent
 -- finalizers serialize on the listing and the loser observes a completed request.
 if p_outcome is not distinct from 'no_review_flags' then
  select r.listing_id into v_listing from public.listing_moderation_requests r where r.id=p_request_id;
  if v_listing is not null then
   perform 1 from public.listings l where l.id=v_listing for update;
   if exists(select 1 from public.listing_wearable_risk_flags_v1 f where f.listing_id=v_listing) then v_outcome:='needs_review';end if;
  end if;
 end if;
 -- needs_review makes the Azure body itself record the result, complete the request, consume the receipt and route to staff in one transaction.
 return app_security.impl_finalize_moderation_result_azure_v1(p_request_id,p_claim_token,v_outcome,p_ruleset_version,p_scope,p_completed_rules,p_failed_rules,p_flags,p_errors);
end $w$
 $ddl$;
 revoke all on function app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) from public,anon,authenticated;
 grant execute on function app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) to service_role;
end $$;

update public.categories set is_active=true where id=(select category_id from public.wearable_release_v1);
update public.wearable_release_v1 set enabled=true;
commit;
