// Real PG17 connections: Azure moderation finalizer 20261104113705 installed alongside Accessories (activated) and the resequenced Wearables V1.
// Verifies the publication guard, moderation approval path and Wearables risk flags coexist. Never accepts a URL or live target.

import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {installPostingFixture} from '../../scripts/ci/posting-v2-fixture.mjs';
import {getCandidate} from '../../scripts/release/reusable-candidates.mjs';
import {runWearablesPostflight,runWearablesPreflight,AZURE_FINALIZER_BODY_SHA256} from '../../scripts/release/wearables-v1-release.mjs';
import {postflightQuery} from '../../scripts/release/accessories-v1-release.mjs';
import {verifyRemotePostflight} from '../../scripts/release/reusable-supabase-release.mjs';
import {NativeFixture,literal} from '../posting-v212/native-adapter.mjs';
const webArg=process.argv.slice(4).find(a=>a.startsWith('--web='));
const web=resolve(webArg?webArg.slice(6):'../FairSwap-Web');
const catalogue=JSON.parse(readFileSync(resolve(web,'src/lib/listings/wearables/catalogue.generated.json'),'utf8'));
const db=new NativeFixture(process.argv[2],process.argv[3]);let checks=0;
const u=randomUUID(),other=randomUUID(),city=randomUUID(),locality=randomUUID();
const ctx=(owner=u,name='w_client',role='authenticated')=>({owner,role,name});
const ws=(id,op,media=null)=>`select public.wearable_v1_session(${literal(id)},${literal(op)},${literal(media)}) as value`;
const ps=(id,op,media=null)=>`select public.posting_v2_session(${literal(id)},${literal(op)},${literal(media)}) as value`;
const run=async(sql,owner=u,name='w_client',role='authenticated')=>(await db.query(sql,[],ctx(owner,name,role))).rows[0].value;
const wcall=(id,op,owner=u,name='w_client',media=null)=>run(ws(id,op,media),owner,name);
const pcall=(id,op,owner=u,name='p_client',media=null)=>run(ps(id,op,media),owner,name);
const row=async id=>(await db.query('select * from public.posting_upload_sessions where id=$1',[id])).rows[0];
const n=async(sql,args=[])=>(await db.query(`select count(*)::int as n from (${sql}) q`,args)).rows[0].n;
const hold=async(body,name,owner=u,role='authenticated')=>{const h=db.start(body,ctx(owner,name,role),true);await db.wait(h,r=>r.state==='idle in transaction');return h;};
const model=t=>catalogue.models.find(m=>m.type===t);
const payload=(sessionId,mediaIds,over={})=>{const m=model('smartwatch');return {selection:{category:'mobiles',subcategory:'wearables',version:1},session_id:sessionId,catalogue_revision:catalogue.revision,device_type:'smartwatch',brand_id:m.brand_id,other_brand:'',model_id:m.id,other_model:'',generation:'',case_size_mm:44,connectivity:'bluetooth',phone_os:['android'],finish:'',condition:'good',screen:'minor_scratches',controls:'working',sensors:'working',charging:'working',battery_mode:'not_tested',strap:'good',included:['charger'],purchase_month:'2024-05',warranty_until:'',pairing_status:'reset_ready',transfer_ack:false,ownership_confirmed:true,title:'Smartwatch in good condition',description:'Used for one year, always with a case. Charger included.',trade:'sell',price_paise:500000,negotiable:true,pin_code:'560034',city_id:city,locality_id:locality,media_ids:mediaIds,plan_id:'free-v1',...over};};
const submitSql=p=>`select public.submit_wearable_v1(${literal(JSON.stringify(p))}::jsonb) as value`;
async function stage(owner=u,over={}){
 const id=randomUUID(),media=randomUUID();await wcall(id,'create',owner);
 const reserved=await wcall(id,'reserve',owner,'w_stage',media);const attempt=reserved.media[0].attempt;
 await db.exec(`insert into storage.objects values('posting-staged',${literal(owner+'/'+id+'/'+media+'/'+attempt+'/medium.webp')})`);
 await db.exec(`select set_config('request.jwt','{"role":"service_role"}',false)`).catch(()=>{});
 await db.start(`select public.posting_v2_media_ready(${literal(id)},${literal(media)},${literal(attempt)},1000,800,600)`,{owner,role:'service_role',jwt:'{"role":"service_role"}',name:'w_ready'}).done;
 const prepared=await wcall(id,'prepare',owner);
 for(const nm of ['original','thumb','medium','large'])await db.exec(`insert into storage.objects values(${literal(nm==='original'?'listing-originals':'listing-derivatives')},${literal(prepared.session.listing_id+'/'+media+'/'+nm+'.webp')})`);
 return {id,media,listing:prepared.session.listing_id,payload:payload(id,[media],over)};
}
const test=async(label,fn)=>{
 await db.exec('truncate app_security.listing_moderation_scan_receipts,app_security.listing_media_verified_hashes,public.listing_moderation_results,public.listing_moderation_requests,public.listing_media,public.listing_wearable_risk_flags_v1,public.listing_wearable_contexts_v1,public.listings,public.posting_upload_sessions,storage.objects cascade').catch(()=>{});
 try{await fn();checks++;console.log(`ok ${checks} - ${label}`);}catch(e){console.error('FAILED:',label,String(e.message).slice(0,300));throw e;}
};
const code=c=>e=>e.code===c||String(e.message).includes(c);
const fixtureSql=`
 create schema if not exists extensions;create schema if not exists vault;
 create function extensions.digest(data text,type text) returns bytea language sql immutable as $$select sha256(convert_to(data,'UTF8'))$$;
 create table vault._secrets(name text primary key,decrypted_secret text);
 create view vault.decrypted_secrets as select name,decrypted_secret from vault._secrets;
 grant usage on schema vault,extensions,app_security,public to service_role;grant select on vault.decrypted_secrets to service_role;
 create table public.app_system_settings(setting_key text primary key,setting_value text not null);
 insert into public.app_system_settings values('moderation_automation_enabled','true');
 create type public.moderation_decision_state as enum('auto_approved','routed_to_admin','awaiting_retry','escalated_to_admin','rejected_invalid','superseded');
 create type public.moderation_outcome_enum as enum('no_review_flags','needs_review','checks_incomplete','invalid_input');
 create type public.moderation_request_status as enum('pending','claimed','completed','retry','failed','superseded');
 create table public.listing_moderation_requests(id uuid primary key default gen_random_uuid(),listing_id uuid not null references public.listings(id) on delete cascade,listing_revision integer not null,generation_id uuid not null,status public.moderation_request_status not null default 'pending',claim_token uuid,claim_expires_at timestamptz,attempt_count integer not null default 0,max_attempts integer not null default 3,next_attempt_at timestamptz not null default clock_timestamp(),evaluated_title text not null,evaluated_description text,created_at timestamptz not null default clock_timestamp(),updated_at timestamptz not null default clock_timestamp());
 create table public.listing_moderation_results(id uuid primary key default gen_random_uuid(),request_id uuid not null references public.listing_moderation_requests(id) on delete cascade,listing_id uuid not null references public.listings(id) on delete cascade,listing_revision integer not null,generation_id uuid not null,outcome public.moderation_outcome_enum not null,ruleset_version text not null,scope text not null,completed_rules text[] not null default array[]::text[],failed_rules text[] not null default array[]::text[],flags jsonb not null default '[]'::jsonb,errors jsonb not null default '[]'::jsonb,decision public.moderation_decision_state not null,created_at timestamptz not null default clock_timestamp());
 create table public.car_category_contracts(category_id uuid primary key references public.categories(id));create table public.vehicle_category_contracts(category_id uuid primary key references public.categories(id));create table public.property_category_contracts(category_id uuid primary key references public.categories(id));
 create table public.listing_car_contexts(listing_id uuid primary key references public.listings(id) on delete cascade);create table public.listing_vehicle_contexts(listing_id uuid primary key references public.listings(id) on delete cascade);create table public.listing_property_contexts(listing_id uuid primary key references public.listings(id) on delete cascade);`;
