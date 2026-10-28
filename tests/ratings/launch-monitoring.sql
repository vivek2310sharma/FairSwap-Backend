-- Operator-only aggregate monitoring. No identities, content, error text or mutation.
-- Run separately against an independently verified project; this is not a deploy script.
begin isolation level repeatable read read only;
set local statement_timeout='15s';
select enabled,public_reads,jobs_enabled,staff_enabled,min_reviews,
 min_reviews<>3 as threshold_configuration_alert from app_security.ratings_settings;
select count(*)<>2 as missing_jobs_alert,
 count(*) filter(where active) as active_jobs
 from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders');
select jobname,active,schedule from cron.job
 where jobname in ('ratings-v1-publication','ratings-v1-reminders');
select count(*) as publication_backlog,
 coalesce(extract(epoch from (clock_timestamp()-min(deadline))),0) as oldest_due_seconds,
 coalesce(min(deadline)<clock_timestamp()-interval '10 minutes',false) as publication_lag_alert
 from public.rating_trades where deadline<=clock_timestamp() and closed_at is null;
select count(*) as impossible_scores from public.profile_rating_stats
 where score<0 or score>10 or (counted_review_count<3 and score is not null)
 or (counted_review_count>=3 and score is null)
 or counted_review_count>published_review_count;
select count(*) as duplicate_reminder_keys from (
 select trade_id,user_id,kind from app_security.rating_notification_receipts
 group by trade_id,user_id,kind having count(*)>1
) duplicates;
select kind,count(*) as open_cases,
 coalesce(extract(epoch from (clock_timestamp()-min(created_at))),0) as oldest_open_seconds
 from app_security.rating_cases where resolved_at is null group by kind;
select count(*) as audit_actions_last_day from app_security.rating_moderation_audit
 where created_at>=clock_timestamp()-interval '1 day';
select j.jobname,r.status,count(*) as runs,max(r.end_time) as latest_end
 from cron.job j join cron.job_run_details r on r.jobid=j.jobid
 where j.jobname in ('ratings-v1-publication','ratings-v1-reminders')
 and r.start_time>=clock_timestamp()-interval '1 day' group by j.jobname,r.status;
select count(*) filter(where r.status='failed') as failed_runs_alert,
 count(*) filter(where r.status in ('starting','running') and r.start_time<clock_timestamp()-interval '10 minutes') as stalled_runs_alert
 from cron.job j join cron.job_run_details r on r.jobid=j.jobid
 where j.jobname in ('ratings-v1-publication','ratings-v1-reminders')
 and r.start_time>=clock_timestamp()-interval '1 day';
-- An active scheduler can silently stop recording runs without emitting a
-- failed/starting/running row. Inactive launch gates must not page on this.
-- Match the verified Test/Production cadences; alert separately on cron drift.
select j.jobname,
 j.active and coalesce(max(r.start_time)<clock_timestamp()-e.silence_threshold,true)
  as missing_recent_run_alert,
 j.schedule is distinct from e.schedule as scheduler_configuration_alert
 from cron.job j join (values
  ('ratings-v1-publication','*/5 * * * *',interval '10 minutes'),
  ('ratings-v1-reminders','17 * * * *',interval '75 minutes')
 ) e(jobname,schedule,silence_threshold) on e.jobname=j.jobname
 left join cron.job_run_details r on r.jobid=j.jobid
 group by j.jobid,j.jobname,j.active,j.schedule,e.schedule,e.silence_threshold;
commit;
