// Read-only release preparation. No apply/up/push/reset/repair or hosted SQL writes.
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,existsSync,realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export const VERSION='20261031110408';
export const NAME='fsw_sec_003_public_search_hardening';
export const FILE=`${VERSION}_${NAME}.sql`;
export const SHA='b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd';
// Genuine CLI 2.117.0 statement serialization measured in a fresh PG17.6 fixture.
export const LEDGER_SHA='9cc72ec137f4078b39e1c57065592ec008a63afae2a6b85cc8b06aa206b29c15';
export const refs={FairSwapTest:'wpppxlnbzqynvhpeuavd',FairSwapProd:'kriuhwppxgxsyyrbjsau'};
const repo=fileURLToPath(new URL('../../',import.meta.url));
const candidate=path.join(repo,'releases/candidates/fsw-sec-003/supabase/migrations',FILE);
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const canonical=sql=>sql.replace(/^[\s;]+|[\s;]+$/g,'');
export function verifyCandidate(bytes=readFileSync(candidate)) {assert.equal(sha(bytes),SHA,'reviewed migration SHA-256 mismatch');}
export function verifyCapture(env,capture,now=Date.now()) {
 assert.ok(Object.hasOwn(refs,env),'explicit Test/Prod environment required');
 assert.ok(Number.isFinite(Date.parse(capture.capturedAt)) && now-Date.parse(capture.capturedAt)>=-30000 && now-Date.parse(capture.capturedAt)<=15*60*1000,'fresh metadata capture (<=15 minutes) required');
 assert.equal(capture.tls,true,'verified TLS required');
 assert.match(capture.serverVersion,/^17\d{4}$/,'PostgreSQL 17 target required');
 const {host,user,port}=capture.connection;
 assert.equal(String(port),'5432','session/direct connection required');
 assert.ok(host===`db.${refs[env]}.supabase.co`&&user==='postgres' || /^[a-zA-Z0-9.-]+\.pooler\.supabase\.com$/.test(host)&&user===`postgres.${refs[env]}`,'environment endpoint/user mismatch');
 assert.ok(Array.isArray(capture.ledger)&&capture.ledger.length>0,'nonempty full ledger required');
 const versions=capture.ledger.map(x=>x.version);
 assert.deepEqual(versions,[...new Set(versions)].sort(),'unique sorted ledger required');
 for(const row of capture.ledger) {assert.match(row.version,/^\d{14}$/);assert.match(row.name,/^[a-zA-Z0-9_-]+$/);assert.match(row.statementsSha256,/^[a-f0-9]{64}$/);}
 assert.equal(capture.functions?.length,2,'both RPC functions required');
 for(const fn of capture.functions) {
  assert.equal(fn.volatility,'s');assert.deepEqual(fn.config,['search_path=""']);assert.equal(fn.returnType,'jsonb');
  assert.equal(fn.definer,fn.schema==='app_security'); assert.equal(fn.owner,'postgres','reviewed function owner required');
  assert.equal(fn.acl,'{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}','reviewed execute ACL required');
  const params=['query','category_id','category_slug','city_id','locality_id','condition','price_min','price_max','sort','page','per_page'];
  assert.deepEqual(fn.argNames,params.map(x=>fn.schema==='app_security'?'p_'+x:x),'RPC argument names changed');
  assert.ok(!/(^|[,{])=X\//.test(fn.acl),'PUBLIC execute forbidden');
 }
 assert.deepEqual(capture.functions.map(x=>x.schema).sort(),['app_security','public']);
 assert.deepEqual(capture.security?.map(x=>x.table).sort(),['categories','cities','listing_media','listings','localities','user_accounts']);
 assert.ok(capture.security.filter(x=>['listings','user_accounts'].includes(x.table)).every(x=>x.rls),'visibility-table RLS required');
 // PostgREST's effective process config is not universally available in pg_settings.
 // Never turn missing evidence into an assertion that the private schema is hidden.
 if(capture.exposedSchemas!=null) assert.ok(!capture.exposedSchemas.split(/[, ]+/).includes('app_security'),'private schema exposed');
}
export function verifyHistory(capture,dir,pending=false) {
 const actual=readdirSync(dir).filter(x=>x.endsWith('.sql')).sort();
 const expected=[...capture.ledger.map(x=>`${x.version}_${x.name}.sql`),...(pending?[FILE]:[])].sort();
 if(pending) verifyCandidate(readFileSync(path.join(dir,FILE)));
 assert.deepEqual(actual,expected,'CLI-fetched filenames must exactly match this environment ledger');
 for(const row of capture.ledger) assert.equal(sha(canonical(readFileSync(path.join(dir,`${row.version}_${row.name}.sql`),'utf8'))),row.statementsSha256,'fetched SQL differs from genuine ledger statements');
}
export function verifyPreflight(env,approved,fresh) {
 verifyCandidate();verifyCapture(env,approved);verifyCapture(env,fresh);
 assert.deepEqual(fresh.ledger,approved.ledger,'independent fresh ledger changed');
 assert.deepEqual(fresh.functions,approved.functions,'RPC metadata drift');
 assert.deepEqual(fresh.security,approved.security,'ACL/RLS drift');
 assert.equal(fresh.exposedSchemas,approved.exposedSchemas,'exposed schema configuration drift');
 assert.ok(!fresh.ledger.some(x=>x.version===VERSION),'candidate already applied');
 assert.ok(fresh.ledger.every(x=>x.version<VERSION),'candidate must follow every applied version');
 assert.equal(fresh.functions.find(x=>x.schema==='public').bodyMd5,env==='FairSwapTest'?'821f536ad89962bc345586f175c86d23':'150b3b0298c05e2eb9733bd010e6f5a2','public wrapper drift');
 assert.equal(fresh.functions.find(x=>x.schema==='app_security').bodyMd5,'0ccc07eede6a6fa06b30acc06d9cdc10','private implementation drift');
}
export function verifyPostflight(env,before,after,now=Date.now()) {
 verifyCandidate();verifyCapture(env,after,now);
 // The preflight receipt is older after deployment but must still have a valid target identity.
 verifyCapture(env,before,Date.parse(before.capturedAt));
 const old=after.ledger.filter(x=>x.version!==VERSION);
 assert.deepEqual(old,before.ledger,'prior migration history changed');
 const added=after.ledger.filter(x=>x.version===VERSION);
 assert.equal(added.length,1,'exactly one CLI candidate ledger entry required');assert.equal(added[0].name,NAME);
 assert.equal(added[0].statementsSha256,LEDGER_SHA,'applied CLI SQL differs from reviewed candidate');
 assert.deepEqual(after.security,before.security,'ACL/RLS/column privileges/policies changed');
 assert.equal(after.exposedSchemas,before.exposedSchemas,'exposed schemas changed');
 const body=readFileSync(candidate,'utf8').split('AS $$')[1].split('$$;')[0];
 for(const fn of before.functions) {
  const next=after.functions.find(x=>x.schema===fn.schema);
  const oldMeta={...fn},newMeta={...next};
  if(fn.schema==='app_security') {
   assert.equal(next.bodySha256,sha(body),'installed implementation differs');
   delete oldMeta.bodySha256;delete newMeta.bodySha256;delete oldMeta.bodyMd5;delete newMeta.bodyMd5;
  }
  assert.deepEqual(newMeta,oldMeta,'function owner/ACL/signature/security or public wrapper changed');
 }
}
export function verifyDryRun(text) {
 const names=[...new Set(text.match(/\b\d{14}_[a-zA-Z0-9_-]+\.sql\b/g)??[])];
 assert.deepEqual(names,[FILE],'dry-run must report precisely the reviewed pending migration');
}
export function verifyStagingReceipt(receipt) {
 assert.equal(receipt.environment,'FairSwapTest');assert.equal(receipt.projectRef,refs.FairSwapTest);
 assert.equal(receipt.status,'PASS');assert.equal(receipt.sha256,SHA);
 verifyPostflight('FairSwapTest',receipt.before,receipt.after);
}
function capture(env,service,psql) {
 assert.ok(Object.hasOwn(refs,env));assert.equal(service,env,'use distinct environment-named libpq services');
 // Existing PGSERVICEFILE carries credentials; neither argv nor outputs contain a password.
 const text=execFileSync(psql,['-XqAt','-v','ON_ERROR_STOP=1','-d',`service=${service} sslmode=verify-full connect_timeout=10`,'-f',path.join(repo,'tests/fsw-sec-003/capture-release.sql')],{encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
 const result=JSON.parse(text);verifyCapture(env,result);return result;
}
function save(file,value) {writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});}
async function main(args) {
 const [mode,env,...rest]=args;
 if(mode==='prepare'&&(rest.length===4||rest.length===5)) {
  const [psql,cli,workspace,receipt,staging]=rest;
  if(env==='FairSwapProd') {assert.ok(staging,'successful Test postflight receipt required before Production preparation');verifyStagingReceipt(JSON.parse(readFileSync(staging)));}
  else assert.equal(rest.length,4);
  assert.ok(path.isAbsolute(workspace)&&!existsSync(workspace),'fresh absolute workspace required');
  verifyCandidate();const first=capture(env,env,psql);
  assert.ok(!first.ledger.some(x=>x.version===VERSION));
  mkdirSync(workspace,{mode:0o700});
  const run=cmd=>{
   const r=spawnSync(cli,[...cmd,'--workdir',workspace],{encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
   if(r.error||r.status!==0) throw Error('read-only CLI preparation failed');
   return r.stdout+'\n'+r.stderr;
  };
  assert.match(execFileSync(cli,['--version'],{encoding:'utf8'}),/^2\.117\.0\b/,'reviewed CLI required');
  run(['init']);run(['link','--project-ref',refs[env]]);
  assert.equal(readFileSync(path.join(workspace,'supabase/.temp/project-ref'),'utf8').trim(),refs[env]);
  run(['migration','fetch','--linked']);
  const dir=path.join(workspace,'supabase/migrations');verifyHistory(first,dir);
  const second=capture(env,env,psql);verifyPreflight(env,first,second);
  copyFileSync(candidate,path.join(dir,FILE));
  verifyHistory(first,dir,true);
  verifyDryRun(run(['db','push','--linked','--dry-run']));
  save(receipt,{environment:env,projectRef:refs[env],sha256:SHA,workspace:realpathSync(workspace),before:second});
  console.log('PASS prepared isolated '+env+' candidate; no hosted writes');
 } else if(mode==='preflight'&&rest.length===2) {
  const [psql,receipt]=rest;const pre=JSON.parse(readFileSync(receipt));
  assert.equal(pre.environment,env);assert.equal(pre.projectRef,refs[env]);assert.equal(pre.sha256,SHA);
  verifyHistory(pre.before,path.join(pre.workspace,'supabase/migrations'),true);
  verifyPreflight(env,pre.before,capture(env,env,psql));console.log('PASS fresh '+env+' preflight; no hosted writes');
 } else if(mode==='postflight'&&rest.length===3) {
  const [psql,receipt,output]=rest;const pre=JSON.parse(readFileSync(receipt));
  assert.equal(pre.environment,env);assert.equal(pre.projectRef,refs[env]);assert.equal(pre.sha256,SHA);
  const after=capture(env,env,psql);verifyPostflight(env,pre.before,after);
  save(output,{status:'PASS',environment:env,projectRef:refs[env],sha256:SHA,before:pre.before,after});console.log('PASS '+env+' metadata postflight');
 } else throw Error('Use prepare <FairSwapTest|FairSwapProd> <psql> <CLI> <fresh absolute workspace> <new receipt.json> [Test postflight receipt required for Prod], preflight <environment> <psql> <preflight receipt>, or postflight <environment> <psql> <preflight receipt> <new output.json>');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{await main(process.argv.slice(2));}catch(e){console.error('FAIL release gate:',e.message);process.exitCode=1;}
}
