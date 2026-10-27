// Automated disposable PG17 fixture; no hosted URL or credentials accepted.
import '../../../tests/ratings/offline-guard.mjs';
import {NativeDatabase} from '../../../tests/ratings/native-adapter.mjs';
import {readFileSync as read,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hdr03Checks} from './hdr03/regression.mjs';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../..');
const env=process.argv.find(x=>x.startsWith('--environment='))?.split('=')[1];
assert(['test','production'].includes(env));
const db=new NativeDatabase(process.argv.find(x=>x.startsWith('--native-port='))?.split('=')[1]);
const r=p=>read(resolve(root,p),'utf8'),local=p=>read(resolve(here,p),'utf8');
const evidence=JSON.parse(local(env+'/hosted-evidence.json')),extra=JSON.parse(local(env+'/installed-contracts.json'));
const q=async(sql,args=[])=>Object.values((await db.query(sql,args)).rows[0]??{})[0];
let count=0;const check=async(name,fn)=>{await fn();console.log(`ok ${++count} - ${env}: ${name}`);};
const owner=()=>db.exec('reset role; set role postgres');
const login=async(u,aal='aal1')=>{await owner();await db.query("select set_config('request.user',$1,false),set_config('request.aal',$2,false)",[u??'',aal]);await db.exec('set role authenticated');};
await db.exec(r('tests/ratings/bootstrap.sql').replace('create role ratings_fixture_admin superuser login;','').replace('alter role postgres rename to pglite_bootstrap;',''));
assert.match(await q('select version()'),/PostgreSQL 17\./);
for(const f of readdirSync(resolve(root,'supabase/migrations')).filter(f=>/^202609140000(0[1-9]|1[0-4])_/.test(f)&&!f.startsWith('20260914000007')).sort())await db.exec(r('supabase/migrations/'+f).replace(/^ALTER PUBLICATION .*;$/gm,''));
// Explicit missing-service fixtures. No claim to reconstruct 87/71 full histories.
await db.exec(`alter table public.user_accounts add column acceptable_use_version text,add column age_confirmed_at timestamptz,add column minimum_age_confirmed smallint;
create table public.policy_acceptance_records(id uuid default gen_random_uuid(),user_id uuid,terms_version text,privacy_policy_version text,acceptable_use_version text,minimum_age_confirmed smallint,accepted_at timestamptz);
alter table public.profiles add column avatar_path text;
alter table public.categories add column macro_category text default 'goods',add column new_listing_enabled boolean default true;
create table public.postal_pincode_localities(id uuid);
create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
create function app_security.has_current_policy_acceptance(uuid) returns boolean language sql as $$select coalesce(current_setting('test.policy',true),'true')<>'false'$$;`);
for(const p of evidence.contracts.filter(x=>/impl_seller_transition_listing|is_active_staff_aal2/.test(x.signature)))await db.exec(p.definition);
const base=extra.find(x=>x.signature==='app_security.impl_fulfill_data_export_base(uuid)');
await db.exec(base.definition.replaceAll('impl_fulfill_data_export_base','impl_fulfill_data_export'));
// Actual Oct25 onboarding source, then installed public Admin wrapper and private ACLs.
await db.exec(r('supabase/forward-migrations/profile-onboarding/20261025100001_user_private_details.sql'));
await db.exec(r('supabase/forward-migrations/profile-onboarding/20261025100006_privacy_export_and_deletion.sql'));
const wrapper=extra.find(x=>x.signature==='admin_fulfill_data_export(uuid)');await db.exec(wrapper.definition);
for(const p of [...evidence.contracts,...extra].filter(x=>/fulfill_data_export|is_active_staff_aal2|seller_transition_listing/.test(x.signature))){
 await db.exec(`revoke all on function ${p.signature} from public,anon,authenticated,service_role;`);
 for(const role of ['anon','authenticated','service_role'])if(p[role+'_execute'])await db.exec(`grant execute on function ${p.signature} to ${role}`);
}
// Full immutable mobile foundation SQL; Storage service and postal registry are fixtures.
await db.exec(r('supabase/forward-migrations/posting-v2/supabase/migrations/20261025131116_posting_v2_mobiles.sql'));
const protectedBefore=(await db.query(`select oid::regprocedure::text signature,prosrc,proacl::text acl from pg_proc where pronamespace in ('public'::regnamespace,'app_security'::regnamespace) order by 1`)).rows;
const mobileSnapshot=()=>q(`select jsonb_agg(to_jsonb(t) order by t.relname) from (select c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity from pg_class c where c.oid in ('public.posting_upload_sessions'::regclass,'public.listing_mobile_contexts'::regclass,'public.posting_category_definitions'::regclass,'public.phone_models'::regclass,'public.phone_brands'::regclass)) t`);
const mobileBefore=await mobileSnapshot();
// Ledger metadata fixtures use captured authoritative hashes, never invented versions.
await db.exec('create schema supabase_migrations;create table supabase_migrations.schema_migrations(version text primary key,name text,statements text[]);');
// Test the exact generated ledger guard against real statement arrays with independent values.
const guard=local(env+'/preflight.sql').split('\n').find(x=>x.includes('if exists(with expected'));
await check('full ledger guard rejects incomplete ledger even when latest/count could be spoofed',async()=>{await assert.rejects(()=>db.exec('do $$ begin\n'+guard+'\nend $$;'),/RATINGS_FULL_LEDGER_DRIFT/);});
await check('exact ledger comparison accepts equality and rejects same-count name/hash/version drift',async()=>{
 await db.exec("insert into supabase_migrations.schema_migrations values('20260101000000','fixture',array['select 1'])");
 const fixture=(await db.query("select version,name,encode(sha256(convert_to(to_jsonb(statements)::text,'UTF8')),'hex') as ledger_statements_json_sha256 from supabase_migrations.schema_migrations")).rows;
 const bound=guard.replace(/jsonb_to_recordset\('[\s\S]*?'::jsonb\)/,"jsonb_to_recordset('"+JSON.stringify(fixture)+"'::jsonb)");
 await db.exec('do $$ begin\n'+bound+'\nend $$;');
 for(const change of ["name='changed'","statements=array['select 2']","version='20260101000001'"]){await db.exec('begin;update supabase_migrations.schema_migrations set '+change+';commit;');await assert.rejects(()=>db.exec('do $$ begin\n'+bound+'\nend $$;'),/RATINGS_FULL_LEDGER_DRIFT/);await db.exec("delete from supabase_migrations.schema_migrations;insert into supabase_migrations.schema_migrations values('20260101000000','fixture',array['select 1'])");}
 await db.exec('delete from supabase_migrations.schema_migrations');
});
await db.exec("insert into vault.decrypted_secrets values('project_url','https://wrong.invalid')");
await check('exact environment preflight rejects foreign target',async()=>{await assert.rejects(()=>db.exec(local(env+'/preflight.sql')),/RATINGS_ENVIRONMENT_MISMATCH/);});
await db.exec('delete from vault.decrypted_secrets');await db.query("insert into vault.decrypted_secrets values('project_url',$1)",['https://'+evidence.projectRef+'.supabase.co']);
await hdr03Checks(db,check,env);
const ids=Array.from({length:5},()=>randomUUID()),[seller,buyer,outsider,admin,mod]=ids;
for(const u of ids)await db.query("insert into auth.users(id,email) values($1,'fixture@example.invalid')",[u]);
await db.query("insert into public.staff_roles(user_id,role) values($1,'administrator'),($2,'moderator')",[admin,mod]);
for(const m of JSON.parse(local('migration-order.json')))await db.exec(local(env+'/supabase/migrations/'+m.file));
await check('all six apply after onboarding and mobile foundation, flags default OFF',async()=>{assert.equal(await q('select count(*)::int from app_security.ratings_settings where enabled or public_reads or jobs_enabled or staff_enabled'),0);assert(await q("select to_regprocedure('public.ratings_given_history(timestamptz,uuid)') is not null"));});
await check('sold, staff helper, Admin wrapper and all mobile functions/ACLs remain exact',async()=>{
 const after=(await db.query(`select oid::regprocedure::text signature,prosrc,proacl::text acl from pg_proc where pronamespace in ('public'::regnamespace,'app_security'::regnamespace) order by 1`)).rows;
 for(const old of protectedBefore){if(old.signature==='app_security.impl_fulfill_data_export(uuid)')continue;const current=after.find(x=>x.signature===old.signature);assert.deepEqual(current,old,old.signature);}
 assert.deepEqual(await mobileSnapshot(),mobileBefore);
});
await check('inactive schedules retry safely and preserve unrelated active job',async()=>{await db.exec("select cron.schedule('unrelated','* * * * *','select 1')");await db.exec(local(env+'/inactive.sql'));await db.exec(local(env+'/inactive.sql'));assert.equal(await q("select count(*)::int from cron.job where jobname like 'ratings-v1-%' and not active"),2);assert.equal(await q("select active from cron.job where jobname='unrelated'"),true);});
await db.query("select set_config('request.user',$1,false),set_config('request.aal',$2,false)",[seller,'aal1']);
const request=await q("insert into public.privacy_requests(user_id,request_type) values($1,'export_data') returning id",[seller]);
await db.query("insert into public.user_private_details(user_id,full_name) values($1,'Private fixture name')",[seller]);
await check('owner export retains private_details, appends ratings and audits once',async()=>{await login(seller);const data=await q('select public.admin_fulfill_data_export($1)',[request]);assert.equal(data.private_details.full_name,'Private fixture name');assert(data.ratings);assert('policy_acceptances' in data);await owner();assert.equal(await q("select count(*)::int from public.audit_logs where action='privacy.export_fulfilled' and target_id=$1",[request]),1);});
await check('outsider, moderator AAL2 and administrator AAL1 cannot export another account',async()=>{for(const [u,aal] of [[outsider,'aal2'],[mod,'aal2'],[admin,'aal1']]){await login(u,aal);await assert.rejects(()=>q('select public.admin_fulfill_data_export($1)',[request]),/Forbidden|not authorized|permission denied/);}});
await check('administrator AAL2 export succeeds without restoring direct private base access',async()=>{await login(admin,'aal2');assert((await q('select public.admin_fulfill_data_export($1)',[request])).ratings);for(const sig of ['ratings_export_base','impl_fulfill_data_export_base'])await assert.rejects(()=>q(`select app_security.${sig}($1)`,[request]),/permission denied/);});
await owner();
await check('staff helper denies AAL1 and Ratings staff flag OFF, allows only role/AAL2 when separately enabled in fixture',async()=>{
 await login(admin,'aal1');assert.equal(await q("select app_security.is_active_staff_aal2('moderator')"),false);
 await login(mod,'aal2');assert.equal(await q("select app_security.is_active_staff_aal2('moderator')"),true);
 await assert.rejects(()=>q("select public.admin_ratings_cases('dispute')"),/RATINGS_STAFF_DISABLED/);
 await owner();await db.exec('update app_security.ratings_settings set staff_enabled=true');
 await login(mod,'aal1');await assert.rejects(()=>q("select public.admin_ratings_cases('dispute')"),/RATINGS_ACCESS_DENIED/);
 await login(mod,'aal2');assert.deepEqual((await q("select public.admin_ratings_cases('dispute')")).items,[]);
 await owner();await db.exec('update app_security.ratings_settings set staff_enabled=false');
});
await check('mobile posting category and guard coexist with sold transition and Ratings OFF',async()=>{
 const l=randomUUID();await db.query("insert into public.listings(id,seller_id,category_id,city_id,title,price_type,price_paise) select $1,$2,listing_category_id,(select id from public.cities limit 1),'Mobile fixture','fixed',10000 from public.posting_category_definitions",[l,seller]);
 await db.query("update public.listings set status='sold' where id=$1",[l]);assert.equal(await q('select count(*)::int from public.rating_trades'),0);
 // Trigger and content guard remain enforced for invalid generic edits.
 await assert.rejects(()=>db.query("update public.listings set price_paise=0 where id=$1",[l]),/Sell requires/);
});
await check('environment rollback leaves unrelated cron active and onboarding erasure works with flags OFF',async()=>{await db.exec(local(env+'/rollback-disable.sql'));assert.equal(await q("select active from cron.job where jobname='unrelated'"),true);await db.query("update public.user_accounts set account_status='deletion_pending' where user_id=$1",[seller]);assert.equal(await q('select count(*)::int from public.user_private_details where user_id=$1',[seller]),0);});
console.log(`PASS ${count} hosted-readiness assumptions on disposable PG17 (${env}); real pg_cron/Storage/Auth/87-71 full chains NOT RUN`);
