-- Separate operator authorization required; never migration discovery.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $$ begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1 or (select decrypted_secret from vault.decrypted_secrets where name='project_url') is distinct from 'https://kriuhwppxgxsyyrbjsau.supabase.co' then raise exception 'RATINGS_ENVIRONMENT_MISMATCH'; end if;
 if current_setting('server_version_num')::integer not between 170000 and 179999 then raise exception 'RATINGS_REQUIRES_PG17'; end if;
end $$;
update app_security.ratings_settings set enabled=false,public_reads=false,jobs_enabled=false,staff_enabled=false;
do $$ declare j bigint; begin for j in select jobid from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders') loop perform cron.alter_job(j,active:=false); end loop; end $$;
commit;
