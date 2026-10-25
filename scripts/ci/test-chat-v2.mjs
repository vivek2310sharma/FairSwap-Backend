// Local, disposable PostgreSQL only. No environment files, credentials or HTTP.
// node scripts/ci/test-chat-v2.mjs <absolute FairSwap-Web checkout with PGlite installed>
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(resolve(process.argv[2]??'../FairSwap-Web','package.json'));
const {PGlite}=require('@electric-sql/pglite');
const db=new PGlite();
let checks=0;
const scalar=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const test=async(label,fn)=>{await fn();console.log(`ok ${++checks} - ${label}`);};
const rejects=(sql,args=[])=>assert.rejects(()=>db.query(sql,args));
const id=(n)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const seller=id(1),buyer=id(2),outsider=id(3),listing=id(4),conversation=id(5);
const actor=(user)=>db.query(`select set_config('request.user',$1,false)`,[user??'']);
const inbox=async(args={})=>scalar(`select public.chat_v2_inbox($1,$2,$3,$4,$5,$6,$7)`,[
  args.tab??'all',args.size??30,args.at??null,args.id??null,args.listing??null,args.query??'',args.unread??false]);
const messages=async(args={})=>scalar(`select public.chat_v2_messages($1,$2,$3,$4)`,[
  args.conversation??conversation,args.size??50,args.at??null,args.id??null]);
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema app_security;
    grant usage on schema public,auth,app_security to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,status text not null default 'active');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.user',true),'')::uuid$$;
    create function app_security.get_account_status(uuid) returns text language sql stable security definer as $$select status from auth.users where id=$1$$;
    create table public.profiles(id uuid primary key references auth.users,display_name text);
    create table public.listings(id uuid primary key,seller_id uuid references auth.users,title text,slug text,price_paise integer,status text,cover_photo_id uuid);
    create function app_security.is_listing_publicly_visible(uuid) returns boolean language sql stable security definer as $$select status='active' from public.listings where id=$1$$;
    create function app_security.create_notification(uuid,text,text,text,text) returns void language plpgsql as $$begin end$$;
  `);
  // Real baseline communication tables, RLS and RPC bodies; only publication removed
  // because this in-memory engine has no Supabase Realtime process.
  await db.exec(readFileSync(resolve(root,'supabase/migrations/20260914000011_create_communication.sql'),'utf8')
    .replace('ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;',''));
  const migration=readFileSync(resolve(root,'supabase/forward-migrations/chat-v2/supabase/migrations/20261025204922_chat_v2_inbox_and_safety.sql'),'utf8');
  await db.exec(migration);
  for(const u of [seller,buyer,outsider]) await db.query(`insert into auth.users(id) values($1)`,[u]);
  await db.query(`insert into public.profiles values($1,'Seller'),($2,'Buyer'),($3,'Outsider')`,[seller,buyer,outsider]);
  await db.query(`insert into public.listings values($1,$2,'Bicycle','bicycle',150000,'active',null)`,[listing,seller]);
  await db.query(`insert into public.conversations(id,listing_id,buyer_id,seller_id) values($1,$2,$3,$4)`,[conversation,listing,buyer,seller]);
  await actor(seller);
  await test('all five capabilities default off',async()=>assert.equal(await scalar(`select count(*)::int from app_security.chat_v2_flags where not enabled`),5));
  await test('new readers fail closed before activation',async()=>{await assert.rejects(()=>inbox(),/CHAT_V2_DISABLED/);await assert.rejects(()=>messages(),/CHAT_V2_DISABLED/);});
  await test('disabled queue claims return no private content',async()=>assert.deepEqual(await scalar(`select public.chat_safety_claim()`),[]));
  await db.exec(`update app_security.chat_v2_flags set enabled=true where name='inbox'`);
  await test('invalid cursor and limits rejected',async()=>{await assert.rejects(()=>inbox({at:'2026-10-25T00:00:00Z'}),/INVALID_CHAT_PAGE/);await assert.rejects(()=>inbox({size:51}),/INVALID_CHAT_PAGE/);await assert.rejects(()=>messages({size:101}),/INVALID_CHAT_PAGE/);});
  await actor(null);
  await test('missing identity rejected even when granted',async()=>assert.rejects(()=>inbox(),/CHAT_ACCESS_DENIED/));
  await actor(outsider);
  await db.exec('set role authenticated');
  await test('outsider sees no inbox or conversation data',async()=>{assert.deepEqual((await inbox()).items,[]);await assert.rejects(()=>messages(),/CHAT_ACCESS_DENIED/);await assert.rejects(()=>inbox({listing}),/CHAT_ACCESS_DENIED/);});
  await test('clients cannot claim or complete safety jobs or alter flags',async()=>{
    await rejects(`select public.chat_safety_claim()`);
    await rejects(`select public.chat_safety_complete($1,$2,array['OTP_PIN'])`,[id(7),id(8)]);
    await rejects(`update app_security.chat_v2_flags set enabled=true`);
    await rejects(`select * from app_security.chat_safety_jobs`);
  });
  await db.exec('reset role');
  await actor(buyer);
  // >200 messages, identical timestamps exercise the UUID tie-break.
  await db.query(`insert into public.messages(id,conversation_id,sender_id,client_request_id,content,created_at)
    select ('00000000-0000-4000-8000-'||lpad((1000+n)::text,12,'0'))::uuid,$1,$2,'request-'||n,'Message '||n,'2026-10-25 10:00:00Z'
    from generate_series(1,230) n`,[conversation,buyer]);
  await test('230 messages paginate deterministically without duplicates or loss',async()=>{
    const seen=new Set();let cursor={};let pages=0;
    do {const page=await messages(cursor);pages++;for(const m of page.items){assert(!seen.has(m.id));seen.add(m.id);}if(!page.has_more)break;cursor=page.next_cursor;}while(pages<10);
    assert.equal(seen.size,230);assert.equal(pages,5);
  });
  await test('page reads do not create or advance read states',async()=>assert.equal(await scalar(`select count(*)::int from public.conversation_read_states`),0));
  await db.query(`insert into public.conversation_read_states values($1,$2,$3,now())`,[conversation,buyer,id(1200)]);
  await actor(seller);
  await test('Seen cursor uses actual peer message tuple',async()=>assert.equal((await messages()).peer_read_cursor.id,id(1200)));
  await test('unread uses message cursor rather than last_read_at clock',async()=>{
    assert.equal((await inbox()).items[0].unread_count,230);
    await db.query(`insert into public.conversation_read_states values($1,$2,$3,now())`,[conversation,seller,id(1200)]);
    assert.equal((await inbox()).items[0].unread_count,30);
  });
  // 120 enquirers for one ad must remain grouped even across a 30-row page.
  await db.query(`insert into auth.users(id) select ('00000000-0000-4000-8000-'||lpad((2000+n)::text,12,'0'))::uuid from generate_series(1,120) n`);
  await db.query(`insert into public.conversations(id,listing_id,buyer_id,seller_id,last_message_at)
    select ('00000000-0000-4000-8000-'||lpad((3000+n)::text,12,'0'))::uuid,$1,
      ('00000000-0000-4000-8000-'||lpad((2000+n)::text,12,'0'))::uuid,$2,'2026-10-25 11:00:00Z'
    from generate_series(1,120) n`,[listing,seller]);
  await test('seller group covers all 121 conversations with actual tab counts',async()=>{
    const page=await inbox();assert.equal(page.items.length,1);assert.equal(page.items[0].enquiry_count,121);
    assert.equal(page.items[0].is_group,true);assert.equal(page.items[0].peer_name,null);
    assert.equal(page.items[0].conversation_id,null);assert.equal(page.counts.selling,121);
  });
  await test('listing drill-down paginates all 121 enquiries',async()=>{
    const seen=new Set();let cursor={listing};
    for(let i=0;i<6;i++){const page=await inbox(cursor);for(const row of page.items){assert.equal(row.is_group,false);assert(!seen.has(row.id));seen.add(row.id);}if(!page.has_more)break;cursor={listing,...page.next_cursor};}
    assert.equal(seen.size,121);
  });
  await test('search and unread filters execute before page limit',async()=>{
    assert.equal((await inbox({query:'not present'})).items.length,0);
    assert.equal((await inbox({query:'bicycle',unread:true})).items[0].unread_count,30);
  });
  await actor(buyer);
  await test('buyer sees own conversation only, never other buyers',async()=>{const page=await inbox({tab:'buying'});assert.equal(page.items.length,1);assert.equal(page.items[0].enquiry_count,1);assert.equal(page.counts.all,1);});
  await db.query(`insert into public.listings(id,seller_id,title,slug,price_paise,status)
    select ('00000000-0000-4000-8000-'||lpad((4000+n)::text,12,'0'))::uuid,$1,'Chair '||n,'chair-'||n,50000,'active'
    from generate_series(1,110) n`,[buyer]);
  await db.query(`insert into public.conversations(id,listing_id,buyer_id,seller_id,last_message_at)
    select ('00000000-0000-4000-8000-'||lpad((5000+n)::text,12,'0'))::uuid,
      ('00000000-0000-4000-8000-'||lpad((4000+n)::text,12,'0'))::uuid,$1,$2,'2026-10-25 11:00:00Z'
    from generate_series(1,110) n`,[seller,buyer]);
  await actor(seller);
  await test('All groups selling only and paginates >100 rows without losing an ad',async()=>{
    const seen=new Set();let cursor={};let groups=0;
    for(let i=0;i<5;i++){
      const page=await inbox(cursor);assert.deepEqual(page.counts,{all:231,buying:110,selling:121});
      for(const row of page.items){assert(!seen.has(row.id));seen.add(row.id);if(row.is_group){groups++;assert.equal(row.enquiry_count,121);assert(row.is_selling);}else assert.equal(row.is_selling,false);}
      if(!page.has_more)break;cursor=page.next_cursor;
    }
    assert.equal(seen.size,111);assert.equal(groups,1);
  });
  await actor(buyer);
  await db.query(`update public.conversations set seller_id=null where id=$1`,[conversation]);
  await test('deleted counterparty stays in Buying with distinct deleted-user state',async()=>{
    const row=(await inbox({tab:'buying'})).items[0];assert.equal(row.peer_name,'Deleted user');assert.equal(row.is_selling,false);
  });
  await db.query(`update public.conversations set seller_id=$2 where id=$1`,[conversation,seller]);
  await db.query(`update public.listings set status='removed',cover_photo_id=$2 where id=$1`,[listing,id(9999)]);
  await test('removed listing keeps readable history but no thumbnail identifier',async()=>{assert.equal((await messages()).items.length,50);assert.equal((await inbox()).items[0].listing.cover_photo_id,null);});
  await db.query(`update auth.users set status='deleted' where id=$1`,[buyer]);
  await test('deleted/restricted actor denied by RPC',async()=>assert.rejects(()=>messages(),/CHAT_ACCESS_DENIED/));
  await db.query(`update auth.users set status='suspended' where id=$1`,[buyer]);
  await test('suspended actor retains read-only history',async()=>assert.equal((await messages()).items.length,50));
  await db.query(`update auth.users set status='active' where id=$1`,[buyer]);
  await db.query(`update public.listings set status='active' where id=$1`,[listing]);
  await db.exec(`update app_security.chat_v2_flags set enabled=true where name='safety_warnings'`);
  await db.exec('set role authenticated');
  let sent;
  await test('legacy text RPC delivers normally and enqueues by message ID',async()=>{
    sent=await scalar(`select public.send_message($1,'Send OTP now','chat-test-0001')`,[conversation]);
    assert.equal(sent.content,'Send OTP now');assert(!('rule_ids' in sent));
  });
  await test('client cannot forge a finding',()=>rejects(`insert into public.message_safety_findings(message_id,recipient_id,rule_version,rule_ids) values($1,$2,'chat_india_v1',array['OTP_PIN'])`,[sent.id,seller]));
  await db.exec('reset role');
  let jobs;
  await db.exec('set role service_role');
  await test('service claims bounded jobs including legacy RPC message',async()=>{jobs=await scalar(`select public.chat_safety_claim(20)`);assert(jobs.length<=20);assert(jobs.some(x=>x.message_id===sent.id));});
  const job=jobs.find(x=>x.message_id===sent.id);
  await test('wrong lease token cannot finalize a warning',async()=>assert.equal(await scalar(`select public.chat_safety_complete($1,$2,array['OTP_PIN'])`,[job.message_id,id(9000)]),false));
  await test('unknown rule IDs are rejected',()=>rejects(`select public.chat_safety_complete($1,$2,array['UNTRUSTED'])`,[job.message_id,job.lease_token]));
  await test('findings finalize idempotently',async()=>{for(let i=0;i<2;i++)assert.equal(await scalar(`select public.chat_safety_complete($1,$2,array['OTP_PIN'])`,[job.message_id,job.lease_token]),true);});
  await db.exec('reset role');
  const retryJob=jobs.find(x=>x.message_id!==sent.id);
  await db.query(`update app_security.chat_safety_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where message_id=$1`,[retryJob.message_id]);
  await db.exec('set role service_role');
  await test('expired lease cannot finalize, then reclaim rotates token',async()=>{
    assert.equal(await scalar(`select public.chat_safety_complete($1,$2,array['OTP_PIN'])`,[retryJob.message_id,retryJob.lease_token]),false);
    const claimed=await scalar(`select public.chat_safety_claim(20)`);
    const next=claimed.find(x=>x.message_id===retryJob.message_id);assert(next);assert.notEqual(next.lease_token,retryJob.lease_token);
    assert.equal(await scalar(`select public.chat_safety_complete($1,$2,array['OTP_PIN'])`,[retryJob.message_id,retryJob.lease_token]),false);
    assert.equal(await scalar(`select public.chat_safety_complete($1,$2,array[]::text[])`,[next.message_id,next.lease_token]),true);
  });
  await db.exec('reset role');
  await db.query(`update app_security.chat_safety_jobs set attempts=5,next_attempt_at=clock_timestamp()-interval '1 second' where message_id=$1`,[jobs.find(x=>x.message_id!==retryJob.message_id&&x.message_id!==sent.id).message_id]);
  await db.exec('set role service_role');
  await test('five failed attempts stop automatic retry',async()=>{
    const exhausted=jobs.find(x=>x.message_id!==retryJob.message_id&&x.message_id!==sent.id).message_id;
    assert(!(await scalar(`select public.chat_safety_claim(20)`)).some(x=>x.message_id===exhausted));
  });
  await db.exec('reset role');
  await db.exec(`alter table public.messages disable trigger chat_safety_enqueue`);
  const recovered=id(9500);
  await db.query(`insert into public.messages(id,conversation_id,sender_id,client_request_id,content) values($1,$2,$3,'missing-trigger','Send UPI PIN now')`,[recovered,conversation,buyer]);
  await db.exec(`alter table public.messages enable trigger chat_safety_enqueue; set role service_role`);
  await test('recovery eventually claims a missed message through bounded backlog batches',async()=>{
    let found=false;
    for(let batch=0;batch<20&&!found;batch++)found=(await scalar(`select public.chat_safety_claim(20)`)).some(x=>x.message_id===recovered);
    assert(found);
  });
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await actor(seller);
  await test('recipient sees caution under RLS',async()=>assert.equal(await scalar(`select count(*)::int from public.message_safety_findings`),1));
  await actor(buyer);
  await test('sender cannot see own caution',async()=>assert.equal(await scalar(`select count(*)::int from public.message_safety_findings`),0));
  await actor(outsider);
  await test('outsider cannot see caution',async()=>assert.equal(await scalar(`select count(*)::int from public.message_safety_findings`),0));
  await db.exec('reset role');
  await db.exec(`update app_security.chat_v2_flags set enabled=false where name='safety_warnings'`);
  await actor(seller);await db.exec('set role authenticated');
  await test('kill switch immediately hides existing cautions',async()=>assert.equal(await scalar(`select count(*)::int from public.message_safety_findings`),0));
  await db.exec('reset role');
  await test('new tables enforce RLS and no client writes',async()=>{
    assert.equal(await scalar(`select count(*)::int from pg_class where relname in ('chat_v2_flags','chat_safety_jobs','message_safety_findings') and relrowsecurity and relforcerowsecurity`),3);
    assert.equal(await scalar(`select has_table_privilege('authenticated','public.message_safety_findings','UPDATE')`),false);
    assert.equal(await scalar(`select has_function_privilege('anon','public.chat_v2_inbox(text,integer,timestamptz,uuid,uuid,text,boolean)','EXECUTE')`),false);
  });
  console.log(`PASS ${checks} Chat V2 disposable PostgreSQL checks. Fixture account/listing helpers; no hosted/realtime acceptance.`);
} finally {await db.close();}
