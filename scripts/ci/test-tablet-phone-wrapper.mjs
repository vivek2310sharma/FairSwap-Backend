// Disposable source-contract regressions; never accepts a hosted database URL.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {installPostingFixture} from './posting-v2-fixture.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(resolve(process.argv[2]??resolve(root,'../FairSwap-Web'),'package.json'));
const {PGlite}=require('@electric-sql/pglite');
const read=rel=>readFileSync(resolve(root,'supabase/forward-migrations',rel),'utf8');
const tablet=read('tablets-v1/supabase/migrations/20261102165946_posting_v2_tablets.sql');
const accessory=read('accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql');
const recovery=read('posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql');
const activation=read('posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql');
const scalar=async(db,sql,args=[])=>Object.values((await db.query(sql,args)).rows[0])[0];
const info=db=>db.query("select oid::text as oid,proowner,prosrc,proargnames,prosecdef,proconfig from pg_proc where oid='app_security.impl_submit_mobile_v2(jsonb)'::regprocedure").then(r=>r.rows[0]);
let count=0;
async function test(name,fn){const db=new PGlite();try{await installPostingFixture(db);await db.exec(recovery);await fn(db);console.log(`PASS ${++count}: ${name}`);}finally{await db.close();}}
for(const withAccessories of [false,true])await test(`preserves implementation identity, public wrapper and delegate body (${withAccessories?'with Accessories':'phone baseline'})`,async db=>{
 const initial=await info(db);const pub=await scalar(db,"select pg_get_functiondef('public.submit_mobile_v2(jsonb)'::regprocedure)");
 if(withAccessories)await db.exec(accessory);
 const before=await info(db);await db.exec('PREPARE existing_phone_plan(jsonb) AS select public.submit_mobile_v2($1)');
 const owner='11111111-1111-4111-8111-111111111111',session='22222222-2222-4222-8222-222222222222';
 await db.query('insert into auth.users values($1)',[owner]);await db.query("select set_config('request.user',$1,false)",[owner]);
 await assert.rejects(()=>db.exec("EXECUTE existing_phone_plan('{}'::jsonb)"),/Invalid posting contract/);
 await db.exec(tablet);const after=await info(db);assert.equal(after.oid,initial.oid);assert.deepEqual(after.proargnames,before.proargnames);
 assert.equal(await scalar(db,"select pg_get_functiondef('public.submit_mobile_v2(jsonb)'::regprocedure)"),pub);
 assert.equal(await scalar(db,"select prosrc from pg_proc where oid='app_security.impl_submit_mobile_v2_before_tablets(jsonb)'::regprocedure"),before.prosrc);
 assert.equal(await scalar(db,"select proowner from pg_proc where oid='app_security.impl_submit_mobile_v2_before_tablets(jsonb)'::regprocedure"),before.proowner);
 assert.equal(await scalar(db,"select has_function_privilege('authenticated','app_security.impl_submit_mobile_v2(jsonb)','EXECUTE')"),true);
 for(const role of ['anon','authenticated','service_role'])assert.equal(await scalar(db,"select has_function_privilege($1,'app_security.impl_submit_mobile_v2_before_tablets(jsonb)','EXECUTE')",[role]),false);
 await db.exec(activation);await db.exec('update public.tablet_release_v1 set enabled=true;update public.categories set is_active=true where slug=\'tablets\'');
 await scalar(db,"select public.tablet_v1_session($1,'create')",[session]);
 const payload={selection:{category:'mobiles',subcategory:'mobile-phones',version:2},session_id:session,plan_id:'free-v1'};
 await db.exec('set role authenticated');
 await assert.rejects(()=>db.exec(`EXECUTE existing_phone_plan('${JSON.stringify(payload)}'::jsonb)`),/Cross-category session/);
 await assert.rejects(()=>db.query('select app_security.impl_submit_mobile_v2($1::jsonb)',[JSON.stringify(payload)]),/Cross-category session/);
 await db.exec('reset role');
});
for(const target of ['implementation','public wrapper'])await test(`unexpected ${target} fails closed without changing installed functions or adding tablet tables`,async db=>{
 const signature=target==='implementation'?'app_security.impl_submit_mobile_v2':'public.submit_mobile_v2';
 const body=await scalar(db,'select prosrc from pg_proc where oid=$1::regprocedure',[signature+'(jsonb)']);
 await db.exec(`create or replace function ${signature}(${target==='implementation'?'p_payload':'payload'} jsonb) returns jsonb language ${target==='implementation'?'plpgsql security definer':'sql security invoker'} set search_path='' as $drift$${body}\n-- drift fixture\n$drift$`);
 const before=await scalar(db,'select pg_get_functiondef($1::regprocedure)',[signature+'(jsonb)']);
 await assert.rejects(()=>db.exec(tablet),/TABLETS_PHONE_IMPLEMENTATION_DRIFT/);await db.exec('rollback');
 assert.equal(await scalar(db,'select pg_get_functiondef($1::regprocedure)',[signature+'(jsonb)']),before);
 assert.equal(await scalar(db,"select to_regclass('public.tablet_brands_v1')"),null);
});
await test('Accessories refuses to overwrite a previously installed tablet wrapper',async db=>{
 await db.exec(tablet);const before=await info(db);await assert.rejects(()=>db.exec(accessory),/ACCESSORIES_PHONE_IMPLEMENTATION_DRIFT/);await db.exec('rollback');assert.deepEqual(await info(db),before);assert.equal(await scalar(db,"select to_regclass('public.accessory_release_v1')"),null);
});
console.log(`${count} phone wrapper/source-drift checks passed.`);
