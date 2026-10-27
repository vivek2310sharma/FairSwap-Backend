import './offline-guard.mjs';
const nativePort=process.argv.find(x=>x.startsWith('--native-port='))?.split('=')[1];
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {consumerContractChecks} from './consumer-contract.mjs';
import {launchReadinessChecks} from './launch-readiness.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>readFileSync(root+p,'utf8');
// Load only the selected engine: native adapter path validation is platform-specific.
const db=nativePort===undefined
 ?new (await import('@electric-sql/pglite')).PGlite()
 :new (await import('./native-adapter.mjs')).NativeDatabase(nativePort);
let checks=0;
const q=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
const test=async(name,fn)=>{await fn();console.log(`ok ${++checks} - ${name}`);};
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const seller=id(1),buyer=id(2),outsider=id(3),staff=id(4);
const actor=async(u,aal='aal1')=>{await db.query(`select set_config('request.user',$1,false),set_config('request.aal',$2,false)`,[u??'',aal]);};
const owner=()=>db.exec('reset role; set role postgres');
const client=async u=>{await owner();await actor(u);await db.exec('set role authenticated');};
const rejects=(sql,args=[],pattern)=>assert.rejects(()=>db.query(sql,args),pattern);
let seq=100;
async function listing({legacy=false}={}) {
 await owner();await actor(seller);
 const l=id(++seq),c=id(++seq);
 await db.query(`insert into public.listings(id,seller_id,category_id,city_id,title) select $1,$2,(select id from public.categories limit 1),(select id from public.cities limit 1),'Test item'`,[l,seller]);
 await db.query(`update public.listings set status='active' where id=$1`,[l]);
 await db.query(`insert into public.conversations(id,listing_id,buyer_id,seller_id) values($1,$2,$3,$4)`,[c,l,buyer,seller]);
 if(legacy)await q(`select public.seller_transition_listing($1,'mark_sold')`,[l]);
 return {l,c};
}
async function selected(){const a=await listing();await client(seller);return {...a,...await q(`select public.ratings_sell($1,'select',$2)`,[a.l,a.c])};}
const submit=(t,a=4,b=4,c=4,body=null,tags=[])=>q(`select public.ratings_submit($1,$2,$3,$4,$5,$6)`,[t,a,b,c,body,tags]);
const confirm=async t=>{await client(buyer);await q(`select public.ratings_buyer_action($1,'confirm')`,[t]);};
const summary=u=>q(`select public.ratings_summary($1)`,[u]);
const page=kind=>q(`select public.ratings_${kind}()`);
const expire=async t=>{await owner();await db.query(`update public.rating_trades set sold_at=statement_timestamp()-interval '15 days',deadline=statement_timestamp()-interval '1 day' where id=$1`,[t]);};
try {
 let bootstrap=read('tests/ratings/bootstrap.sql');
 if(nativePort)bootstrap=bootstrap.replace('create role ratings_fixture_admin superuser login;','').replace('alter role postgres rename to pglite_bootstrap;','');
 await db.exec(bootstrap);
 // Real canonical tables, RLS, grants and RPC bodies. Storage and Realtime
 // services are absent in this engine; omit only storage migration/publication.
 const files=readdirSync(root+'supabase/migrations').filter(f=>/^202609140000(0[1-9]|1[0-4])_/.test(f)&&!f.startsWith('20260914000007')).sort();
 for(const f of files) await db.exec(read('supabase/migrations/'+f).replace(/^ALTER PUBLICATION .*;$/gm,''));
 // Preserve latest sold RPC's existing legal-policy boundary without importing
 // unrelated release/category infrastructure; the policy provider is a fixture.
 await db.exec(`create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql as $$select coalesce(current_setting('test.policy',true),'true')<>'false'$$`);
 const latest=read('supabase/migrations/20260918000021_policy_reacceptance_records.sql');
 const transition=latest.match(/CREATE OR REPLACE FUNCTION app_security.impl_seller_transition_listing\([\s\S]*?\$\$;/)[0];
 await db.exec(transition);
 for(const u of [seller,buyer,outsider,staff]) await db.query(`insert into auth.users(id,email) values($1,'member@example.invalid')`,[u]);
 await db.query(`insert into public.staff_roles(user_id,role) values($1,'moderator')`,[staff]);
 const old=await listing({legacy:true});
 if(nativePort)for(const [env,ref] of [['staging','wpppxlnbzqynvhpeuavd'],['production','kriuhwppxgxsyyrbjsau']]){
  await db.exec('delete from vault.decrypted_secrets');await db.query(`insert into vault.decrypted_secrets values('project_url',$1)`,['https://'+ref+'.supabase.co']);
  await db.exec(read('releases/candidates/ratings-v1/'+env+'.preflight.sql'));
 }
 for(const f of readdirSync(root+'supabase/forward-migrations/ratings').filter(f=>/^\d{14}_.+\.sql$/.test(f)).sort()) {
  if(nativePort&&f.endsWith('_ratings_consumer_contract.sql')) {
   for(const [env,ref] of [['staging','wpppxlnbzqynvhpeuavd'],['production','kriuhwppxgxsyyrbjsau']]){
    await db.exec('delete from vault.decrypted_secrets');await db.query("insert into vault.decrypted_secrets values('project_url','https://wrong.invalid')");
    await assert.rejects(()=>db.exec(read('releases/candidates/ratings-v1-contract-fix/'+env+'.preflight.sql')),/RATINGS_ENVIRONMENT_MISMATCH/);
    await db.exec('delete from vault.decrypted_secrets');await db.query('insert into vault.decrypted_secrets values(\'project_url\',$1)',['https://'+ref+'.supabase.co']);
    await db.exec(read('releases/candidates/ratings-v1-contract-fix/'+env+'.preflight.sql'));
   }
   console.log('PASS separate contract-fix environment preflights and wrong-project rejection');
  }
  await db.exec(read('supabase/forward-migrations/ratings/'+f));
 }
 const version=await q('select version()');console.log('Engine: '+version);
 if(nativePort)assert.match(version,/PostgreSQL 17\./);
 await test('all activation flags default off and scheduler does nothing',async()=>{
  assert.equal(await q(`select count(*)::int from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled`),0);
  assert.equal(await q('select app_security.publish_due_reviews()'),0);
  await client(seller);await rejects(`select public.ratings_pending()`,[],/RATINGS_DISABLED/);
 });
 await owner();
 await test('zero existing baseline; no historical sold backfill',async()=>{
  assert.equal(await q('select count(*)::int from public.rating_trades'),0);
  const rows=(await db.query('select * from public.profile_rating_stats')).rows;assert.equal(rows.length,4);
  for(const s of rows){assert.equal(s.published_review_count,0);assert.equal(s.counted_review_count,0);assert.equal(s.completed_trades,0);assert.equal(s.score,null);assert.equal(s.communication_average,null);}
 });
 await test('cron provisioning remains inactive on retries',async()=>{await db.exec('select app_security.ratings_provision_inactive_jobs(); select app_security.ratings_provision_inactive_jobs()');assert.equal(await q('select count(*)::int from cron.job where active'),0);assert.equal(await q('select count(*)::int from cron.job'),2);});
 if(nativePort)await test('separate release scripts reject wrong project and provision only inactive jobs',async()=>{
  for(const [env,ref] of [['staging','wpppxlnbzqynvhpeuavd'],['production','kriuhwppxgxsyyrbjsau']]){
   await db.exec('delete from vault.decrypted_secrets');await db.query(`insert into vault.decrypted_secrets values('project_url','https://wrong.invalid')`);
   await assert.rejects(()=>db.exec(read('releases/candidates/ratings-v1/'+env+'.inactive.sql')),/RATINGS_ENVIRONMENT_MISMATCH/);
   await db.exec('delete from vault.decrypted_secrets');await db.query(`insert into vault.decrypted_secrets values('project_url',$1)`,['https://'+ref+'.supabase.co']);
   await db.exec(read('releases/candidates/ratings-v1/'+env+'.inactive.sql'));
  }
  assert.equal(await q('select count(*)::int from cron.job where active'),0);
 });
 await db.exec('update app_security.ratings_settings set enabled=true,public_reads=true,jobs_enabled=true');
 await test('legacy sold listings cannot acquire invented trades',async()=>{await client(seller);await rejects(`select public.ratings_sell($1)`,[old.l],/RATINGS_LEGACY_SOLD/);});
 await test('new accounts receive zero baseline without phone/email gates',async()=>{await owner();await db.query(`insert into auth.users(id,email,raw_user_meta_data) values($1,null,'{"display_name":"Member"}')`,[id(9)]);assert.equal((await summary(id(9))).score,null);});
 const pending=await listing({legacy:true});
 await test('legacy mark_sold preserves response and creates pending selection only',async()=>{assert.equal(await q(`select state from public.rating_trades where listing_id=$1`,[pending.l]),'pending_selection');assert.equal((await summary(seller)).completed_trades,0);});
 const a=await selected();
 await test('valid buyer comes only from listing conversation and sell retries are idempotent',async()=>{await client(seller);assert.equal((await q(`select public.ratings_sell($1,'select',$2)`,[a.l,a.c])).trade_id,a.trade_id);assert.equal((await q(`select public.ratings_buyer_candidates($1)`,[a.l])).items.length,1);});
 await test('arbitrary buyer, wrong-listing conversation, self and outsider denied atomically',async()=>{
  const b=await listing();await client(seller);
  await rejects(`select public.ratings_sell($1,'select',$2)`,[b.l,id(999)],/RATINGS_INVALID_BUYER/);
  await rejects(`select public.ratings_sell($1,'select',$2)`,[b.l,a.c],/RATINGS_INVALID_BUYER/);
  await owner();assert.equal(await q(`select status from public.listings where id=$1`,[b.l]),'active');
  await db.query(`update public.conversations set buyer_id=$1 where id=$2`,[outsider,b.c]);
  // Self-selection must also fail even if an old/corrupt conversation exists.
  await db.exec('alter table public.conversations drop constraint chk_conversation_distinct_participants');
  await db.query(`update public.conversations set buyer_id=$1 where id=$2`,[seller,b.c]);
  await client(seller);await rejects(`select public.ratings_sell($1,'select',$2)`,[b.l,b.c],/RATINGS_INVALID_BUYER/);
  await client(outsider);await rejects(`select public.ratings_sell($1)`,[b.l],/RATINGS_ACCESS_DENIED/);
 });
 await test('none choice closes unattributed without ratings',async()=>{const b=await listing();await client(seller);const t=await q(`select public.ratings_sell($1,'none')`,[b.l]);assert.equal(t.state,'unattributed');await rejects(`select public.ratings_submit($1,4,4,4)`,[t.trade_id],/RATINGS_TRADE_FROZEN/);});
 await test('existing policy acceptance gate survives additive sold integration',async()=>{const b=await listing();await client(seller);await db.exec(`select set_config('test.policy','false',false)`);await rejects(`select public.ratings_sell($1)`,[b.l],/POLICY_ACCEPTANCE_REQUIRED/);await db.exec(`select set_config('test.policy','true',false)`);});
 await test('buyer must explicitly confirm before review',async()=>{await client(buyer);await rejects(`select public.ratings_submit($1,4,4,4)`,[a.trade_id],/RATINGS_CONFIRM_FIRST/);});
 let sellerReview;
 await client(seller);sellerReview=await submit(a.trade_id,3,3,4,'Good exchange',['polite']);
 await test('database score formula and private sealed author submission',async()=>{const given=await page('given');assert.equal(given.items[0].score,7.8);assert.equal(given.items[0].published_at,null);assert.equal((await q(`select public.ratings_public_reviews($1)`,[buyer])).items.length,0);});
 await test('sealed counterpart is absent from Received, export and public projections',async()=>{
  await client(buyer);assert.equal((await page('received')).items.length,0);
  const req=await q(`insert into public.privacy_requests(user_id,request_type) values($1,'export_data') returning id`,[buyer]);
  const exp=await q(`select public.admin_fulfill_data_export($1)`,[req]);assert.deepEqual(exp.ratings.received,[]);
 });
 await test('confirmed trade counts with zero buyer reviews; repeat confirmation stable',async()=>{await confirm(a.trade_id);await confirm(a.trade_id);assert.equal((await summary(seller)).completed_trades,1);assert.equal((await summary(seller)).counted_review_count,0);});
 let buyerReview;
 await client(buyer);buyerReview=await submit(a.trade_id,1,1,1,'Plain text',['item_as_described']);
 await test('reciprocal submissions publish early and true 0.0 survives threshold masking',async()=>{assert.equal((await page('received')).items[0].id,sellerReview);assert.equal((await summary(seller)).score,null);assert.equal((await summary(seller)).counted_review_count,1);await owner();assert.equal(Number(await q('select score from public.rating_reviews where id=$1',[buyerReview])),0);});
 await test('duplicate submission exact replay returns same id, changed review rejected',async()=>{await client(buyer);assert.equal(await submit(a.trade_id,1,1,1,'Plain text',['item_as_described']),buyerReview);await rejects(`select public.ratings_submit($1,4,4,4)`,[a.trade_id],/RATINGS_REVIEW_IMMUTABLE/);});
 if(nativePort)await test('independent native sessions serialize concurrent sell, confirm and duplicate review requests',async()=>{
  const b=await listing();await client(seller);
  const results=await Promise.all([db.query(`select public.ratings_sell($1,'select',$2)`,[b.l,b.c],true),db.query(`select public.ratings_sell($1,'select',$2)`,[b.l,b.c],true)]);
  const trade=Object.values(results[0].rows[0])[0].trade_id;
  assert.equal(trade,Object.values(results[1].rows[0])[0].trade_id);
  await client(buyer);await Promise.all([db.query(`select public.ratings_buyer_action($1,'confirm')`,[trade],true),db.query(`select public.ratings_buyer_action($1,'confirm')`,[trade],true)]);
  const reviews=await Promise.all([db.query(`select public.ratings_submit($1,4,4,4)`,[trade],true),db.query(`select public.ratings_submit($1,4,4,4)`,[trade],true)]);
  assert.equal(Object.values(reviews[0].rows[0])[0],Object.values(reviews[1].rows[0])[0]);
  await owner();assert.equal(await q(`select count(*)::int from public.rating_trades where listing_id=$1`,[b.l]),1);
  // Keep subsequent aggregate fixtures independent of this concurrency scenario.
  await db.query('update public.rating_trades set voided=true where id=$1',[trade]);await db.query('select app_security.rating_recompute(array[$1,$2]::uuid[])',[seller,buyer]);
 });
 await test('required integer faces, role vocabulary, max/duplicate tags, Unicode and HTML validation',async()=>{
  const b=await selected();await client(seller);
  for(const sql of [`select public.ratings_submit($1,null,4,4)`,`select public.ratings_submit($1,0,4,4)`,`select public.ratings_submit($1,5,4,4)`,`select public.ratings_submit($1,4,4,4,'<script>')`,`select public.ratings_submit($1,4,4,4,repeat('अ',501))`,`select public.ratings_submit($1,4,4,4,null,array['polite','polite'])`,`select public.ratings_submit($1,4,4,4,null,array['item_as_described'])`,`select public.ratings_submit($1,4,4,4,null,array['unknown'])`,`select public.ratings_submit($1,4,4,4,null,array[null]::text[])`])await rejects(sql,[b.trade_id]);
  const r=await submit(b.trade_id,4,4,4,'e\u0301 😀');await owner();assert.equal(await q('select body from public.rating_reviews where id=$1',[r]),'é 😀');
 });
 await test('reply requires written published review and remains immutable',async()=>{await client(seller);await q(`select public.ratings_reply($1,'Thank you')`,[buyerReview]);await q(`select public.ratings_reply($1,'Thank you')`,[buyerReview]);await rejects(`select public.ratings_reply($1,'Changed')`,[buyerReview],/RATINGS_REPLY_IMMUTABLE/);await client(outsider);await rejects(`select public.ratings_reply($1,'Forged')`,[buyerReview],/RATINGS_ACCESS_DENIED/);});
 await test('reply rejects sealed or unwritten review, and inactive accounts cannot mutate',async()=>{
  const b=await selected();const r=await submit(b.trade_id,4,4,4,'Sealed');await client(buyer);
  await rejects(`select public.ratings_reply($1,'Premature')`,[r],/RATINGS_ACCESS_DENIED/);
  await confirm(b.trade_id);const blank=await submit(b.trade_id);await client(seller);
  await rejects(`select public.ratings_reply($1,'No written text')`,[blank],/RATINGS_ACCESS_DENIED/);
  await owner();await db.query(`update public.user_accounts set account_status='suspended' where user_id=$1`,[outsider]);await client(outsider);await rejects('select public.ratings_pending()',[],/RATINGS_ACCESS_DENIED/);
  await owner();await db.query(`update public.user_accounts set account_status='active' where user_id=$1`,[outsider]);
  await db.query('update public.rating_trades set voided=true where id=$1',[b.trade_id]);await db.query('select app_security.rating_recompute(array[$1,$2]::uuid[])',[seller,buyer]);
 });
 const unconfirmed=await selected();await client(seller);const one=await submit(unconfirmed.trade_id,4,4,4,'Seller only');await expire(unconfirmed.trade_id);
 await test('expiry publishes seller-only review without inflating reputation or trades',async()=>{await db.exec('select app_security.publish_due_reviews();select app_security.publish_due_reviews()');await client(buyer);assert((await page('received')).items.some(r=>r.id===one));assert.equal((await summary(buyer)).counted_review_count,1);assert.equal((await summary(buyer)).completed_trades,1);assert(!(await page('pending')).items.some(r=>r.id===unconfirmed.trade_id));await rejects(`select public.ratings_buyer_action($1,'confirm')`,[unconfirmed.trade_id],/RATINGS_WINDOW_CLOSED/);await client(seller);await rejects(`select public.ratings_submit($1,4,4,4)`,[unconfirmed.trade_id],/RATINGS_WINDOW_CLOSED/);});
 await test('same pair counts across distinct listings without cooldown and score reaches 0.0',async()=>{
  for(let i=0;i<2;i++){const b=await selected();await submit(b.trade_id,4,4,4);await confirm(b.trade_id);await submit(b.trade_id,1,1,1);}
  const s=await summary(seller);assert.equal(s.completed_trades,3);assert.equal(s.counted_review_count,3);assert.equal(s.score,0);assert.equal(s.display_state,'rated');assert.equal(s.communication_average,1);
 });
 let disputed,disputeCase;
 await test('buyer dispute freezes trade, removes aggregates and creates support evidence',async()=>{disputed=await selected();await confirm(disputed.trade_id);await client(seller);await submit(disputed.trade_id);await client(buyer);await q(`select public.ratings_buyer_action($1,'dispute')`,[disputed.trade_id]);await q(`select public.ratings_buyer_action($1,'dispute')`,[disputed.trade_id]);await rejects(`select public.ratings_submit($1,4,4,4)`,[disputed.trade_id],/RATINGS_TRADE_FROZEN/);assert.equal((await summary(seller)).completed_trades,3);await owner();disputeCase=await q(`select id from app_security.rating_cases where trade_id=$1`,[disputed.trade_id]);assert(disputeCase);assert.equal(await q(`select count(*)::int from app_security.rating_cases where trade_id=$1`,[disputed.trade_id]),1);});
 let reportCase;
 await test('review reporting is durable, deduplicated, and linked to support case',async()=>{await client(outsider);reportCase=await q(`select public.ratings_report($1,'Review needs investigation')`,[buyerReview]);assert.equal(await q(`select public.ratings_report($1,'Retry report')`,[buyerReview]),reportCase);});
 await test('staff requires AAL2, role, enabled flag and audited explicit reason',async()=>{
  await client(staff);await rejects(`select public.admin_ratings_case($1,'evidence','Investigation')`,[reportCase],/RATINGS_ACCESS_DENIED/);
  await actor(staff,'aal2');await rejects(`select public.admin_ratings_case($1,'evidence','Investigation')`,[reportCase],/RATINGS_STAFF_DISABLED/);
  await owner();await db.exec('update app_security.ratings_settings set staff_enabled=true');await client(staff);await actor(staff,'aal2');
  await rejects(`select public.admin_ratings_case($1,'hide','')`,[reportCase],/RATINGS_REASON_REQUIRED/);
  assert((await q(`select public.admin_ratings_case($1,'evidence','Investigating case')`,[reportCase])).reviews.length===2);
 });
 await test('hide/restore recalculates counts, including threshold loss and recovery',async()=>{await q(`select public.admin_ratings_case($1,'hide','Policy violation')`,[reportCase]);assert.equal((await summary(seller)).score,null);assert.equal((await summary(seller)).counted_review_count,2);await q(`select public.admin_ratings_case($1,'restore','Appeal accepted')`,[reportCase]);assert.equal((await summary(seller)).score,0);});
 await test('resolution and void recompute trade counts with immutable audit',async()=>{await q(`select public.admin_ratings_case($1,'resolve','Evidence reviewed')`,[disputeCase]);assert.equal((await summary(seller)).completed_trades,4);await q(`select public.admin_ratings_case($1,'void','Trade invalidated')`,[disputeCase]);assert.equal((await summary(seller)).completed_trades,3);await owner();assert.equal(await q('select count(*)::int from app_security.rating_moderation_audit'),5);});
 await test('risk exclusion affects score and completed counts but reveals no internal flags',async()=>{await client(staff);await actor(staff,'aal2');await q(`select public.admin_ratings_case($1,'exclude','Signals reviewed')`,[reportCase]);assert.equal((await summary(seller)).counted_review_count,2);const dto=(await q(`select public.ratings_public_reviews($1)`,[seller])).items;assert(!JSON.stringify(dto).includes('risk_excluded'));await q(`select public.admin_ratings_case($1,'clear_exclusion','Independent evidence')`,[reportCase]);});
 await test('outsider reads/writes and forged system events are denied by grants/RLS',async()=>{
  await client(outsider);await rejects(`select public.ratings_trade($1)`,[a.trade_id],/RATINGS_ACCESS_DENIED/);await rejects(`select public.ratings_events($1)`,[a.trade_id],/RATINGS_ACCESS_DENIED/);
  for(const table of ['rating_trades','rating_reviews','rating_replies','profile_rating_stats','trade_system_events','app_security.rating_cases']){const target=table.includes('.')?table:'public.'+table;await rejects(`select * from ${target}`);await rejects(`delete from ${target}`);}
  await rejects(`insert into public.trade_system_events(trade_id,kind) values($1,'confirmed')`,[a.trade_id]);await rejects('select app_security.publish_due_reviews()');await rejects('select app_security.rating_recompute(array[]::uuid[])');
  await rejects(`update public.rating_reviews set body='edited' where id=$1`,[buyerReview]);
  await rejects(`insert into public.rating_reviews(trade_id,communication,payment_item,meetup,reviewer_role) values($1,4,4,4,'buyer')`,[a.trade_id]);
  await rejects(`update app_security.rating_moderation_audit set reason='changed'`);
 });
 await test('initial and day3/day10 reminders deduplicate; completed actions are excluded',async()=>{
  const b=await selected();await owner();
  for(const days of [3,10]){await db.query(`update public.rating_trades set sold_at=statement_timestamp()-make_interval(days=>$2),deadline=statement_timestamp()+make_interval(days=>14-$2) where id=$1`,[b.trade_id,days]);await db.exec('select app_security.rating_reminders();select app_security.rating_reminders()');}
  assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1',[b.trade_id]),6);
  await db.exec('select app_security.rating_reminders()');assert.equal(await q('select count(*)::int from app_security.rating_notification_receipts where trade_id=$1',[b.trade_id]),6);
  assert.equal(await q(`select count(*)::int from app_security.rating_notification_receipts where trade_id=$1 and kind in ('day3','day10')`,[a.trade_id]),0);
 });
 await test('cursor pagination uses stable timestamp/UUID boundary and rejects partial cursor',async()=>{
  await owner();await actor(seller);for(let i=0;i<24;i++)await listing({legacy:true});await client(seller);
  const p=await page('pending');assert.equal(p.items.length,20);assert.equal(p.has_more,true);const next=await q('select public.ratings_pending($1,$2)',[p.next_cursor.before_at,p.next_cursor.before_id]);assert(!next.items.some(x=>p.items.some(y=>y.id===x.id)));
  await rejects('select public.ratings_pending(now(),null)',[],/RATINGS_INVALID_CURSOR/);
 });
 await test('anonymous public APIs expose published visible content only',async()=>{await owner();await actor(null);await db.exec('set role anon');assert((await summary(seller)).counted_review_count===3);assert((await q('select public.ratings_public_reviews($1)',[seller])).items.length===3);await rejects('select public.ratings_pending()');});
 await test('privacy wrapper retains original authorization and does not grant base access',async()=>{await client(outsider);await rejects('select app_security.ratings_export_base($1)',[id(999)]);await rejects('select public.admin_fulfill_data_export($1)',[id(999)]);});
 await consumerContractChecks(db,test);
 await test('account deletion erases text and removes reputation; physical deletion is FK safe',async()=>{await owner();await db.query(`update public.user_accounts set account_status='deletion_pending' where user_id=$1`,[buyer]);assert.equal((await summary(seller)).counted_review_count,0);assert.equal((await summary(seller)).completed_trades,0);assert.equal(await q(`select count(*)::int from public.rating_reviews where body is not null`),0);assert.equal(await q(`select count(*)::int from public.rating_replies where body<>'[redacted]'`),0);await db.query('delete from auth.users where id=$1',[buyer]);});
 await owner();await db.exec(read('supabase/forward-migrations/ratings/tests/security.sql'));
 await test('catalog security assertions pass',async()=>{});
 await launchReadinessChecks(db,test,read('releases/candidates/ratings-v1/rollback-disable.sql'));
 console.log(`PASS ${checks} automated database checks; no hosted or external network operations`);
} catch(e) {console.error('FAIL',e.message,e.code??'',e.where??'');process.exitCode=1;} finally {await db.close();}
