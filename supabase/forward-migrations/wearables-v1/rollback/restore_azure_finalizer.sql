-- REVIEW-ONLY forward fix; never auto-run. Restores the original Azure finalizer name (undoes the W-AZ-1 wrapper installed by the
-- Wearables activation). ONLY run after disable_wearables_v1.sql and after confirming no flagged wearable remains pending review:
-- without the wrapper, Azure finalization of a flagged wearable raises "Wearable listing requires staff review" again (fail closed,
-- never publishes) and its moderation request stays claimed until the lease expires.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$begin
 if pg_catalog.to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') is null
  or pg_catalog.to_regprocedure('app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') is null
  or exists(select 1 from public.wearable_release_v1 where enabled) then raise exception 'WEARABLES_AZURE_ROLLBACK_PRECONDITION_FAILED';end if;
 drop function app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb);
 alter function app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) rename to impl_finalize_moderation_result;
 revoke all on function app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) from public,anon,authenticated;
 grant execute on function app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) to service_role;
end $$;
commit;
