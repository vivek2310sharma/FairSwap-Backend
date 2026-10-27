-- Owner-run rollback artifact only; never applied by migration discovery.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
update app_security.ratings_settings set enabled=false,public_reads=false,jobs_enabled=false,staff_enabled=false;
do $$ declare j bigint; begin
 for j in select jobid from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders') loop
  perform cron.alter_job(j,active:=false);
 end loop;
end $$;
commit;
