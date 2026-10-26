-- Owner-run FairSwapProd inactive infrastructure only, after five approved migrations.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$ begin
 if (select count(*) from vault.decrypted_secrets where name='project_url')<>1 or (select decrypted_secret from vault.decrypted_secrets where name='project_url') is distinct from 'https://kriuhwppxgxsyyrbjsau.supabase.co' then raise exception 'RATINGS_ENVIRONMENT_MISMATCH'; end if;
end $$;
select app_security.ratings_provision_inactive_jobs();
commit;
