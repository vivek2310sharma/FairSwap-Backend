// Isolated PostgreSQL runtime. No URLs, environment files, hosted mutations or delivery.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {dirname, resolve} from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const arg = process.argv[2];
assert(process.argv.length <= 3 && (!arg || arg.startsWith('--pglite-module=')), 'Unexpected arguments');
const require = createRequire(resolve(root, '../FairSwap-Web/package.json'));
const {PGlite} = arg
  ? await import(pathToFileURL(resolve(arg.slice('--pglite-module='.length))).href)
  : require('@electric-sql/pglite');
const read = path => readFileSync(resolve(root, path), 'utf8');
const snapshots = JSON.parse(read('tests/listing-validity-365/hosted-functions.json'));
const dir = 'supabase/forward-migrations/listing-validity-365/supabase/migrations';
const migration = read(`${dir}/${readdirSync(resolve(root, dir)).find(f => f.endsWith('.sql'))}`);
let checks = 0;
const test = async (name, fn) => { await fn(); console.log(`ok ${++checks} - ${name}`); };
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const moderator = '33333333-3333-4333-8333-333333333333';
const category = '44444444-4444-4444-8444-444444444444';
const protectedId = 'f3d90d0a-3ed5-4e7f-ac74-91579fcdedf8';
const protectedExpiry = '2027-11-11 18:49:01.486986+00';

