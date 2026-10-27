-- Separate operator authorization required; never migration discovery.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1 or (select decrypted_secret from vault.decrypted_secrets where name='project_url') is distinct from 'https://kriuhwppxgxsyyrbjsau.supabase.co' then raise exception 'RATINGS_ENVIRONMENT_MISMATCH'; end if;
 if current_setting('server_version_num')::integer not between 170000 and 179999 then raise exception 'RATINGS_REQUIRES_PG17'; end if;
end $$;
do $$ begin
 if (select count(*) from app_security.ratings_settings)<>1 or exists(select 1 from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled) then raise exception 'RATINGS_FLAGS_MUST_BE_OFF'; end if;
 if to_regprocedure('public.ratings_given_history(timestamptz,uuid)') is null then raise exception 'ALL_SIX_REQUIRED'; end if;
end $$;
select app_security.ratings_provision_inactive_jobs();
do $$ begin
 if (select count(*) from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders'))<>2 or not exists(select 1 from cron.job where jobname='ratings-v1-publication' and schedule='*/5 * * * *' and command='select app_security.publish_due_reviews()' and active=false) or not exists(select 1 from cron.job where jobname='ratings-v1-reminders' and schedule='17 * * * *' and command='select app_security.rating_reminders()' and active=false) then raise exception 'RATINGS_INACTIVE_JOBS_REQUIRED'; end if;
end $$;
commit;
