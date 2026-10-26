import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {reviewSchema, pageSchema, givenHistoryEntrySchema, ratingCaseQueueSchema, conversationTradeSchema} from '../../src/lib/ratings/contract.ts';

// Automated fixtures only; invoked inside the suite's disposable database.
export async function consumerContractChecks(db, test) {
 const q=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
 const owner=()=>db.exec('reset role; set role postgres');
 const login=async(u,aal='aal1',role='authenticated')=>{await owner();await db.query("select set_config('request.user',$1,false),set_config('request.aal',$2,false)",[u??'',aal]);await db.exec(`set role ${role}`);};
 const denied=(sql,args=[],pattern=/RATINGS_ACCESS_DENIED/)=>assert.rejects(()=>q(sql,args),pattern);
 const [seller,buyer,other,staff,admin]=Array.from({length:5},()=>randomUUID());
 await owner();
 for(const u of [seller,buyer,other,staff,admin]) await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,null,'{\"display_name\":\"Contract member\"}')",[u]);
 await db.query("insert into public.staff_roles(user_id,role) values($1,'moderator'),($2,'administrator')",[staff,admin]);
 const trades=[];
 async function fixture(state='pending_buyer',expired=false){
  await owner();const l=randomUUID(),c=randomUUID(),t=randomUUID();
  await db.query("insert into public.listings(id,seller_id,category_id,city_id,title) select $1,$2,(select id from public.categories limit 1),(select id from public.cities limit 1),'Safe card title'",[l,seller]);
  await db.query("update public.listings set status='active' where id=$1",[l]);
  await db.query('insert into public.conversations(id,listing_id,seller_id,buyer_id) values($1,$2,$3,$4)',[c,l,seller,buyer]);
  await db.query(`insert into public.rating_trades(id,listing_id,seller_id,buyer_id,conversation_id,state,sold_at,deadline,buyer_confirmed_at)
   values($1,$2,$3,$4,$5,$6,statement_timestamp()-make_interval(days=>$7),statement_timestamp()+make_interval(days=>14-$7),case when $6='confirmed' then statement_timestamp() end)`,[t,l,seller,buyer,c,state,expired?15:0]);
  trades.push(t);return {l,c,t};
 }
 const lookup=c=>q('select public.ratings_trade_for_conversation($1)',[c]);
 const history=(cursor=null)=>q('select public.ratings_given_history($1,$2)',[cursor?.before_at??null,cursor?.before_id??null]);
 const queue=(kind='review_report',status='open',cursor=null)=>q('select public.admin_ratings_cases($1,$2,$3,$4)',[kind,status,cursor?.before_at??null,cursor?.before_id??null]);
 const a=await fixture();let review;
 await test('card context carries listing and public identities while preserving sealed boundaries',async()=>{
  await login(seller);review=await q("select public.ratings_submit($1,4,4,4,'Own sealed review',array['sent_payment_link','polite'])",[a.t]);
  const given=await q('select public.ratings_given()');const r=reviewSchema.parse(given.items.find(x=>x.id===review));
  assert.equal(r.context.trade_id,a.t);assert.equal(r.context.listing_id,a.l);assert.equal(r.context.listing_title,'Safe card title');
  assert.equal(r.author_id,seller);assert.equal(r.recipient_id,buyer);assert.equal(r.author_display_name,'Contract member');assert.equal(r.reviewer_role,'seller');assert.deepEqual(r.tags,['polite']);
  await login(buyer);assert(!(await q('select public.ratings_received()')).items.some(x=>x.id===review));
  assert(!(await q('select public.ratings_public_reviews($1)',[buyer])).items.some(x=>x.id===review));
  await owner();await db.query('update public.rating_reviews set published_at=clock_timestamp() where id=$1',[review]);
  await login(buyer);reviewSchema.parse((await q('select public.ratings_received()')).items.find(x=>x.id===review));
  await login(null,'aal1','anon');reviewSchema.parse((await q('select public.ratings_public_reviews($1)',[buyer])).items.find(x=>x.id===review));
 });
 await test('removed/deleted listing and inactive identity never disclose title or profile name',async()=>{
  await owner();await db.query("update public.listings set title='Private removed title',status='removed' where id=$1",[a.l]);
  await db.query("update public.user_accounts set account_status='suspended' where user_id=$1",[seller]);
  await login(buyer);let r=(await q('select public.ratings_received()')).items.find(x=>x.id===review);
  assert.equal(r.context.listing_title,'Listing removed');assert.equal(r.context.listing_id,null);assert.equal(r.author_id,null);assert.equal(r.author_display_name,null);
  assert(!JSON.stringify(r).includes('Private removed title'));
  await owner();await db.query("update public.user_accounts set account_status='active' where user_id=$1",[seller]);
  const deleted=await fixture();await owner();const deletedReview=await q("insert into public.rating_reviews(trade_id,author_id,recipient_id,reviewer_role,communication,payment_item,meetup,published_at) values($1,$2,$3,'seller',4,4,4,clock_timestamp()) returning id",[deleted.t,seller,buyer]);
  await db.query('delete from public.conversations where id=$1',[deleted.c]);await db.query('delete from public.listings where id=$1',[deleted.l]);await login(buyer);
  r=(await q('select public.ratings_received()')).items.find(x=>x.id===deletedReview);assert.equal(r.context.listing_title,'Listing removed');assert.equal(r.context.listing_id,null);
 });
 await test('conversation lookup covers pending, confirmed, rated, disputed and expired without counterpart review',async()=>{
  for(const state of ['pending_buyer','confirmed','disputed','expired_unconfirmed']){
   const f=await fixture(state,state==='expired_unconfirmed');
   for(const u of [seller,buyer]){await login(u);const t=conversationTradeSchema.parse(await lookup(f.c));assert.equal(t.id,f.t);assert.equal(t.state,state);assert(!('reviews' in t));}
  }
  await login(seller);const mine=await lookup(a.c);assert.equal(mine.my_review_id,review);assert.equal(mine.my_rating_status,'submitted');
  await login(buyer);assert.equal((await lookup(a.c)).my_review_id,null);
  const f=await fixture('pending_selection');await owner();await db.query('update public.rating_trades set buyer_id=null,conversation_id=null where id=$1',[f.t]);
  await login(seller);assert.equal((await lookup(f.c)).state,'pending_selection');await login(buyer);assert.equal(await lookup(f.c),null);
 });
 await test('conversation membership and selected buyer block enumeration, absent trade returns null',async()=>{
  const f=await fixture();await owner();await db.query('update public.rating_trades set conversation_id=null where id=$1',[f.t]);
  await login(buyer);assert.equal(await lookup(f.c),null);
  await login(other);await denied('select public.ratings_trade_for_conversation($1)',[a.c]);await denied('select public.ratings_trade_for_conversation($1)',[randomUUID()]);
  await owner();const c=randomUUID();await db.query('insert into public.conversations(id,listing_id,seller_id,buyer_id) values($1,$2,$3,$4)',[c,f.l,seller,other]);
  await login(other);assert.equal(await lookup(c),null);
  await login(null,'aal1','anon');await assert.rejects(()=>lookup(a.c),/permission denied/);
  await login(null,'aal1','service_role');await assert.rejects(()=>lookup(a.c),/permission denied/);
 });
 await test('expired not-rated history derives from deadline before scheduler and never counterpart sealed content',async()=>{
  const f=await fixture('confirmed');await login(seller);await q("select public.ratings_submit($1,4,4,4,'Counterpart secret')",[f.t]);
  await owner();await db.query("update public.rating_trades set sold_at=statement_timestamp()-interval '15 days',deadline=statement_timestamp()-interval '1 day' where id=$1",[f.t]);
  await login(buyer);const p=pageSchema(givenHistoryEntrySchema).parse(await history());const entry=p.items.find(x=>x.id===f.t);
  assert.equal(entry.kind,'not_rated');assert.equal(entry.my_role,'buyer');assert(!JSON.stringify(p).includes('Counterpart secret'));
  await login(seller);const own=pageSchema(givenHistoryEntrySchema).parse(await history());assert(own.items.some(x=>x.kind==='review'&&x.review.context.trade_id===f.t));assert(!own.items.some(x=>x.kind==='not_rated'&&x.id===f.t));
  await login(other);assert.deepEqual((await history()).items,[]);
  await login(buyer);await denied('select public.ratings_given_history(now(),null)',[],/RATINGS_INVALID_CURSOR/);
 });
 await test('history cursor traverses timestamp ties at exactly 20 per page without missing or duplicate rows',async()=>{
  for(let i=0;i<24;i++)await fixture('confirmed',true);
  await owner();await db.query("update public.rating_trades set sold_at='2026-01-01',deadline='2026-01-15' where id=any($1::uuid[])",[trades.filter(x=>x!==a.t)]);
  await login(buyer);let p=pageSchema(givenHistoryEntrySchema).parse(await history());assert.equal(p.items.length,20);assert.equal(p.has_more,true);
  const ids=new Set();while(true){for(const e of p.items){assert(!ids.has(e.id));ids.add(e.id);}if(!p.has_more){assert.equal(p.next_cursor,null);break;}p=pageSchema(givenHistoryEntrySchema).parse(await history(p.next_cursor));}
  assert(ids.size>=24);
 });
 let caseId;
 await test('staff queues require role, active account, AAL2 and staff flag',async()=>{
  await owner();caseId=await q("insert into app_security.rating_cases(trade_id,review_id,reporter_id,kind,reason) values($1,$2,$3,'review_report','Private fraud evidence') returning id",[a.t,review,other]);
  await login(other,'aal2');await denied("select public.admin_ratings_cases('review_report')");
  await login(staff);await denied("select public.admin_ratings_cases('review_report')");
  await owner();await db.exec('update app_security.ratings_settings set staff_enabled=false');await login(staff,'aal2');await denied("select public.admin_ratings_cases('review_report')",[],/RATINGS_STAFF_DISABLED/);
  await owner();await db.exec('update app_security.ratings_settings set staff_enabled=true');await db.query("update public.user_accounts set account_status='suspended' where user_id=$1",[staff]);await login(staff,'aal2');await denied("select public.admin_ratings_cases('review_report')");
  await owner();await db.query("update public.user_accounts set account_status='active' where user_id=$1",[staff]);
 });
 await test('safe queues paginate both case kinds, exclude conflicts and preserve audited evidence',async()=>{
  await owner();for(const kind of ['review_report','dispute'])for(let i=0;i<24;i++)await db.query("insert into app_security.rating_cases(trade_id,kind,reason,created_at) values($1,$2,'Secret evidence','2026-01-01')",[a.t,kind]);
  const auditBefore=await q('select count(*)::int from app_security.rating_moderation_audit');
  await login(staff,'aal2');for(const kind of ['review_report','dispute']){
   let p=pageSchema(ratingCaseQueueSchema).parse(await queue(kind));assert.equal(p.items.length,20);assert(p.has_more);const ids=new Set();
   while(true){for(const x of p.items){assert.equal(x.kind,kind);assert(!ids.has(x.id));ids.add(x.id);assert.deepEqual(Object.keys(x).sort(),['created_at','id','kind','resolved_at','review_id','support_ticket_id','trade_id']);}if(!p.has_more)break;p=pageSchema(ratingCaseQueueSchema).parse(await queue(kind,'open',p.next_cursor));}assert(ids.size>=24);
  }
  await denied("select public.admin_ratings_cases('bad')",[],/RATINGS_INVALID_QUEUE/);await denied("select public.admin_ratings_cases('dispute',null)",[],/RATINGS_INVALID_QUEUE/);await denied("select public.admin_ratings_cases('dispute','open',now(),null)",[],/RATINGS_INVALID_CURSOR/);
  await owner();assert.equal(await q('select count(*)::int from app_security.rating_moderation_audit'),auditBefore);
  await login(staff,'aal2');const evidence=await q("select public.admin_ratings_case($1,'evidence','Contract investigation')",[caseId]);assert.equal(evidence.case.reason,'Private fraud evidence');
  await owner();assert.equal(await q('select count(*)::int from app_security.rating_moderation_audit'),auditBefore+1);
  await db.query('update app_security.rating_cases set resolved_at=clock_timestamp() where id=$1',[caseId]);await login(admin,'aal2');assert((await queue('review_report','resolved')).items.some(x=>x.id===caseId));assert(!(await queue()).items.some(x=>x.id===caseId));
  for(const u of [seller,buyer,other]){await owner();await db.query("insert into public.staff_roles(user_id,role) values($1,'moderator')",[u]);await login(u,'aal2');const p=await queue();assert(!p.items.some(x=>x.id===caseId));}
  await login(null,'aal1','anon');await assert.rejects(()=>queue(),/permission denied/);
 });
 await test('new projection flags fail closed and zero-baseline user remains uninflated',async()=>{
  await owner();await db.exec('update app_security.ratings_settings set enabled=false');await login(buyer);await denied('select public.ratings_given_history()',[],/RATINGS_DISABLED/);await denied('select public.ratings_trade_for_conversation($1)',[a.c],/RATINGS_DISABLED/);
  await owner();await db.exec('update app_security.ratings_settings set enabled=true');
  const s=await q('select public.ratings_summary($1)',[other]);assert.equal(s.score,null);assert.equal(s.counted_review_count,0);assert.equal(s.completed_trades,0);
 });
 await owner();
 // Restore isolation from the original suite's global deletion assertions.
 await db.query('delete from auth.users where id=any($1::uuid[])',[[seller,buyer,other,staff,admin]]);
}