for (const environment of ['production', 'test']) {
  const db = new PGlite();
  const q = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0])[0];
  const apply = async () => {
    try { await db.exec(`begin;${migration}commit;`); }
    catch (e) { await db.exec('rollback'); throw e; }
  };
  const actor = async (id, staff = false, aal = 'aal2') => {
    await db.query("select set_config('fixture.user', $1, false)", [id ?? '']);
    await db.query("select set_config('fixture.staff', $1, false)", [String(staff)]);
    await db.query("select set_config('fixture.aal', $1, false)", [aal]);
  };
  const listing = async (status = 'pending_review') => q(`insert into public.listings
    (seller_id,category_id,status) values($1,$2,$3::public.listing_status_enum) returning id`, [owner, category, status]);
  const photo = async id => q(`insert into public.listing_media(listing_id) values($1) returning id`, [id]);
  const approve = id => q("select public.moderate_listing_reviewed($1,'approve',null,1,'pending_review')", [id]);
  const renew = id => q("select app_security.impl_seller_transition_listing($1,'renew')", [id]);
  const lifetime = id => q("select expires_at - published_at = interval '365 days' from public.listings where id=$1", [id]);
  try {
    // Synthetic dependencies only. The functions under test are actual captured
    // hosted definitions, and reviewed-wrapper/visibility SQL is canonical source.
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema app_security; create schema vault;
      grant usage on schema public,auth,app_security to anon,authenticated,service_role;
      create type public.listing_status_enum as enum ('draft','pending_review','active','reserved','sold','rejected','paused','expired','removed');
      create type public.staff_role_enum as enum ('moderator','administrator');
      create type public.moderation_decision_state as enum ('auto_approved','routed_to_admin','rejected_invalid','escalated_to_admin');
      create type public.moderation_outcome_enum as enum ('no_review_flags','needs_review','invalid_input','checks_incomplete');
      create type public.moderation_request_status as enum ('pending','claimed','retry','completed','superseded');
      create table public.user_accounts(user_id uuid primary key,account_status text default 'active',policy boolean default true);
      create table public.categories(id uuid primary key,is_active boolean default true,macro_category text default 'goods');
      create table public.car_category_contracts(category_id uuid);
      create table public.vehicle_category_contracts(category_id uuid);
      create table public.property_category_contracts(category_id uuid);
      create table public.listings(id uuid primary key default gen_random_uuid(),seller_id uuid,category_id uuid,
        status public.listing_status_enum default 'draft',title text default 'Synthetic listing',description text default 'Synthetic description',
        city_id uuid default gen_random_uuid(),slug text,revision int default 1,renewal_count int default 0,
        published_at timestamptz,expires_at timestamptz,sold_at timestamptz,submitted_at timestamptz,
        updated_at timestamptz,cover_photo_id uuid,rejection_reason text,removal_reason text,removed_by uuid);
      create table public.listing_media(id uuid primary key default gen_random_uuid(),listing_id uuid,
        processing_status text default 'ready',original_storage_path text default 'synthetic/photo',display_order int default 0,created_at timestamptz default now());
      create table public.listing_moderation_requests(id uuid primary key default gen_random_uuid(),listing_id uuid,
        listing_revision int default 1,generation_id uuid default gen_random_uuid(),status public.moderation_request_status default 'claimed',
        claim_token uuid default gen_random_uuid(),claim_expires_at timestamptz default now()+interval '1 hour',
        evaluated_title text default 'Synthetic listing',evaluated_description text default 'Synthetic description',
        attempt_count int default 0,max_attempts int default 3,next_attempt_at timestamptz,updated_at timestamptz);
      create table public.listing_moderation_results(request_id uuid,listing_id uuid,listing_revision int,generation_id uuid,
        outcome public.moderation_outcome_enum,ruleset_version text,scope text,completed_rules text[],failed_rules text[],flags jsonb,errors jsonb,decision public.moderation_decision_state);
      create table app_security.listing_moderation_scan_receipts(id uuid primary key default gen_random_uuid(),request_id uuid,
        listing_id uuid,listing_revision int,generation_id uuid,ruleset_version text,scope text,consumed boolean default false,
        verdict text default 'APPROVE',failed_checks text[] default '{}',flags jsonb default '[]',completed_checks text[],
        scanned_media_count int,manifest jsonb default '[]',created_at timestamptz default now());
      create table app_security.listing_media_verified_hashes(media_id uuid,listing_id uuid,generation_id uuid,content_sha256 text,verified_at timestamptz default now());
      create table public.app_system_settings(setting_key text primary key,setting_value text);
      create table vault.decrypted_secrets(name text,decrypted_secret text);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('fixture.user',true),'')::uuid$$;
      create function app_security.get_account_status(uuid) returns text language sql security definer set search_path='' as $$select account_status from public.user_accounts where user_id=$1$$;
      create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql security definer set search_path='' as $$select coalesce((select policy from public.user_accounts where user_id=$1),false)$$;
      create function app_security.is_active_staff_aal2(public.staff_role_enum) returns boolean language sql stable as $$select coalesce(current_setting('fixture.staff',true)='true' and current_setting('fixture.aal',true)='aal2',false)$$;
      create function app_security.log_audit_event(text,text,uuid,jsonb) returns void language sql as $$select$$;
      create table public.fixture_notifications(body text);
      create function app_security.create_notification(uuid,text,text,text,text) returns void language sql as $$insert into public.fixture_notifications values($4)$$;
      create table public.fixture_transitions(listing_id uuid,from_status text,to_status text,reason text);
      insert into public.app_system_settings values('moderation_automation_enabled','true'),('moderation_azure_enabled','true');
    `);
    await db.query('insert into public.user_accounts(user_id) values($1),($2),($3)', [owner, other, moderator]);
    await db.query('insert into public.categories(id) values($1)', [category]);
    for (const fn of snapshots[environment]) await db.exec(fn.definition);
    if (environment === 'test') await db.exec(snapshots.production.find(f => f.proname === 'is_listing_publicly_visible').definition);
    await db.exec(snapshots.notification.definition);
    await db.exec(read('supabase/migrations/20261007153744_atomic_reviewed_moderation.sql'));
    await db.exec(`
      revoke all on function app_security.impl_moderate_listing(uuid,text,text) from public,anon,authenticated;
      grant execute on function app_security.impl_moderate_listing(uuid,text,text) to service_role;
      revoke all on function app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) from public,anon,authenticated;
      grant execute on function app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) to service_role;
      alter table public.listings enable row level security;
      grant select on public.listings to authenticated;
      create policy listings_select_policy on public.listings for select using (seller_id=auth.uid() or app_security.is_active_staff_aal2('moderator') or app_security.is_active_staff_aal2('administrator'));
      create trigger fixture_notify after insert on public.fixture_transitions for each row execute function public.trg_fn_listing_transition_notification();
    `);
    const beforeSecurity = await db.query("select proname,proacl,prosecdef,proconfig from pg_proc where pronamespace='app_security'::regnamespace order by proname");
    const beforePolicies = await db.query("select * from pg_policies where tablename='listings'");
    const existing = [];
    for (const status of ['active','reserved','paused','expired','rejected','removed','sold','pending_review','draft']) {
      const id = await listing(status);
      await db.query("update public.listings set published_at=now()-interval '10 days',expires_at=now()+interval '20 days' where id=$1", [id]);
      existing.push({id,status});
    }
    const expired = await listing('active');
    const later = await listing('active');
    const unlimited = await listing('active');
    const boundary = await listing('active');
    const unapproved = await listing('active');
    const suspended = await listing('active');
    const inactiveCategory = await listing('active');
    const policyMissing = await listing('active');
    const soldTimestamp = await listing('active');
    await db.query("update public.listings set published_at=now()-interval '30 days',expires_at=now() where id=$1",[boundary]);
    for(const id of [unapproved,suspended,inactiveCategory,policyMissing,soldTimestamp]) {
      await db.query("update public.listings set published_at=now()-interval '10 days',expires_at=now()+interval '20 days' where id=$1",[id]);
    }
    await db.query('update public.listings set published_at=null where id=$1',[unapproved]);
    await db.query("update public.user_accounts set account_status='suspended' where user_id=$1",[other]);
    await db.query('update public.listings set seller_id=$2 where id=$1',[suspended,other]);
    const disabled=await q("insert into public.categories values(gen_random_uuid(),false,'goods') returning id");
    await db.query('update public.listings set category_id=$2 where id=$1',[inactiveCategory,disabled]);
    const noPolicy=await q("insert into public.user_accounts values(gen_random_uuid(),'active',false) returning user_id");
    await db.query('update public.listings set seller_id=$2 where id=$1',[policyMissing,noPolicy]);
    await db.query('update public.listings set sold_at=now() where id=$1',[soldTimestamp]);
    await db.query("update public.listings set published_at=now()-interval '40 days',expires_at=now()-interval '1 microsecond' where id=$1", [expired]);
    await db.query("update public.listings set published_at=now(),expires_at=now()+interval '500 days' where id=$1", [later]);
    await db.query("update public.listings set published_at=now() where id=$1", [unlimited]);
    await db.query("insert into public.listings(id,seller_id,category_id,status,published_at,expires_at) values($1,$2,$3,'active','2026-10-12 11:01:31.760406+00',$4)", [protectedId,owner,category,protectedExpiry]);
    const originalRows = (await db.query('select id,expires_at::text from public.listings')).rows;
    await test(`${environment}: migration executes against captured hosted definitions`, apply);
    await test(`${environment}: only eligible statuses extend, never shorten or resurrect`, async () => {
      for (const {id,status} of existing) {
        if (['active','reserved','paused'].includes(status)) assert.equal(await lifetime(id),true);
        else assert.equal(await q('select expires_at::text from public.listings where id=$1',[id]), originalRows.find(r=>r.id===id).expires_at);
      }
      for (const id of [expired,later,unlimited,protectedId,boundary,unapproved,suspended,inactiveCategory,policyMissing,soldTimestamp]) assert.equal(await q('select expires_at::text from public.listings where id=$1',[id]), originalRows.find(r=>r.id===id).expires_at);
    });
    await test(`${environment}: ACLs, RLS, definer and search_path unchanged`, async () => {
      assert.deepEqual((await db.query("select proname,proacl,prosecdef,proconfig from pg_proc where pronamespace='app_security'::regnamespace order by proname")).rows,beforeSecurity.rows);
      assert.deepEqual((await db.query("select * from pg_policies where tablename='listings'")).rows,beforePolicies.rows);
    });
    await test(`${environment}: manual approval gets exactly 365 days`, async () => {
      const id=await listing(); await photo(id); await actor(moderator,true);
      await db.exec('set role authenticated'); await approve(id); await db.exec('reset role');
      assert.equal(await lifetime(id),true);
    });
    await test(`${environment}: review authorization, self-review, stale revision and media checks persist`, async () => {
      const id=await listing();
      await actor(owner,true); await assert.rejects(()=>approve(id),/Listing unavailable/);
      await actor(moderator,true,'aal1'); await assert.rejects(()=>approve(id),/Staff authorization/);
      await actor(moderator,false); await assert.rejects(()=>approve(id),/Staff authorization/);
      await actor(moderator,true); await assert.rejects(()=>q("select public.moderate_listing_reviewed($1,'approve',null,2,'pending_review')",[id]),/MODERATION_REVIEW_CONFLICT/);
      await assert.rejects(()=>approve(id),/at least one photo/); const media=await photo(id);
      await db.query("update public.listing_media set processing_status='pending' where id=$1",[media]);
      await assert.rejects(()=>approve(id),/processing_status/);
      for (const role of ['anon','authenticated']) {
        await db.exec(`set role ${role}`);
        await assert.rejects(()=>q("select app_security.impl_moderate_listing($1,'approve',null)",[id]),/permission denied/);
        await assert.rejects(()=>q("select app_security.impl_finalize_moderation_result_azure_v1($1,$1,'no_review_flags','x','x')",[id]),/permission denied/);
        await db.exec('reset role');
      }
    });
    await test(`${environment}: renewal is owner-only, policy-gated, reviewed and limited to three`, async () => {
      await db.query("update public.user_accounts set account_status='active' where user_id=$1",[other]);
      const id=await listing('expired'); await photo(id); await actor(other);
      await assert.rejects(()=>renew(id),/does not own/);
      await actor(null); await assert.rejects(()=>renew(id),/not authenticated/);
      await actor(owner); await db.query('update public.user_accounts set policy=false where user_id=$1',[owner]);
      await assert.rejects(()=>renew(id),/POLICY_ACCEPTANCE_REQUIRED/);
      await db.query("update public.user_accounts set policy=true,account_status='suspended' where user_id=$1",[owner]);
      await assert.rejects(()=>renew(id),/account is not active/);
      await db.query("update public.user_accounts set account_status='active' where user_id=$1",[owner]);
      for (let i=1;i<=3;i++) {
        await actor(owner); await renew(id);
        assert.equal(await q('select renewal_count from public.listings where id=$1',[id]),i);
        assert.equal(await q('select status from public.listings where id=$1',[id]),'pending_review');
        await actor(moderator,true); await approve(id); assert.equal(await lifetime(id),true);
        await db.query("update public.listings set status='expired',expires_at=now()-interval '1 day' where id=$1",[id]);
      }
      await actor(owner); await assert.rejects(()=>renew(id),/renewal limit of 3/);
    });
    const automatic = async ({renewal=false, receipt=true, kill=false, stale=false, restricted=false}={}) => {
      const id=await listing(renewal?'expired':'pending_review');
      if(renewal){await actor(owner);await renew(id);}
      const media=await photo(id);
      const req=(await db.query('insert into public.listing_moderation_requests(listing_id) values($1) returning *',[id])).rows[0];
      if(receipt) {
        await db.query(`insert into app_security.listing_moderation_scan_receipts(request_id,listing_id,listing_revision,generation_id,ruleset_version,scope,completed_checks,scanned_media_count,manifest)
          values($1,$2,1,$3,'india_azure_v1.0.0','multimodal_five_check',array['check_india_fraud_rules','check_openai_moderation','check_vision_nsfw','check_vision_category','check_ocr_qr'],1,$4)`,[req.id,id,req.generation_id,JSON.stringify([{id:media,path:'synthetic/photo',sha256:'synthetic-hash'}])]);
        await db.query('insert into app_security.listing_media_verified_hashes(media_id,listing_id,generation_id,content_sha256) values($1,$2,$3,$4)',[media,id,req.generation_id,'synthetic-hash']);
      }
      if(kill) await db.exec("update public.app_system_settings set setting_value='false' where setting_key='moderation_automation_enabled'");
      if(stale) await db.query('update public.listings set revision=2 where id=$1',[id]);
      if(restricted) await db.query('insert into public.car_category_contracts values($1)',[category]);
      await db.exec('set role service_role');
      const result=await q("select app_security.impl_finalize_moderation_result_azure_v1($1,$2,'no_review_flags','india_azure_v1.0.0','multimodal_five_check')",[req.id,req.claim_token]);
      await db.exec('reset role');
      await db.exec("update public.app_system_settings set setting_value='true' where setting_key='moderation_automation_enabled';delete from public.car_category_contracts");
      return {id,result};
    };
    await test(`${environment}: Azure approval and renewal get exactly 365 days`,async()=>{
      for(const renewal of [false,true]) { const {id,result}=await automatic({renewal}); assert.equal(result.decision,'auto_approved');assert.equal(await lifetime(id),true); }
    });
    await test(`${environment}: missing receipt, kill switch, stale revision and restricted categories fail closed`,async()=>{
      for(const option of [{receipt:false},{kill:true},{stale:true},{restricted:true}]) {const {id,result}=await automatic(option);assert.notEqual(result.decision,'auto_approved');assert.equal(await q('select status from public.listings where id=$1',[id]),'pending_review');}
    });
    await test(`${environment}: public visibility spans day 30 and stops at exact expiry`,async()=>{
      const id=await listing('active');
      await db.query("update public.listings set published_at=now()-interval '31 days',expires_at=now()+interval '334 days' where id=$1",[id]);
      assert.equal(await q('select app_security.is_listing_publicly_visible($1)',[id]),true);
      // Fix clock_timestamp only for this deterministic boundary probe; the
      // comparison and status/account logic remain the captured production code.
      await db.exec("create function app_security.fixture_now() returns timestamptz language sql immutable as $$select timestamptz '2028-02-29 00:00:00+00'$$");
      const visible=snapshots.production.find(f=>f.proname==='is_listing_publicly_visible').definition;
      await db.exec(visible.replace('pg_catalog.clock_timestamp()','app_security.fixture_now()'));
      for(const [offset,expected] of [['1 microsecond',true],['0 microseconds',false],['-1 microsecond',false]]){
        await db.query("update public.listings set expires_at=app_security.fixture_now()+$2::interval where id=$1",[id,offset]);
        assert.equal(await q('select app_security.is_listing_publicly_visible($1)',[id]),expected);
      }
      await db.exec(visible);
      for(const status of ['paused','reserved','sold','rejected','removed','expired','pending_review']) {
        await db.query("update public.listings set status=$2::public.listing_status_enum,expires_at=now()+interval '365 days' where id=$1",[id,status]);
        assert.equal(await q('select app_security.is_listing_publicly_visible($1)',[id]),false);
      }
      await actor(other);await db.exec('set role authenticated');
      assert.equal(await q('select count(*)::int from public.listings where id=$1',[id]),0);
      await assert.rejects(()=>db.query("update public.listings set expires_at=now()+interval '999 days' where id=$1",[id]),/permission denied/);
      await db.exec('reset role');
    });
    await test(`${environment}: moderation notification includes validity`,async()=>{
      const id=await listing();await db.query("insert into public.fixture_transitions values($1,'pending_review','active',null)",[id]);
      assert.match(await q('select body from public.fixture_notifications limit 1'),/365 days from publication/);
    });
    await test(`${environment}: reapplication/drift aborts atomically`,async()=>{
      const before=await q("select expires_at::text from public.listings where id=$1",[protectedId]);
      await assert.rejects(apply,/function drift/);
      assert.equal(await q("select expires_at::text from public.listings where id=$1",[protectedId]),before);
    });
    await test(`${environment}: later prerequisite drift rolls back earlier function patches`,async()=>{
      for(const fn of snapshots[environment].filter(f=>['impl_moderate_listing','impl_finalize_moderation_result_azure_v1'].includes(f.proname))) await db.exec(fn.definition);
      await db.exec(snapshots.notification.definition.replace("'Listing Approved'","'Changed notification title'"));
      const original=await q("select pg_get_functiondef('app_security.impl_moderate_listing(uuid,text,text)'::regprocedure)");
      await assert.rejects(apply,/function drift: public.trg_fn_listing_transition_notification/);
      assert.equal(await q("select pg_get_functiondef('app_security.impl_moderate_listing(uuid,text,text)'::regprocedure)"),original);
    });
  } finally { await db.close(); }
}
console.log(JSON.stringify({success:true,checks,engine:'PGlite',hostedWrites:false}));
