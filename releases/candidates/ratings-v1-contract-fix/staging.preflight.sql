-- Read-only delta preflight for FairSwapTest; run after the initial five Ratings migrations.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1 or (select decrypted_secret from vault.decrypted_secrets where name='project_url') is distinct from 'https://wpppxlnbzqynvhpeuavd.supabase.co' then raise exception 'RATINGS_ENVIRONMENT_MISMATCH'; end if;
 if current_setting('server_version_num')::integer not between 170000 and 179999 then raise exception 'RATINGS_REQUIRES_PG17'; end if;
 if to_regprocedure('app_security.rating_review_json(uuid,boolean)') is null or to_regprocedure('app_security.impl_ratings_trade(uuid)') is null or to_regprocedure('app_security.ratings_export_base(uuid)') is null or to_regprocedure('app_security.impl_admin_ratings_case(uuid,text,text)') is null then raise exception 'RATINGS_INITIAL_RELEASE_REQUIRED'; end if;
 if (select count(*) from app_security.ratings_settings)<>1 or exists(select 1 from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled) then raise exception 'RATINGS_FLAGS_MUST_BE_OFF'; end if;
 if exists(select 1 from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders') and active) then raise exception 'RATINGS_JOBS_MUST_BE_INACTIVE'; end if;
 if to_regprocedure('public.ratings_given_history(timestamptz,uuid)') is not null then raise exception 'RATINGS_DELTA_ALREADY_INSTALLED_OR_PARTIAL'; end if;
end $$;
-- Capture installed contracts/ACLs in this environment's receipt, without secrets.
select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl
 from pg_proc p where p.oid in ('app_security.rating_review_json(uuid,boolean)'::regprocedure,'app_security.impl_seller_transition_listing(uuid,text)'::regprocedure,'app_security.impl_fulfill_data_export(uuid)'::regprocedure,'app_security.impl_admin_ratings_case(uuid,text,text)'::regprocedure);
rollback;
