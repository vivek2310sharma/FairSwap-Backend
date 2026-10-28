import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function operationsChecks(db,test) {
 const q=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
 const codes=async()=> (await q('select app_security.ratings_operational_health()')).codes;
 const owner=()=>db.exec('reset role;set role postgres');
 await owner();
 await db.exec('select app_security.ratings_provision_inactive_jobs()');
 await test('monitor detects configuration drift without enabling Ratings or modifying IDV',async()=>{
  await db.exec(`begin;
   update public.profile_rating_stats set counted_review_count=0,published_review_count=0,score=null,communication_average=null,payment_item_average=null,meetup_average=null;
   update app_security.ratings_settings set min_reviews=4;
   do $$ begin if not (app_security.ratings_operational_health()->'codes' ? 'invalid_reputation') then raise exception 'THRESHOLD_DRIFT_NOT_DETECTED'; end if; end $$;
   rollback;`);
  await db.exec(`do $$ begin perform set_config('cron.log_run','off',true);
   if not (app_security.ratings_operational_health()->'codes' ? 'schedule_drift') then raise exception 'CRON_LOG_DRIFT_NOT_DETECTED'; end if; end $$;`);
  assert.equal(await q("select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_security' and c.relname in ('idv_verification_attempts','idv_identity_records','idv_audit_events') and c.relrowsecurity"),3);
 });
 await test('operations denies consumer diagnostics, fixture enrollment and global workers',async()=>{
  for(const role of ['anon','authenticated','service_role']) {
   await db.exec(`set role ${role}`);
   for(const sql of ['select app_security.publish_due_reviews()', 'select app_security.rating_reminders()',
    'select * from app_security.rating_acceptance_fixtures','select * from app_security.rating_operations_alerts','select app_security.ratings_operational_health()'])
    await assert.rejects(()=>q(sql),/permission denied/);
   if(role!=='service_role')await assert.rejects(()=>q('select public.ratings_operations_claim()'),/permission denied/);
   await owner();
  }
 });
 const seller=randomUUID(),buyer=randomUUID(),other=randomUUID();let trade;
 await test('fixture processing rejects Prod, unregistered trades and expired fixtures',async()=>{
  for(const u of [seller,buyer])await db.query("insert into auth.users(id,email) values($1,$2)",[u,`${u}@ratings-test.invalid`]);
  trade=await q("insert into public.rating_trades(seller_id,buyer_id,state) values($1,$2,'pending_buyer') returning id",[seller,buyer]);
  await db.exec("delete from vault.decrypted_secrets; insert into vault.decrypted_secrets values('project_url','https://kriuhwppxgxsyyrbjsau.supabase.co')");
  await assert.rejects(()=>q('select public.ratings_process_fixture($1)',[trade]),/RATINGS_FIXTURE_ACCESS_DENIED/);
  await db.exec("update vault.decrypted_secrets set decrypted_secret='https://wpppxlnbzqynvhpeuavd.supabase.co'");
  await assert.rejects(()=>q('select public.ratings_process_fixture($1)',[trade]),/RATINGS_FIXTURE_ACCESS_DENIED/);
  await db.query("insert into app_security.rating_acceptance_fixtures(trade_id,expires_at) values($1,clock_timestamp()-interval '1 second')",[trade]);
  await assert.rejects(()=>q('select public.ratings_process_fixture($1)',[trade]),/RATINGS_FIXTURE_ACCESS_DENIED/);
  await db.query("update app_security.rating_acceptance_fixtures set expires_at=clock_timestamp()+interval '30 minutes' where trade_id=$1",[trade]);
 });
 await test('isolated acceptance persists exactly two notifications with flags off and excludes unrelated due work',async()=>{
  await db.query("insert into public.rating_trades(id,state,sold_at,deadline) values($1,'pending_selection',statement_timestamp()-interval '15 days',statement_timestamp()-interval '1 day')",[other]);
  const before=await q('select count(*)::int from public.notifications');
  await db.exec('set role service_role');
  assert.equal(await q('select public.ratings_process_fixture($1)',[trade]),0);
  assert.equal(await q('select public.ratings_process_fixture($1)',[trade]),0);
  await owner();assert.equal(await q('select count(*)::int from public.notifications'),before+2);
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1 and notification_id is not null and delivery_version=1',[trade]),2);
  await db.query("update public.rating_trades set sold_at=statement_timestamp()-interval '15 days',deadline=statement_timestamp()-interval '1 day' where id=$1",[trade]);
  await db.exec('set role service_role');assert.equal(await q('select public.ratings_process_fixture($1)',[trade]),1);
  assert.equal(await q('select public.ratings_process_fixture($1)',[trade]),0);
  await owner();assert.equal(await q('select closed_at from public.rating_trades where id=$1',[other]),null);
  assert.equal(await q('select count(*)::int from app_security.ratings_settings where enabled or jobs_enabled or staff_enabled or public_reads'),0);
 });
 await test('fixture scope rejects shared accounts, ordinary emails and staff identities',async()=>{
  const shared=await q("insert into public.rating_trades(seller_id,state) values($1,'pending_selection') returning id",[seller]);
  await assert.rejects(()=>q('select public.ratings_process_fixture($1)',[trade]),/RATINGS_FIXTURE_ACCESS_DENIED/);
  await db.query('delete from public.rating_trades where id=$1',[shared]);
  await db.query("update auth.users set email='ordinary@example.invalid' where id=$1",[seller]);
  await assert.rejects(()=>q('select public.ratings_process_fixture($1)',[trade]),/RATINGS_FIXTURE_ACCESS_DENIED/);
  await db.query('update auth.users set email=$2 where id=$1',[seller,`${seller}@ratings-test.invalid`]);
  await db.query("insert into public.staff_roles(user_id,role) values($1,'moderator')",[seller]);
  await assert.rejects(()=>q('select public.ratings_process_fixture($1)',[trade]),/RATINGS_FIXTURE_ACCESS_DENIED/);
  await db.query('delete from public.staff_roles where user_id=$1',[seller]);
 });
 await test('monitor detects schedule drift, failed/stalled/missing cron at publication and reminder thresholds',async()=>{
  await db.exec('update app_security.ratings_settings set enabled=true,jobs_enabled=true; update cron.job set active=true');
  assert((await codes()).includes('publication_missing'));assert((await codes()).includes('reminder_missing'));
  await db.exec("insert into cron.job_run_details(jobid,status,start_time,end_time) select jobid,'succeeded',clock_timestamp()-interval '1 minute',clock_timestamp() from cron.job where jobname like 'ratings-v1-%'");
  assert(!(await codes()).includes('publication_missing'));assert(!(await codes()).includes('reminder_missing'));
  await db.exec("update cron.job_run_details set end_time=clock_timestamp()-interval '11 minutes' where jobid=(select jobid from cron.job where jobname='ratings-v1-publication')");
  assert((await codes()).includes('publication_missing'));assert(!(await codes()).includes('reminder_missing'));
  await db.exec("update cron.job_run_details set end_time=clock_timestamp()-interval '76 minutes' where jobid=(select jobid from cron.job where jobname='ratings-v1-reminders')");
  assert((await codes()).includes('reminder_missing'));
  await db.exec("insert into cron.job_run_details(jobid,status,start_time) select jobid,'failed',clock_timestamp() from cron.job where jobname='ratings-v1-publication'");
  assert((await codes()).includes('cron_failed'));
  await db.exec("insert into cron.job_run_details(jobid,status,start_time) select jobid,'running',clock_timestamp() from cron.job where jobname='ratings-v1-publication'");
  assert((await codes()).includes('cron_failed'));
  await db.exec("insert into cron.job_run_details(jobid,status,start_time) select jobid,'running',clock_timestamp()-interval '80 minutes' from cron.job where jobname='ratings-v1-reminders';update cron.job set schedule='* * * * *' where jobname='ratings-v1-reminders'");
  assert((await codes()).includes('cron_stalled'));assert((await codes()).includes('schedule_drift'));
 });
 await test('monitor catches aged backlog, missing persistence, invalid reputation and unresolved reports',async()=>{
  assert((await codes()).includes('publication_backlog'));
  await db.query('update public.profile_rating_stats set counted_review_count=0,score=1 where user_id=$1',[seller]);
  assert((await codes()).includes('invalid_reputation'));
  await db.query("insert into app_security.rating_cases(trade_id,kind,reason,created_at) values($1,'review_report','Fixture only',clock_timestamp()-interval '25 hours')",[trade]);
  assert((await codes()).includes('moderation_unresolved'));
  await db.query('delete from public.notifications where id in (select notification_id from app_security.rating_notification_receipts where trade_id=$1)',[trade]);
  assert((await codes()).includes('notification_missing'));
 });
 await test('alert leases deduplicate concurrent polls, retry failures and acknowledge by token only',async()=>{
  await db.exec('set role service_role');let claims;
  if(db.port) {
   const polls=await Promise.all([db.query('select public.ratings_operations_claim()',[],true),db.query('select public.ratings_operations_claim()',[],true)]);
   const batches=polls.map(p=>Object.values(p.rows[0])[0]);
   assert.equal(batches.filter(b=>b.length===0).length,1);claims=batches.find(b=>b.length>0);
  } else claims=await q('select public.ratings_operations_claim()');
  assert(claims.length>0);
  assert.deepEqual(await q('select public.ratings_operations_claim()'),[]);
  const first=claims[0];assert.equal(await q('select public.ratings_operations_ack($1,$2)',[first.code,randomUUID()]),false);
  await owner();await db.exec("update app_security.rating_operations_alerts set lease_until=clock_timestamp()-interval '1 second'");
  await db.exec('set role service_role');const retry=await q('select public.ratings_operations_claim()');assert.equal(retry.length,claims.length);
  assert.equal(await q('select public.ratings_operations_ack($1,$2)',[first.code,first.token]),false);
  for(const claim of retry)assert.equal(await q('select public.ratings_operations_ack($1,$2)',[claim.code,claim.token]),true);
  assert.deepEqual(await q('select public.ratings_operations_claim()'),[]);await owner();
 });
 await test('resolved alert conditions reset and can immediately alert on recurrence',async()=>{
  await db.exec("update cron.job set schedule='17 * * * *' where jobname='ratings-v1-reminders'");
  await q('select public.ratings_operations_claim()');
  assert.equal(await q("select active from app_security.rating_operations_alerts where code='schedule_drift'"),false);
  await db.exec("update cron.job set schedule='* * * * *' where jobname='ratings-v1-reminders'");
  assert((await q('select public.ratings_operations_claim()')).some(c=>c.code==='schedule_drift'));
 });
 await test('publication failure rolls back review, event and closure; next run recovers idempotently',async()=>{
  const t=await q("insert into public.rating_trades(state,sold_at,deadline) values('pending_selection',statement_timestamp()-interval '15 days',statement_timestamp()-interval '1 day') returning id");
  const review=await q("insert into public.rating_reviews(trade_id,reviewer_role,communication,payment_item,meetup) values($1,'seller',4,4,4) returning id",[t]);
  await db.exec(`create function public.ratings_fail_publication() returns trigger language plpgsql as $$begin raise exception 'publication fixture fault';end$$;
   create trigger ratings_fail_publication before update of closed_at on public.rating_trades for each row when (old.id='${t}'::uuid) execute function public.ratings_fail_publication()`);
  await assert.rejects(()=>q('select app_security.publish_due_reviews()'),/publication fixture fault/);
  assert.equal(await q('select published_at from public.rating_reviews where id=$1',[review]),null);
  assert.equal(await q('select closed_at from public.rating_trades where id=$1',[t]),null);
  assert.equal(await q("select count(*)::int from public.trade_system_events where trade_id=$1 and kind='expired'",[t]),0);
  await db.exec('drop trigger ratings_fail_publication on public.rating_trades');
  assert((await q('select app_security.publish_due_reviews()'))>0);
  assert.notEqual(await q('select published_at from public.rating_reviews where id=$1',[review]),null);
  assert.equal(await q('select app_security.publish_due_reviews()'),0);
 });
 await test('notification insertion failure rolls back receipt and retry persists once',async()=>{
  await db.exec("create function public.ratings_fail_notification() returns trigger language plpgsql as $$begin raise exception 'fixture fault';end$$;create trigger ratings_fail before insert on public.notifications for each row execute function public.ratings_fail_notification()");
  const t=await q("insert into public.rating_trades(seller_id,buyer_id,state) values($1,$2,'pending_buyer') returning id",[seller,buyer]);
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1',[t]),0);
  await db.exec('drop trigger ratings_fail on public.notifications;select app_security.rating_reminders();select app_security.rating_reminders()');
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1 and notification_id is not null',[t]),2);
  await db.exec('update app_security.ratings_settings set enabled=false,jobs_enabled=false,public_reads=false,staff_enabled=false;update cron.job set active=false');
 });
 await test('wrong-recipient notification writes roll back and normal reminder replay recovers',async()=>{
  await db.exec('update app_security.ratings_settings set enabled=true,jobs_enabled=true');
  await db.exec(`create function public.ratings_wrong_recipient() returns trigger language plpgsql as $$begin new.user_id='${seller}'::uuid;return new;end$$;
   create trigger ratings_wrong_recipient before insert on public.notifications for each row execute function public.ratings_wrong_recipient()`);
  const t=await q("insert into public.rating_trades(seller_id,buyer_id,state) values($1,$2,'pending_buyer') returning id",[seller,buyer]);
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1',[t]),0);
  await db.exec('drop trigger ratings_wrong_recipient on public.notifications;select app_security.rating_reminders();select app_security.rating_reminders()');
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts r join public.notifications n on n.id=r.notification_id and n.user_id=r.user_id where r.trade_id=$1',[t]),2);
  await db.query("update public.notifications set user_id=$1 where id=(select notification_id from app_security.rating_notification_receipts where trade_id=$2 and user_id=$3)",[seller,t,buyer]);
  assert((await codes()).includes('notification_missing'));
  await db.exec('update app_security.ratings_settings set enabled=false,jobs_enabled=false,public_reads=false,staff_enabled=false;update cron.job set active=false');
 });
}
