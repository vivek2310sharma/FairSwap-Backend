import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Only called by run.mjs inside its fresh disposable database. Auth/JWT and cron
// remain fixtures: these checks prove SQL authorization, not token verification.
export async function launchReadinessChecks(db, test, rollback) {
 const q=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
 const owner=()=>db.exec('reset role; set role postgres');
 const login=async(user,aal='aal1',role='authenticated')=>{
  await owner();await db.query("select set_config('request.user',$1,false),set_config('request.aal',$2,false)",[user??'',aal]);
  await db.exec(`set role ${role}`);
 };
 const denied=(sql,args=[],pattern=/permission denied|RATINGS_ACCESS_DENIED/)=>assert.rejects(()=>q(sql,args),pattern);
 const [seller,buyer,other,staff]=Array.from({length:4},()=>randomUUID());
 await owner();
 for(const u of [seller,buyer,other,staff])await db.query(`insert into auth.users(id,raw_user_meta_data) values($1,'{"display_name":"Launch fixture"}')`,[u]);
 await db.query("insert into public.staff_roles(user_id,role) values($1,'moderator')",[staff]);
 const trade=async(days=0)=>{
  await owner();return q(`insert into public.rating_trades(seller_id,buyer_id,state,sold_at,deadline)
   values($1,$2,'pending_buyer',statement_timestamp()-make_interval(days=>$3),
   statement_timestamp()+make_interval(days=>14-$3)) returning id`,[seller,buyer,days]);
 };
 const t=await trade();
 await test('launch identity matrix rejects missing identity and unrelated AAL2 callers',async()=>{
  for(const [u,role] of [[null,'anon'],[null,'authenticated'],[other,'authenticated']]){
   await login(u,'aal2',role);
   await denied('select public.ratings_trade($1)',[t]);
   await denied("select public.ratings_buyer_action($1,'confirm')",[t]);
   await denied('select public.ratings_submit($1,4,4,4)',[t]);
  }
  await login(seller);await denied("select public.ratings_buyer_action($1,'confirm')",[t]);
  await login(buyer);assert.equal((await q("select public.ratings_buyer_action($1,'confirm')",[t])).state,'confirmed');
 });
 await test('launch direct DML and private evidence are denied even to AAL2 staff',async()=>{
  for(const user of [seller,buyer,other,staff]){
   await login(user,'aal2');
   for(const table of ['public.rating_reviews','public.rating_trades','app_security.rating_moderation_audit','app_security.rating_notification_receipts']){
    await denied(`select * from ${table}`);await denied(`delete from ${table}`);
    await denied(`insert into ${table} default values`);await denied(`update ${table} set ${table.endsWith('receipts')?'kind=kind':'id=id'}`);
   }
   await denied('select app_security.rating_reminders()');
  }
 });
 await test('launch deadline invariant is exactly 14 days and actions close at deadline',async()=>{
  await owner();assert.equal(await q("select bool_and(deadline=sold_at+interval '14 days') from public.rating_trades"),true);
  const due=await trade(14);
  await login(buyer);
  for(const action of ['confirm','dispute'])await denied('select public.ratings_buyer_action($1,$2)',[due,action],/RATINGS_WINDOW_CLOSED/);
  await login(seller);await denied('select public.ratings_submit($1,4,4,4)',[due],/RATINGS_WINDOW_CLOSED/);
 });
 await test('launch generated database score covers all 64 face combinations',async()=>{
  await owner();
  await db.exec(`do $$ declare a int;b int;c int;t uuid;s numeric;begin
   for a in 1..4 loop for b in 1..4 loop for c in 1..4 loop
    insert into public.rating_trades(state) values('pending_selection') returning id into t;
    insert into public.rating_reviews(trade_id,reviewer_role,communication,payment_item,meetup)
     values(t,'seller',a,b,c) returning score into s;
    if s<>round((a+b+c-3)*10/9.0,1) or s<0 or s>10 then raise exception 'SCORE_MISMATCH';end if;
   end loop;end loop;end loop;end $$`);
 });
 await test('launch publication drains over 200 due trades and is idempotent',async()=>{
  await owner();await db.exec('select app_security.publish_due_reviews()');
  await db.exec(`insert into public.rating_trades(state,sold_at,deadline)
   select 'pending_selection',statement_timestamp()-interval '15 days',statement_timestamp()-interval '1 day' from generate_series(1,205)`);
  assert.equal(await q('select app_security.publish_due_reviews()'),200);
  assert.equal(await q('select app_security.publish_due_reviews()'),5);
  assert.equal(await q('select app_security.publish_due_reviews()'),0);
  assert.equal(await q('select count(*)::int from public.rating_trades where deadline<=clock_timestamp() and closed_at is null'),0);
 });
 await test('launch reminder cursor reaches beyond batch and skips stale day3 reminders',async()=>{
  await owner();await db.exec('update app_security.rating_reminder_cursor set last_sold_at=null,last_id=null');
  // Disable notification generation while constructing a delayed backlog.
  await db.exec('update app_security.ratings_settings set jobs_enabled=false');
  const ids=(await db.query(`insert into public.rating_trades(seller_id,buyer_id,state,sold_at,deadline)
   select $1,$2,'pending_buyer',statement_timestamp()-interval '11 days',statement_timestamp()+interval '3 days'
   from generate_series(1,205) returning id`,[seller,buyer])).rows.map(x=>x.id);
  await db.exec('update app_security.ratings_settings set jobs_enabled=true');
  for(let i=0;i<4;i++)await q('select app_security.rating_reminders()');
  const counts=await q(`select json_build_object('day10',count(*) filter(where kind='day10'),'day3',count(*) filter(where kind='day3'))
   from app_security.rating_notification_receipts where trade_id=any($1::uuid[])`,[ids]);
  assert.deepEqual(counts,{day10:410,day3:0});
  await q('select app_security.rating_reminders()');
  assert.equal(await q("select count(*)::int from app_security.rating_notification_receipts where trade_id=any($1::uuid[]) and kind='day10'",[ids]),410);
 });
 await test('launch notification failure rolls back receipts and retry delivers exactly once',async()=>{
  await owner();await db.exec('update app_security.ratings_settings set jobs_enabled=false');
  const retry=await trade(4);
  await db.exec('update app_security.ratings_settings set jobs_enabled=true');
  const before=await q('select count(*)::int from public.notifications');
  await db.exec(`create function public.launch_notification_failure() returns trigger language plpgsql as $$
   begin raise exception 'LAUNCH_NOTIFICATION_FAILURE'; end $$;
   create trigger launch_notification_failure before insert on public.notifications
   for each row execute function public.launch_notification_failure()`);
  try {
   await denied('select app_security.rating_notify($1)',[retry],/LAUNCH_NOTIFICATION_FAILURE/);
   assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1',[retry]),0);
   assert.equal(await q('select count(*)::int from public.notifications'),before);
  } finally {
   await db.exec('drop trigger launch_notification_failure on public.notifications; drop function public.launch_notification_failure()');
  }
  await q('select app_security.rating_notify($1)',[retry]);
  await q('select app_security.rating_notify($1)',[retry]);
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1',[retry]),4);
  assert.equal(await q('select count(*)::int from public.notifications'),before+4);
 });
 await test('launch aggregate monitoring executes in a read-only transaction',async()=>{
  await owner();
  // pg_cron is a fixture here; never claim real scheduler delivery from this run.
  await db.exec(`create table if not exists cron.job_run_details(jobid bigint,status text,start_time timestamptz,end_time timestamptz)`);
  const {readFileSync}=await import('node:fs');
  const monitoring=readFileSync(new URL('./launch-monitoring.sql',import.meta.url),'utf8');
  await db.exec(monitoring);
  assert.equal(await q("select count(*)::int from public.profile_rating_stats where score<0 or score>10 or (counted_review_count<3 and score is not null)"),0);
 });
 await test('launch rollback preserves evidence and unrelated jobs, closes all Ratings gates',async()=>{
  await owner();await db.exec("select cron.schedule('launch-unrelated','0 0 * * *','select 1')");
  const before=await q('select count(*)::int from public.rating_reviews');
  const tables=['public.rating_trades','public.rating_reviews','public.rating_replies',
   'public.trade_system_events','app_security.rating_cases','app_security.rating_moderation_audit',
   'app_security.rating_notification_receipts'];
  const fingerprint=table=>q(`select md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text)::text,'')) from ${table} x`);
  const history=await Promise.all(tables.map(fingerprint));
  await db.exec(rollback);
  await db.exec(rollback);
  assert.equal(await q('select count(*)::int from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled'),0);
  assert.equal(await q("select count(*)::int from cron.job where jobname like 'ratings-v1-%' and active"),0);
  assert.equal(await q("select active from cron.job where jobname='launch-unrelated'"),true);
  assert.equal(await q('select count(*)::int from public.rating_reviews'),before);
  assert.deepEqual(await Promise.all(tables.map(fingerprint)),history,'Rollback changed retained history');
  assert.equal(await q('select app_security.publish_due_reviews()'),0);
  assert.equal(await q('select app_security.rating_reminders()'),0);
  await login(seller);await denied('select public.ratings_pending()',[],/RATINGS_DISABLED/);
 });
}
