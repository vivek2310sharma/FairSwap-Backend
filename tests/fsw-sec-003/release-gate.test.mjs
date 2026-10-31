import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VERSION,NAME,FILE,SHA,LEDGER_SHA,refs,sha,canonical,verifyCapture,verifyCandidate,verifyPreflight,verifyPostflight,verifyHistory,verifyDryRun,verifyStagingReceipt} from './release-gate.mjs';
const params=['query','category_id','category_slug','city_id','locality_id','condition','price_min','price_max','sort','page','per_page'];
const snapshot=(env='FairSwapTest')=>({
 capturedAt:new Date().toISOString(),tls:true,serverVersion:'170006',exposedSchemas:null,
 connection:{host:`db.${refs[env]}.supabase.co`,user:'postgres',port:'5432'},
 ledger:[{version:'20260914000001',name:'synthetic_fixture',statementsSha256:sha('select 1')}],
 functions:['app_security','public'].map(schema=>({schema,name:schema==='public'?'search_public_listings':'impl_search_public_listings',owner:'postgres',acl:'{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}',argNames:params.map(x=>schema==='public'?x:'p_'+x),args:'synthetic signature',identityArgs:'synthetic types',returnType:'jsonb',definer:schema==='app_security',volatility:'s',config:['search_path=""'],bodyMd5:schema==='app_security'?'0ccc07eede6a6fa06b30acc06d9cdc10':env==='FairSwapTest'?'821f536ad89962bc345586f175c86d23':'150b3b0298c05e2eb9733bd010e6f5a2',bodySha256:sha(schema)})),
 security:['categories','cities','listing_media','listings','localities','user_accounts'].map(table=>({table,rls:true,acl:'synthetic'})),
});
const clone=x=>structuredClone(x);
const sql=readFileSync(new URL('../../releases/candidates/fsw-sec-003/supabase/migrations/'+FILE,import.meta.url),'utf8');
function installed(before) {const after=clone(before);after.ledger.push({version:VERSION,name:NAME,statementsSha256:LEDGER_SHA});const fn=after.functions[0];fn.bodySha256=sha(sql.split('AS $$')[1].split('$$;')[0]);fn.bodyMd5='installed';return after;}
test('reviewed migration SHA pin',()=>{verifyCandidate();assert.throws(()=>verifyCandidate(Buffer.from(sql+'\n')));});
for(const env of Object.keys(refs)) test(env+' independent preflight and postflight',()=>{const b=snapshot(env);verifyPreflight(env,b,clone(b));verifyPostflight(env,b,installed(b));});
for(const [label,mutate] of [
 ['wrong environment',x=>{x.connection.host=`db.${refs.FairSwapProd}.supabase.co`;}],
 ['stale capture',x=>{x.capturedAt='2000-01-01Z';}],
 ['future capture',x=>{x.capturedAt='2099-01-01Z';}],
 ['no TLS',x=>{x.tls=false;}],
 ['wrong PG major',x=>{x.serverVersion='180003';}],
 ['transaction pooler',x=>{x.connection.port='6543';}],
 ['public EXECUTE',x=>{x.functions[0].acl='{=X/postgres}';}],
 ['owner change',x=>{x.functions[0].owner='other';}],
 ['argument names',x=>{x.functions[1].argNames[0]='q';}],
 ['invoker private implementation',x=>{x.functions[0].definer=false;}],
 ['mutable function',x=>{x.functions[0].volatility='v';}],
 ['unsafe search_path',x=>{x.functions[0].config=['search_path=public'];}],
 ['disabled RLS',x=>{x.security.find(t=>t.table==='listings').rls=false;}],
 ['private schema exposure',x=>{x.exposedSchemas='public,app_security';}],
 ['duplicate ledger',x=>{x.ledger.push(x.ledger[0]);}],
 ['incomplete ledger digest',x=>{delete x.ledger[0].statementsSha256;}],
]) test('reject '+label,()=>{const b=snapshot();mutate(b);assert.throws(()=>verifyCapture('FairSwapTest',b));});
for(const [label,mutate] of [
 ['added ledger history',x=>{x.ledger.push({version:'20261030000000',name:'added',statementsSha256:sha('select 2')});}],
 ['changed old name',x=>{x.ledger[0].name='changed';}],
 ['implementation drift',x=>{x.functions[0].bodyMd5='changed';}],
 ['public wrapper drift',x=>{x.functions[1].bodyMd5='changed';}],
 ['column ACL drift',x=>{x.security[0].acl='changed';}],
]) test('preflight rejects '+label,()=>{const b=snapshot(),f=clone(b);mutate(f);assert.throws(()=>verifyPreflight('FairSwapTest',b,f));});
for(const [label,mutate] of [
 ['missing candidate',x=>{x.ledger.pop();}],
 ['extra migration',x=>{x.ledger.push({version:'20261101000000',name:'extra',statementsSha256:sha('select 2')});}],
 ['altered old SQL',x=>{x.ledger[0].statementsSha256=sha('altered');}],
 ['wrong installed bytes',x=>{x.ledger[1].statementsSha256=sha('wrong');}],
 ['RLS policy drift',x=>{x.security[0].policies=['changed'];}],
 ['function ACL drift',x=>{x.functions[0].acl='changed';}],
 ['public wrapper changed',x=>{x.functions[1].bodySha256=sha('changed');}],
 ['wrong implementation',x=>{x.functions[0].bodySha256=sha('wrong');}],
]) test('postflight rejects '+label,()=>{const b=snapshot(),a=installed(b);mutate(a);assert.throws(()=>verifyPostflight('FairSwapTest',b,a));});
test('authentic fetched file contents, names and membership',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fsw-search-history-'));
 try {
  const file=path.join(dir,'20260914000001_synthetic_fixture.sql');const b=snapshot();
  writeFileSync(file,'select 1;\n');verifyHistory(b,dir);
  writeFileSync(file,'-- fabricated placeholder');assert.throws(()=>verifyHistory(b,dir));
  writeFileSync(file,'select 1;\n');writeFileSync(path.join(dir,FILE),sql);assert.throws(()=>verifyHistory(b,dir));
 } finally {rmSync(dir,{recursive:true});}
});
test('precisely one reviewed pending filename in CLI dry-run',()=>{
 verifyDryRun('Would push these migrations:\n • '+FILE);
 for(const text of ['', 'Would push: 20261101000000_extra.sql',FILE+'\n20261101000000_extra.sql']) assert.throws(()=>verifyDryRun(text));
});
test('required CI gate and pinned dependencies cannot silently skip search',()=>{
 const ci=readFileSync(new URL('../../.github/workflows/backend-ci.yml',import.meta.url),'utf8');
 assert.ok(ci.includes('needs: [unit-integrity, database-pg15, ratings-native-pg17, ratings-hosted-readiness-pg17]'));
 assert.ok(ci.includes('node tests/fsw-sec-003/run-disposable.mjs'));
 assert.ok(ci.includes('tests/ratings/node_modules/@electric-sql/pglite/dist/index.js'));
 assert.ok(ci.includes('bash tests/fsw-sec-003/run-native.sh'));
 assert.ok(ci.includes('node tests/fsw-sec-003/install-postgrest.mjs'));
 assert.ok(ci.includes('node tests/fsw-sec-003/cli-rehearsal.mjs'));
 assert.ok(ci.includes('run: bash scripts/release/install-inbox-cli.sh'));
 const unit=ci.slice(ci.indexOf('  unit-integrity:'),ci.indexOf('  database-pg15:'));
 const nativeJob=ci.slice(ci.indexOf('  ratings-native-pg17:'),ci.indexOf('  ratings-hosted-readiness-pg17:'));
 assert.ok(unit.includes('node tests/fsw-sec-003/run-disposable.mjs'));
 assert.ok(nativeJob.includes('bash tests/fsw-sec-003/run-native.sh'));
 assert.ok(nativeJob.includes('node tests/fsw-sec-003/cli-rehearsal.mjs'));
 assert.ok(!unit.includes('continue-on-error:')&&!nativeJob.includes('continue-on-error:'));
 const native=readFileSync(new URL('./run-native.sh',import.meta.url),'utf8');
 assert.ok(native.includes('17.6'));assert.ok(native.includes('await verifyHttp'));assert.ok(native.includes('set -euo pipefail'));
});

test('pending workspace requires the exact reviewed artifact and genuine history',()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'fsw-search-pending-'));
 try {
  writeFileSync(path.join(dir,'20260914000001_synthetic_fixture.sql'),'select 1;');
  writeFileSync(path.join(dir,FILE),sql);verifyHistory(snapshot(),dir,true);
  writeFileSync(path.join(dir,FILE),sql+'\n');assert.throws(()=>verifyHistory(snapshot(),dir,true));
 } finally {rmSync(dir,{recursive:true});}
});
test('Production preparation requires matching successful Test postflight evidence',()=>{
 const b=snapshot();const receipt={status:'PASS',environment:'FairSwapTest',projectRef:refs.FairSwapTest,sha256:SHA,before:b,after:installed(b)};
 verifyStagingReceipt(receipt);
 for(const mutate of [x=>{x.status='FAIL';},x=>{x.environment='FairSwapProd';},x=>{x.sha256='wrong';},x=>{x.after.ledger.pop();}]) {
  const r=clone(receipt);mutate(r);assert.throws(()=>verifyStagingReceipt(r));
 }
});
