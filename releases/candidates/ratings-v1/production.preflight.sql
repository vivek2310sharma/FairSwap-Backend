-- Owner-run read-only preflight for FairSwapProd; not an apply migration.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1 or (select decrypted_secret from vault.decrypted_secrets where name='project_url') is distinct from 'https://kriuhwppxgxsyyrbjsau.supabase.co' then raise exception 'RATINGS_ENVIRONMENT_MISMATCH'; end if;
 if current_setting('server_version_num')::integer not between 170000 and 179999 then raise exception 'RATINGS_REQUIRES_PG17'; end if;
 if to_regclass('public.rating_trades') is not null or to_regprocedure('app_security.ratings_export_base(uuid)') is not null then raise exception 'RATINGS_ALREADY_INSTALLED_OR_PARTIAL'; end if;
 if to_regprocedure('app_security.impl_seller_transition_listing(uuid,text)') is null or to_regprocedure('app_security.impl_fulfill_data_export(uuid)') is null or to_regprocedure('app_security.is_active_staff_aal2(public.staff_role_enum)') is null then raise exception 'RATINGS_BASE_CONTRACT_MISSING'; end if;
 if to_regprocedure('cron.schedule(text,text,text)') is null then raise exception 'RATINGS_PG_CRON_PREREQUISITE'; end if;
end $$;
-- Capture these nonsecret definitions/ACLs with the reviewed environment ledger.
select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl from pg_proc p where p.oid in ('app_security.impl_seller_transition_listing(uuid,text)'::regprocedure,'app_security.impl_fulfill_data_export(uuid)'::regprocedure,'public.admin_fulfill_data_export(uuid)'::regprocedure);
rollback;
