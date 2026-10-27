-- Owner/operator read-only monitoring. No mutation or job invocation.
begin read only;
select enabled,public_reads,jobs_enabled,staff_enabled,min_reviews from app_security.ratings_settings;
select jobname,active,schedule from cron.job where jobname in ('ratings-v1-publication','ratings-v1-reminders');
select count(*) as publication_backlog,
 extract(epoch from (clock_timestamp()-min(deadline))) as oldest_due_seconds
 from public.rating_trades where deadline<=clock_timestamp() and closed_at is null;
select count(*) as impossible_scores from public.profile_rating_stats
 where score<0 or score>10 or (counted_review_count<3 and score is not null);
select count(*) as open_disputes,min(created_at) as oldest_open_dispute
 from app_security.rating_cases where kind='dispute' and resolved_at is null;
select count(*) as audit_actions_last_day from app_security.rating_moderation_audit
 where created_at>=clock_timestamp()-interval '1 day';
select j.jobname,r.status,count(*) as runs,max(r.end_time) as latest_end
 from cron.job j join cron.job_run_details r on r.jobid=j.jobid
 where j.jobname in ('ratings-v1-publication','ratings-v1-reminders')
 and r.start_time>=clock_timestamp()-interval '1 day' group by j.jobname,r.status;
commit;