// Runs a runner-style read-only SQL function natively: capture the queries it asks for, execute them on PG17, replay the answers.
async function viaNative(run){
 const queries=[];try{run(q=>{queries.push(q);return '{}';});}catch{}
 const answers=[];for(const q of queries)answers.push(await db.exec(q.replace(/^BEGIN READ ONLY; ?/i,'').replace(/;? ?COMMIT;$/i,'').replace(/^-- [^\n]*\n/,'').replace(/^BEGIN READ ONLY;/i,'').replace(/COMMIT;$/i,'')));
 let i=0;return run(()=>answers[i++]);
}
const checkOut=x=>JSON.parse(x.split('\n').filter(Boolean).pop());
const RULES="array['check_india_fraud_rules','check_openai_moderation','check_vision_nsfw','check_vision_category','check_ocr_qr']::text[]";
const sha=s=>createHash('sha256').update(s).digest('hex');
const activationSql=readFileSync(resolve('supabase/forward-migrations/wearables-v1/activation/supabase/migrations/20261104220000_activate_wearables_v1.sql'),'utf8');
async function submit(over={}){const s=await stage(u,over);await db.start(submitSql(s.payload),ctx(u,'az_submit')).done;return s;}
async function claim(listing,{mutate=false}={}){
 const l=(await db.query('select revision,title,description from public.listings where id=$1',[listing])).rows[0];
 const media=(await db.query('select id,original_storage_path as path from public.listing_media where listing_id=$1 order by id',[listing])).rows;
 const req=randomUUID(),token=randomUUID(),gen=randomUUID();
 await db.exec(`insert into public.listing_moderation_requests(id,listing_id,listing_revision,generation_id,status,claim_token,claim_expires_at,evaluated_title,evaluated_description) values(${literal(req)},${literal(listing)},${l.revision},${literal(gen)},'claimed',${literal(token)},now()+interval '1 hour',${literal(l.title)},${literal(l.description)})`);
 const manifest=media.map(m=>({id:m.id,path:m.path,sha256:sha(m.id)}));
 const digest=sha(manifest.map(m=>`${m.id}:${m.path}:${m.sha256}`).sort().join('\n'));
 const reg=`select app_security.register_moderation_scan_receipt(${literal(req)},${literal(token)},${literal(listing)},${l.revision},${literal(gen)},${literal(digest)},'APPROVE','india_v1.0.0','multimodal_five_check',${RULES},array[]::text[],'[]'::jsonb,'{}'::jsonb,${literal(JSON.stringify(manifest))}::jsonb,${manifest.length}) as value`;
 await db.start(reg,ctx(u,'az_register','service_role')).done;
 return {req,token,gen,media};
}
const finalize=(c,outcome='no_review_flags',role='service_role',name='az_final')=>db.start(`select app_security.impl_finalize_moderation_result(${literal(c.req)},${literal(c.token)},${literal(outcome)},'india_v1.0.0','multimodal_five_check',${RULES},array[]::text[],'[]'::jsonb,'[]'::jsonb) as value`,ctx(u,name,role)).done;
const status=async id=>(await db.query('select status from public.listings where id=$1',[id])).rows[0].status;
const request=async id=>(await db.query('select status from public.listing_moderation_requests where id=$1',[id])).rows[0].status;
const flagsOf=async id=>(await db.query('select signal from public.listing_wearable_risk_flags_v1 where listing_id=$1',[id])).rows.map(r=>r.signal);
// Phone / Accessory listings go through the real posting RPCs so the finalizer sees production-shaped rows.
async function stagePost(kind,owner=u){
 const id=randomUUID(),media=randomUUID();await pcall(id,'create',owner);
 const reserved=await pcall(id,'reserve',owner,'p_stage',media);const attempt=reserved.media[0].attempt;
 await db.exec(`insert into storage.objects values('posting-staged',${literal(owner+'/'+id+'/'+media+'/'+attempt+'/medium.webp')})`);
 await db.start(`select public.posting_v2_media_ready(${literal(id)},${literal(media)},${literal(attempt)},1000,800,600)`,{owner,role:'service_role',jwt:'{"role":"service_role"}',name:'p_ready'}).done;
 const prepared=await pcall(id,'prepare',owner);
 for(const nm of ['original','thumb','medium','large'])await db.exec(`insert into storage.objects values(${literal(nm==='original'?'listing-originals':'listing-derivatives')},${literal(prepared.session.listing_id+'/'+media+'/'+nm+'.webp')})`);
 const common={session_id:id,trade:'sell',condition:'good',warranty_until:'',negotiable:false,pin_code:'560034',city_id:city,locality_id:locality,media_ids:[media],plan_id:'free-v1'};
 let p,sql;
 if(kind==='phone'){const m=(await db.query("select m.id,m.brand_id from public.phone_models m join public.phone_brands b on b.id=m.brand_id where b.name='Apple' and m.name='iPhone 15'")).rows[0];
  p={selection:{category:'mobiles',subcategory:'mobile-phones',version:2},...common,brand_id:m.brand_id,model_id:m.id,other_model:'',storage:'128 GB',ram:'',included:[],title:'iPhone 15 128 GB',description:'Carefully used with no repairs.',price_paise:2000000};sql='public.submit_mobile_v2';}
 else{p={selection:{category:'mobiles',subcategory:'mobile-accessories',version:1},...common,type:'phone-case',brand:'Spigen',other_brand:'',product_model:'Liquid Air',originality:'third_party',compatibility:{state:'seller',device_brand:'Samsung',device_model:'Galaxy S24',standard:''},specs:{variant:'S24 6.2 inch',material:'TPU',colour:'Black',magnetic:'No'},quantity:1,bundle_contents:'One phone case',working:'not_applicable',faults:'',bill:false,box:false,safety:'not_applicable',title:'Spigen case for Galaxy S24',description:'Carefully used with visible wear shown.',price_paise:50000};sql='public.submit_accessory_v1';}
 await db.start(`select ${sql}(${literal(JSON.stringify(p))}::jsonb)`,ctx(owner,'az_post_submit')).done;
 return {id,media,listing:prepared.session.listing_id};
}
const consumed=async id=>(await db.query('select consumed from app_security.listing_moderation_scan_receipts where request_id=$1',[id])).rows[0].consumed;
try{
 const version=await db.verify();await installPostingFixture(db);
 const f='supabase/forward-migrations/';
 await db.exec(`alter table public.listings add column slug text,add column created_at timestamptz default now(),add column published_at timestamptz,add column expires_at timestamptz,add column search_vector tsvector;alter table public.categories add column icon text;alter table public.cities add column name text default 'Bengaluru',add column state text default 'Karnataka';alter table public.localities add column name text default 'Koramangala';create table public.user_accounts(user_id uuid primary key,account_status text)`);
 // Hosted order: Accessories foundation + activation first, then Azure moderation 20261104113705, then Wearables.
 for(const p of ['posting-v2/session-recovery/supabase/migrations/20261101234604_posting_v212_session_recovery.sql','posting-v2/activation/supabase/migrations/20261025135152_activate_posting_v2_mobiles.sql','accessories-v1/foundation/supabase/migrations/20261102164135_accessories_v1.sql','accessories-v1/activation/supabase/migrations/20261102164137_activate_accessories_v1.sql'])await db.exec(readFileSync(resolve(f+p),'utf8'));
 await db.exec(fixtureSql);
 await db.exec(readFileSync(resolve(f+'moderation-azure-v1/20261104113705_azure_moderation_finalizer.sql'),'utf8'));
 // The public finalizer wrapper exists in the 58 immutable baseline migrations; the fixture needs it for the Azure postflight.
 await db.exec(`create function public.impl_finalize_moderation_result(p_request_id uuid,p_claim_token uuid,p_outcome text,p_ruleset_version text,p_scope text,p_completed_rules text[],p_failed_rules text[],p_flags jsonb,p_errors jsonb default '[]'::jsonb) returns jsonb language sql security invoker set search_path='' as $$select app_security.impl_finalize_moderation_result(p_request_id,p_claim_token,p_outcome,p_ruleset_version,p_scope,p_completed_rules,p_failed_rules,p_flags,p_errors)$$;
  revoke all on function public.impl_finalize_moderation_result from public,anon,authenticated;grant execute on function public.impl_finalize_moderation_result to service_role`);
 await db.exec(`insert into auth.users values(${literal(u)}),(${literal(other)});insert into public.user_accounts values(${literal(u)},'active'),(${literal(other)},'active');insert into public.cities values(${literal(city)},true);insert into public.localities values(${literal(locality)},${literal(city)},true);insert into public.postal_pincode_localities values('560034',${literal(locality)})`);
 const foundation=getCandidate('wearables-v1-foundation'),activation=getCandidate('wearables-v1-activation');
 await test('Wearables foundation preflight passes on the hosted-order baseline (Accessories activated, Azure installed)',async()=>{
  const r=await viaNative(run=>runWearablesPreflight(foundation,sql=>run(sql)));assert.ok(Object.values(r).every(v=>v===true));
 });
 for(const [candidate,p] of [[foundation,'wearables-v1/supabase/migrations/20261104120000_posting_v2_wearables.sql'],[activation,'wearables-v1/activation/supabase/migrations/20261104220000_activate_wearables_v1.sql']]){
  if(candidate===activation)await test('Wearables activation preflight passes with Azure installed and foundation disabled',async()=>{const r=await viaNative(run=>runWearablesPreflight(activation,sql=>run(sql)));assert.ok(Object.values(r).every(v=>v===true));});
  if(candidate===activation){
   const compatSql=activationSql.slice(activationSql.indexOf('do $$\ndeclare'),activationSql.indexOf('\nupdate public.categories'));assert.ok(compatSql.startsWith('do $$')&&compatSql.includes('WEARABLES_AZURE_BASELINE_DRIFT'));
   const azureFile=readFileSync(resolve(f+'moderation-azure-v1/20261104113705_azure_moderation_finalizer.sql'),'utf8');
   const bodyStart=azureFile.indexOf('AS $$\n',azureFile.indexOf('CREATE OR REPLACE FUNCTION app_security.impl_finalize_moderation_result('))+5;const azureBody=azureFile.slice(bodyStart,azureFile.indexOf('\n$$;',bodyStart)+1);
   const FIN='app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)';
   const tamper=(opts,body='begin return null::jsonb; end')=>`create or replace function app_security.impl_finalize_moderation_result(p_request_id uuid,p_claim_token uuid,p_outcome text,p_ruleset_version text,p_scope text,p_completed_rules text[],p_failed_rules text[],p_flags jsonb,p_errors jsonb default '[]'::jsonb) returns jsonb language plpgsql volatile ${opts} as $t$${body}$t$;`;
   const lastLine=out=>out.split('\n').filter(Boolean).pop();
   await test('PINNED DIGEST: the sha256 pinned in the activation SQL and the release scripts equals the Azure file body AND the natively installed pg_proc.prosrc',async()=>{
    const pinned=sha(azureBody);assert.ok(activationSql.includes(pinned));assert.equal(pinned,AZURE_FINALIZER_BODY_SHA256);
    assert.equal(getCandidate('moderation-azure-v1').sha256,sha(azureFile),'Azure candidate pin is the reviewed file');
    assert.equal(lastLine(await db.exec(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='${FIN}'::regprocedure`)),pinned);
   });
   await test('COMPAT PRECONDITIONS fail closed (each attempt rolled back): drifted body, non-definer, wrong search_path, missing flags table, conflicting inner function',async()=>{
    const rejects=(sql,msg)=>assert.rejects(()=>db.exec(sql),code(msg));
    await rejects(tamper("security definer set search_path=''")+compatSql,'WEARABLES_AZURE_BASELINE_DRIFT');
    await rejects(tamper("security invoker set search_path=''",azureBody)+compatSql,'WEARABLES_AZURE_BASELINE_DRIFT');
    await rejects(tamper('security definer',azureBody)+compatSql,'WEARABLES_AZURE_BASELINE_DRIFT');
    await rejects('alter table public.listing_wearable_risk_flags_v1 rename to flags_gone;'+compatSql,'WEARABLES_AZURE_PREREQUISITE_MISSING');
    await rejects('create function app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb) returns jsonb language sql as $x$select null::jsonb$x$;'+compatSql,'WEARABLES_AZURE_FINALIZER_ALREADY_WRAPPED');
    assert.equal(lastLine(await db.exec("select to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') is null")),'t');
    assert.equal(lastLine(await db.exec(`select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='${FIN}'::regprocedure`)),AZURE_FINALIZER_BODY_SHA256);
   });
   await test('COMPAT with no finalizer installed is a no-op (nothing to correct); an inner without a public finalizer is inconsistent',async()=>{
    assert.equal(lastLine(await db.exec(`drop function ${FIN};`+compatSql+`;select to_regprocedure('${FIN}') is null;rollback`)),'t');
    await assert.rejects(()=>db.exec(`alter function ${FIN} rename to impl_finalize_moderation_result_azure_v1;`+compatSql),code('WEARABLES_AZURE_FINALIZER_INCONSISTENT'));
   });
  }
  await db.exec(readFileSync(resolve(f+p),'utf8'));
  await test(`Wearables ${candidate.stage} postflight passes natively with Azure installed`,async()=>{const r=await viaNative(run=>runWearablesPostflight(candidate,sql=>run(sql)));assert.ok(Object.values(r).every(v=>v===true));});
 }
 await db.exec('grant select,update(status) on public.listings to authenticated,service_role');
 await test('Azure postflight still passes natively after Wearables is installed',async()=>{
  const queries=[];try{await verifyRemotePostflight('FairSwapTest','moderation-azure-v1','x',{},(cmd,args)=>{queries.push(args[args.length-1]);return '{}';});}catch{}
  const answers=[];for(const q of queries)answers.push(await db.exec(q.replace(/^\s*BEGIN READ ONLY;/i,'').replace(/COMMIT;\s*$/i,'')));
  let i=0;const res=await verifyRemotePostflight('FairSwapTest','moderation-azure-v1','x',{},()=>answers[i++]);assert.ok(Object.values(res).every(v=>v===true));
 });
 await test('ORDER CONSTRAINT: the Accessories activation postflight no longer holds once Wearables replaces the session body, so Accessories adoption must run before Wearables',async()=>{
  const r=checkOut(await db.exec(postflightQuery('activation').replace(/^-- [^\n]*\n/,'').replace(/^BEGIN READ ONLY;/i,'').replace(/COMMIT;\s*$/i,'')));
  assert.equal(r.mobile_wrappers_extended,false);
  assert.equal(r.release_state,true);assert.equal(r.rls_forced,true);
 });
 await test('clean wearable: Azure finalizer auto-approves through the Wearables publication guard',async()=>{
  const s=await submit();const c=await claim(s.listing);assert.equal(await status(s.listing),'pending_review');
  const out=JSON.parse(await finalize(c));assert.equal(out.decision,'auto_approved');assert.equal(await status(s.listing),'active');assert.equal(await consumed(c.req),true);assert.equal(await request(c.req),'completed');
  assert.equal((await db.query('select count(*)::int as n from public.listing_wearable_risk_flags_v1 where listing_id=$1',[s.listing])).rows[0].n,0);
 });
 await test('W-AZ-1 (previously failing, now fixed): a flagged wearable finalized by Azure as no_review_flags completes as routed_to_admin and is never published',async()=>{
  for(const over of [{pairing_status:'still_paired',transfer_ack:true},{pairing_status:'unknown'},{model_id:null,other_model:'Mystery watch'}]){
   const s=await submit(over);assert.ok((await flagsOf(s.listing)).length>0);
   const c=await claim(s.listing);
   const out=JSON.parse(await finalize(c));
   assert.deepEqual([out.success,out.decision,out.status],[true,'routed_to_admin','pending_review']);
   assert.equal(await status(s.listing),'pending_review');assert.equal(await request(c.req),'completed');assert.equal(await consumed(c.req),true);
   assert.equal((await db.query('select published_at,expires_at from public.listings where id=$1',[s.listing])).rows[0].published_at,null);
   const res=(await db.query('select decision,outcome from public.listing_moderation_results where request_id=$1',[c.req])).rows;
   assert.deepEqual(res,[{decision:'routed_to_admin',outcome:'needs_review'}]);
  }
 });
 await test('every wearable risk-flag state routes to staff: other_model, other_brand, still_paired, unknown_pairing and combinations',async()=>{
  const states=[
   ['other_model',{model_id:null,other_model:'Mystery watch'},['other_model']],
   ['other_brand',{brand_id:null,other_brand:'Acme Wear',model_id:null,other_model:'AW-1'},['other_brand','other_model']],
   ['still_paired',{pairing_status:'still_paired',transfer_ack:true},['still_paired']],
   ['unknown_pairing',{pairing_status:'unknown'},['unknown_pairing']],
   ['combined',{brand_id:null,other_brand:'Acme Wear',model_id:null,other_model:'AW-1',pairing_status:'still_paired',transfer_ack:true},['other_brand','other_model','still_paired']]];
  for(const [label,over,expected] of states){
   const s=await submit(over);assert.deepEqual((await flagsOf(s.listing)).sort(),expected.sort(),label);
   const c=await claim(s.listing);const out=JSON.parse(await finalize(c));
   assert.equal(out.decision,'routed_to_admin',label);assert.equal(await status(s.listing),'pending_review',label);
   assert.equal(await request(c.req),'completed',label);assert.equal(await consumed(c.req),true,label);
   assert.equal((await db.query('select count(*)::int as n from public.listing_moderation_results where request_id=$1',[c.req])).rows[0].n,1,label);
  }
 });
 await test('clean wearable (no flags) is still auto-approved; flags table stays empty',async()=>{
  const s=await submit();assert.equal((await flagsOf(s.listing)).length,0);const c=await claim(s.listing);
  const out=JSON.parse(await finalize(c));assert.deepEqual([out.decision,out.status],['auto_approved','active']);
  assert.equal(await status(s.listing),'active');assert.equal(await consumed(c.req),true);assert.equal(await request(c.req),'completed');
 });
 await test('normal Mobile Phone and Accessory listings are auto-approved exactly as before the correction',async()=>{
  for(const kind of ['phone','accessory']){
   const s=await stagePost(kind);const c=await claim(s.listing);assert.equal(await status(s.listing),'pending_review');
   const out=JSON.parse(await finalize(c));assert.deepEqual([out.decision,out.status],['auto_approved','active'],kind);
   assert.equal(await consumed(c.req),true,kind);assert.equal(await request(c.req),'completed',kind);
  }
 });
 await test('non-approval outcomes are untouched for flagged wearables: needs_review routes, invalid_input rejects, checks_incomplete retries, then a later clean claim still routes',async()=>{
  const s=await submit({pairing_status:'unknown'});
  let c=await claim(s.listing);let out=JSON.parse(await finalize(c,'checks_incomplete'));assert.equal(out.decision,'awaiting_retry');
  assert.equal(await request(c.req),'retry');assert.equal(await status(s.listing),'pending_review');assert.equal(await consumed(c.req),false);
  // worker re-leases the same request (service-role queue operation) and the retried scan reports a clean outcome
  const token=randomUUID();await db.exec(`update public.listing_moderation_requests set status='claimed',claim_token=${literal(token)},claim_expires_at=now()+interval '1 hour' where id=${literal(c.req)}`);
  out=JSON.parse(await finalize({...c,token}));assert.deepEqual([out.decision,out.status],['routed_to_admin','pending_review']);
  assert.equal(await consumed(c.req),true);assert.equal(await request(c.req),'completed');
  const t=await submit({pairing_status:'unknown'});const d=await claim(t.listing);
  out=JSON.parse(await finalize(d,'invalid_input'));assert.equal(out.decision,'rejected_invalid');assert.equal(await status(t.listing),'pending_review');
 });
 await test('retries and replays are idempotent: a second finalize returns REQUEST_NOT_CLAIMED, adds no result row, never publishes; wrong lease token is refused',async()=>{
  const s=await submit({pairing_status:'still_paired',transfer_ack:true});const c=await claim(s.listing);
  const bad=JSON.parse(await finalize({...c,token:randomUUID()}));assert.deepEqual([bad.success,bad.error],[false,'LEASE_TOKEN_MISMATCH']);
  assert.equal(await request(c.req),'claimed');assert.equal(await consumed(c.req),false);
  assert.equal(JSON.parse(await finalize(c)).decision,'routed_to_admin');
  for(const outcome of ['no_review_flags','needs_review']){const again=JSON.parse(await finalize(c,outcome));assert.deepEqual([again.success,again.error],[false,'REQUEST_NOT_CLAIMED']);}
  assert.equal((await db.query('select count(*)::int as n from public.listing_moderation_results where request_id=$1',[c.req])).rows[0].n,1);
  assert.equal(await status(s.listing),'pending_review');assert.equal(await consumed(c.req),true);
 });
 await test('concurrent finalization of one flagged request: both wait on the listing lock; exactly one routes, the other sees a completed request; one result row; nothing published',async()=>{
  const s=await submit({pairing_status:'still_paired',transfer_ack:true});const c=await claim(s.listing);
  const holder=await hold(`select 1 from public.listings where id=${literal(s.listing)} for update`,'az_fin_holder',u,'posting_fixture_admin');
  const a=finalize(c,'no_review_flags','service_role','az_fin_a'),b=finalize(c,'no_review_flags','service_role','az_fin_b');
  await db.wait({name:'az_fin_a',error:null},r=>r.wait_event_type==='Lock');await db.wait({name:'az_fin_b',error:null},r=>r.wait_event_type==='Lock');
  await holder.finish(true);
  const results=(await Promise.all([a,b])).map(x=>JSON.parse(x)).sort((x,y)=>String(x.success).localeCompare(String(y.success)));
  assert.deepEqual(results.map(r=>[r.success,r.decision??r.error]),[[false,'REQUEST_NOT_CLAIMED'],[true,'routed_to_admin']]);
  assert.equal((await db.query('select count(*)::int as n from public.listing_moderation_results where request_id=$1',[c.req])).rows[0].n,1);
  assert.equal(await status(s.listing),'pending_review');assert.equal(await consumed(c.req),true);assert.equal(await request(c.req),'completed');
 });
 await test('concurrent finalization of one CLEAN request publishes exactly once',async()=>{
  const s=await submit();const c=await claim(s.listing);
  const holder=await hold(`select 1 from public.listings where id=${literal(s.listing)} for update`,'az_fin_holder2',u,'posting_fixture_admin');
  const a=finalize(c,'no_review_flags','service_role','az_fin_c'),b=finalize(c,'no_review_flags','service_role','az_fin_d');
  await db.wait({name:'az_fin_c',error:null},r=>r.wait_event_type==='Lock');await db.wait({name:'az_fin_d',error:null},r=>r.wait_event_type==='Lock');
  await holder.finish(true);
  const results=(await Promise.all([a,b])).map(x=>JSON.parse(x));
  assert.equal(results.filter(r=>r.success&&r.decision==='auto_approved').length,1);assert.equal(results.filter(r=>!r.success&&r.error==='REQUEST_NOT_CLAIMED').length,1);
  assert.equal((await db.query('select count(*)::int as n from public.listing_moderation_results where request_id=$1',[c.req])).rows[0].n,1);assert.equal(await status(s.listing),'active');
 });
 await test('receipt consumption: the routed flagged request consumes only its own receipt; a receipt for another listing/request stays unconsumed',async()=>{
  const s=await submit({pairing_status:'unknown'}),t=await submit({pairing_status:'unknown'});const c=await claim(s.listing),d=await claim(t.listing);
  assert.equal(JSON.parse(await finalize(c)).decision,'routed_to_admin');
  assert.equal(await consumed(c.req),true);assert.equal(await consumed(d.req),false);assert.equal(await request(d.req),'claimed');
  const rows=(await db.query('select count(*)::int as n from app_security.listing_moderation_scan_receipts where request_id=$1',[c.req])).rows[0].n;assert.equal(rows,1);
 });
 await test('forged roles and settings cannot publish a flagged wearable or reach the Azure body: clients get 42501, forged GUCs/claims change nothing, the renamed Azure function is not callable by any client role',async()=>{
  const s=await submit({pairing_status:'still_paired',transfer_ack:true});const c=await claim(s.listing);
  for(const role of ['authenticated','anon'])await assert.rejects(()=>finalize(c,'no_review_flags',role,`az_forge_${role}`),code('42501'));
  const inner=`app_security.impl_finalize_moderation_result_azure_v1(${literal(c.req)},${literal(c.token)},'no_review_flags','india_v1.0.0','multimodal_five_check',${RULES},array[]::text[],'[]'::jsonb,'[]'::jsonb)`;
  for(const role of ['authenticated','anon','service_role'])await assert.rejects(()=>db.start(`select ${inner}`,ctx(u,`az_inner_${role}`,role)).done,code('42501'));
  const forged=`select set_config('request.staff','true',true);select set_config('app.is_system_transition','true',true);select set_config('request.jwt','{"role":"service_role","aal":"aal2","staff_role":"moderator","moderation":"no_review_flags"}',true);select set_config('app.wearable_review_bypass','true',true);`;
  const out=JSON.parse(await db.start(forged+`select app_security.impl_finalize_moderation_result(${literal(c.req)},${literal(c.token)},'no_review_flags','india_v1.0.0','multimodal_five_check',${RULES},array[]::text[],'[]'::jsonb,'[]'::jsonb)`,ctx(u,'az_forge_svc','service_role')).done.then(x=>x.split('\n').filter(Boolean).pop()));
  assert.equal(out.decision,'routed_to_admin');assert.equal(await status(s.listing),'pending_review');
  // a seller or service role still cannot flip status themselves, with or without forged settings
  const activate=`update public.listings set status='active' where id=${literal(s.listing)}`;
  // request.staff is the FIXTURE stub for staff identity (see fixture_limitations); production staff identity is JWT/AAL2-derived and not a client-settable GUC, so the activation attempts forge only the generic markers.
  const forgedAct=forged.replace("select set_config('request.staff','true',true);",'');
  for(const [role,name] of [['authenticated','seller'],['service_role','svc']])await assert.rejects(()=>db.start(forgedAct+activate,ctx(u,`az_${name}_act`,role)).done,code('requires staff review'));
  assert.equal(await status(s.listing),'pending_review');
  // client-declared flags/outcomes carry no authority: finalizer takes no listing/flag argument; the flag rows are not client-writable
  for(const role of ['authenticated','anon','service_role'])await assert.rejects(()=>db.start(`delete from public.listing_wearable_risk_flags_v1 where listing_id=${literal(s.listing)}`,ctx(u,`az_del_${role}`,role)).done,code('42501'));
 });
 await test('replaced media after scanning: flagged wearable is still routed (never active); clean wearable is downgraded and not approved; receipts are consumed only on completion',async()=>{
  const s=await submit({pairing_status:'unknown'});const c=await claim(s.listing);
  await db.exec(`update public.listing_media set original_storage_path='replaced/'||id where listing_id=${literal(s.listing)}`);
  const out=JSON.parse(await finalize(c));assert.equal(out.decision,'routed_to_admin');assert.equal(await status(s.listing),'pending_review');assert.equal(await request(c.req),'completed');
  const t=await submit();const d=await claim(t.listing);
  await db.exec(`update public.listing_media set original_storage_path='replaced/'||id where listing_id=${literal(t.listing)}`);
  const o2=JSON.parse(await finalize(d));assert.notEqual(o2.decision,'auto_approved');assert.equal(await status(t.listing),'pending_review');assert.equal(await consumed(d.req),false);
 });
 await test('flagged wearable routed to admin by moderation: only an AAL2 moderator can approve; seller, service role and forged settings cannot',async()=>{
  const s=await submit({pairing_status:'still_paired',transfer_ack:true});const c=await claim(s.listing);
  const out=JSON.parse(await finalize(c,'needs_review'));assert.equal(out.decision,'routed_to_admin');assert.equal(out.status,'pending_review');
  assert.equal(await status(s.listing),'pending_review');assert.equal(await request(c.req),'completed');assert.equal(await consumed(c.req),true);
  const activate=`update public.listings set status='active' where id=${literal(s.listing)}`;
  await assert.rejects(()=>db.start(activate,ctx(u,'az_seller')).done,code('requires staff review'));
  await assert.rejects(()=>db.start(activate,ctx(u,'az_svc','service_role')).done,code('requires staff review'));
  await assert.rejects(()=>db.start(`select set_config('request.staff','false',true);select set_config('app.is_system_transition','true',true);`+activate,ctx(u,'az_forged')).done,code('requires staff review'));
  await assert.rejects(()=>finalize(c,'no_review_flags'),code('REQUEST_NOT_CLAIMED')).catch(async e=>{ // returns {success:false} rather than raising
   if(!String(e.message).includes('Missing expected rejection'))throw e;
   const r=JSON.parse(await finalize(c,'no_review_flags'));assert.equal(r.success,false);assert.equal(r.error,'REQUEST_NOT_CLAIMED');});
  assert.equal(await status(s.listing),'pending_review');
  await db.start(`select set_config('request.staff','true',true);${activate}`,ctx(other,'az_mod')).done;
  assert.equal(await status(s.listing),'active');
  assert.equal((await db.query('select count(*)::int as n from public.listing_wearable_risk_flags_v1',[],ctx(u,'az_flag_read'))).rows[0].n,0); // RLS: staff only
 });
 await test('Azure and Wearables ACL/RLS isolation: clients cannot register receipts, finalize, read receipts, or touch flags',async()=>{
  const s=await submit({pairing_status:'unknown'});const c=await claim(s.listing);
  for(const role of ['authenticated','anon'])await assert.rejects(()=>finalize(c,'no_review_flags',role,`az_${role}`),code('42501'));
  for(const role of ['authenticated','anon'])for(const t of ['app_security.listing_moderation_scan_receipts','app_security.listing_media_verified_hashes'])await assert.rejects(()=>db.start(`select count(*) from ${t}`,ctx(u,'az_tbl',role)).done,code('42501'));
  for(const role of ['authenticated','service_role','anon'])await assert.rejects(()=>db.start(`update public.listing_wearable_risk_flags_v1 set signal='other_model'`,ctx(u,'az_flags',role)).done,code('42501'));
  for(const role of ['authenticated','anon'])await assert.rejects(()=>db.start(`select app_security.impl_posting_session_core_v1(gen_random_uuid(),'create',null,null)`,ctx(u,'az_core',role)).done,code('42501'));
  assert.equal(await status(s.listing),'pending_review');
 });
 await test('activation is single-shot: re-running the compatibility step on the wrapped finalizer is refused (no double wrap)',async()=>{
  const compatSql=activationSql.slice(activationSql.indexOf('do $$\ndeclare'),activationSql.indexOf('\nupdate public.categories'));
  await assert.rejects(()=>db.exec(compatSql),code('WEARABLES_AZURE_FINALIZER_ALREADY_WRAPPED'));
 });
 await test('REVIEW-ONLY rollback script refuses while enabled; after disabling it restores the Azure function name and W-AZ-1 fails closed again (guard raises, nothing published)',async()=>{
  const rb=readFileSync(resolve(f+'wearables-v1/rollback/restore_azure_finalizer.sql'),'utf8');
  await assert.rejects(()=>db.exec(rb),code('WEARABLES_AZURE_ROLLBACK_PRECONDITION_FAILED'));
  await db.exec(readFileSync(resolve(f+'wearables-v1/rollback/disable_wearables_v1.sql'),'utf8'));
  await db.exec(rb);
  const inner=await db.exec("select to_regprocedure('app_security.impl_finalize_moderation_result_azure_v1(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)') is null");assert.equal(inner.split('\n').pop(),'t');
  const body=await db.exec("select encode(sha256(convert_to(prosrc,'UTF8')),'hex') from pg_proc where oid='app_security.impl_finalize_moderation_result(uuid,uuid,text,text,text,text[],text[],jsonb,jsonb)'::regprocedure");assert.equal(body.split('\n').pop(),AZURE_FINALIZER_BODY_SHA256);
  await db.exec("update public.wearable_release_v1 set enabled=true;update public.categories set is_active=true where id=(select category_id from public.wearable_release_v1)");
  const s=await submit({pairing_status:'unknown'});const c=await claim(s.listing);
  await assert.rejects(()=>finalize(c),code('requires staff review'));assert.equal(await status(s.listing),'pending_review');
 });
 console.log(JSON.stringify({status:'PASS',postgres_version_num:version,checks,order:'Accessories(foundation+activation) -> Azure 20261104113705 -> Wearables foundation 20261104120000 -> Wearables activation 20261104220000 (wraps the Azure finalizer)',resolved_findings:['W-AZ-1'],known_findings:[],
  fixture_limitations:['pgcrypto: extensions.digest is a sha256() shim (no pgcrypto extension in the source build)','vault: vault.decrypted_secrets is a plain table-backed view; no real Vault','moderation identities: is_active_staff_aal2 is the posting fixture stub keyed on the request.staff GUC, so moderator/AAL2 identity is mocked (no Auth/JWT/AAL, no real moderate_listing_reviewed)','scan receipts use synthetic manifest hashes (sha256 of media id), not content hashes','auth.users, cities/localities, storage.objects and categories are minimal fixtures; roles authenticated/anon/service_role are fixture roles','PG 17.6 source build without openssl/icu/readline/zlib; not a Supabase-hosted instance']}));
}finally{db.close();}
