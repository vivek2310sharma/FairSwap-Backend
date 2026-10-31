// Protected release only; importing this module never connects or writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {VERSION,FILE,SHA,refs,sha,verifyCandidate,verifyCapture,verifyHistory,verifyPreflight,verifyPostflight,verifyDryRun} from '../../tests/fsw-sec-003/release-gate.mjs';
import {auditProtection,requireOwnerActors} from './inbox-protection.mjs';
import {X509Certificate} from 'node:crypto';
// Same PEM/CA/time validation as the Chat tool without importing Chat SQL/dependencies.
function validateRootCertificate(value) {
 need(typeof value==='string'&&value.length>0&&value.length<=65536,'TLS_ROOT_CERT_REQUIRED');
 const pem=value.trim().replaceAll('\r\n','\n')+'\n';
 need(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/.test(pem),'TLS_ROOT_CERT_INVALID');
 const cert=new X509Certificate(pem);
 need(cert.ca&&Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now(),'TLS_ROOT_CERT_INVALID');
 return pem;
}

const root=fileURLToPath(new URL('../../',import.meta.url));
const candidate=join(root,'releases/candidates/fsw-sec-003/supabase/migrations',FILE);
const need=(condition,code)=>{if(!condition)throw Error('FSW_'+code);};
// Explicit owner risk acceptance for this candidate only (Backend PR #75).
// Independent literals prevent a future candidate/ref change from inheriting the waiver.
export function backupWaiver(environment,{candidateSha256=SHA,projectRef=refs[environment],version=VERSION,file=FILE}={}) {
 const approvedRefs={FairSwapTest:'wpppxlnbzqynvhpeuavd',FairSwapProd:'kriuhwppxgxsyyrbjsau'};
 need(Object.hasOwn(approvedRefs,environment)&&projectRef===approvedRefs[environment],'BACKUP_WAIVER_TARGET_REQUIRED');
 need(candidateSha256==='b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd'&&
  version==='20261031110408'&&file==='20261031110408_fsw_sec_003_public_search_hardening.sql','BACKUP_WAIVER_CANDIDATE_REQUIRED');
 return {status:'WAIVED_BY_OWNER',environment,projectRef,sha256:candidateSha256,version,file,
  authorization:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/75',
  scope:['provider-managed-backup','backup-dependent-restore']};
}
export function authorize(environment,c) {
 try{requireOwnerActors(c);}catch{throw Error('FSW_OWNER_DISPATCH_REQUIRED');}
 need(Object.hasOwn(refs,environment),'ENVIRONMENT_REQUIRED');
 need(c.GITHUB_REPOSITORY==='vivek2310sharma/FairSwap-Backend'&&c.GITHUB_REF==='refs/heads/main'&&c.FSW_ENVIRONMENT===environment,'OWNER_MAIN_ENVIRONMENT_REQUIRED');
 need(/^[a-f0-9]{40}$/.test(c.GITHUB_SHA??'')&&c.APPROVED_SHA===c.GITHUB_SHA,'REVIEWED_COMMIT_REQUIRED');
 need(/^[1-9][0-9]*$/.test(c.GITHUB_RUN_ID??'')&&/^[1-9][0-9]*$/.test(c.GITHUB_RUN_ATTEMPT??''),'RUN_ID_REQUIRED');
 need(c.FSW_RELEASE_ENABLED==='true','RELEASE_DISABLED');
 verifyCandidate();
 backupWaiver(environment);
}
function binding(environment,c) {return {environment,projectRef:refs[environment],sourceCommit:c.GITHUB_SHA,runId:c.GITHUB_RUN_ID,runAttempt:c.GITHUB_RUN_ATTEMPT,sha256:SHA,version:VERSION};}
export function verifyTestReceipt(bytes,expectedHash,c,now=Date.now()) {
 need(/^[a-f0-9]{64}$/.test(expectedHash??'')&&sha(bytes)===expectedHash,'TEST_RECEIPT_CHECKSUM_REQUIRED');
 const r=JSON.parse(bytes);
 for(const [key,value] of Object.entries(binding('FairSwapTest',c)))need(r[key]===value,'SAME_RUN_TEST_RECEIPT_REQUIRED');
 need(r.migrationAttempted===true&&r.phase==='postflight','COMPLETED_TEST_MIGRATION_REQUIRED');
 need(r.schema===1&&r.status==='PASS'&&r.postflight===true&&r.cliVersion==='2.117.0'&&r.tls==='verify-full','SUCCESSFUL_TEST_RECEIPT_REQUIRED');
 need(Number.isFinite(Date.parse(r.completedAt))&&now-Date.parse(r.completedAt)>=0&&now-Date.parse(r.completedAt)<=24*3600000,'FRESH_TEST_RECEIPT_REQUIRED');
 for(const key of ['beforeSha256','afterSha256','schemaSecuritySha256','protectionSha256','authoritySha256','exposureSha256'])need(/^[a-f0-9]{64}$/.test(r[key]??''),'COMPLETE_TEST_RECEIPT_REQUIRED');
 assert.deepEqual(r.backupRecovery,backupWaiver('FairSwapTest'),'owner waiver scope/status must match');
 return r;
}
async function getJson(url,token,fetcher,code) {
 need(typeof token==='string'&&token.length>0,code+'_CREDENTIAL_REQUIRED');
 try {
  const r=await fetcher(url,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
  need(r.ok===true&&!/rel\s*=\s*"?next\b/i.test(r.headers.get('link')??''),code+'_READ_PERMISSION_OR_COMPLETE_RESPONSE_REQUIRED');
  return await r.json();
 } catch {throw Error('FSW_'+code+'_READ_PERMISSION_OR_COMPLETE_RESPONSE_REQUIRED');}
}
export async function exposure(environment,token,fetcher=fetch) {
 need(Object.hasOwn(refs,environment),'ENVIRONMENT_REQUIRED');
 const config=await getJson(`https://api.supabase.com/v1/projects/${refs[environment]}/postgrest`,token,fetcher,'POSTGREST_CONFIG');
 // Only the nonsecret exposure allowlist survives; never hash/log/persist raw config.
 need(typeof config?.db_schema==='string','EFFECTIVE_EXPOSURE_UNKNOWN');
 const schemas=config.db_schema.split(',').map(x=>x.trim()).sort();
 need(schemas.length===1&&schemas[0]==='public','PUBLIC_ONLY_DATA_API_REQUIRED');
 return {projectRef:refs[environment],schemas};
}
export async function requireCi(c,fetcher=fetch) {
 const data=await getJson(`https://api.github.com/repos/${c.GITHUB_REPOSITORY}/actions/workflows/backend-ci.yml/runs?head_sha=${c.GITHUB_SHA}&branch=main&event=push&per_page=100`,c.GITHUB_TOKEN,fetcher,'CI');
 need(Number.isInteger(data.total_count)&&data.total_count>0&&data.total_count===data.workflow_runs?.length,'COMPLETE_CI_EVIDENCE_REQUIRED');
 const latest=data.workflow_runs[0];
 need(latest.head_sha===c.GITHUB_SHA&&latest.head_branch==='main'&&latest.status==='completed'&&latest.conclusion==='success','SUCCESSFUL_EXACT_COMMIT_CI_REQUIRED');
}
// The existing reviewed per-environment record remains mandatory for writer authority.
// The owner waived only backup/restore, never exclusive authority or its evidence.
export function recovery(environment,bytes,now=Date.now()) {
 backupWaiver(environment);
 let r;try{r=JSON.parse(bytes);}catch{throw Error('FSW_REVIEWED_AUTHORITY_EVIDENCE_REQUIRED');}
 need(r&&r.environment===environment&&r.projectRef===refs[environment]&&r.sha256===SHA&&r.status==='PASS','AUTHORITY_TARGET_REQUIRED');
 need(Number.isFinite(Date.parse(r.verifiedAt))&&now-Date.parse(r.verifiedAt)>=0&&now-Date.parse(r.verifiedAt)<=24*3600000,'FRESH_AUTHORITY_EVIDENCE_REQUIRED');
 for(const key of ['privilegedWriterInventorySha256','retiredWriterProofSha256'])need(/^[a-f0-9]{64}$/.test(r[key]??''),'EXCLUSIVE_AUTHORITY_PROOF_REQUIRED');
 need(r.exclusiveBackendAuthority===true,'EXCLUSIVE_AUTHORITY_REQUIRED');
 return sha(bytes);
}
const schemaSql=`BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text,
 'rolePrivileges',(SELECT jsonb_agg(jsonb_build_object('role',r,'usage',has_schema_privilege(r,n.oid,'USAGE'),'create',has_schema_privilege(r,n.oid,'CREATE')) ORDER BY r) FROM unnest(ARRAY['anon','authenticated','service_role']) r)) ORDER BY n.nspname)
FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public','app_security');
COMMIT;`;
export function verifySchemas(value) {
 need(Array.isArray(value)&&value.length===2&&value.map(x=>x.schema).sort().join(',')==='app_security,public','SCHEMA_SECURITY_REQUIRED');
 for(const s of value) {
  need(typeof s.owner==='string'&&s.owner.length>0&&Array.isArray(s.rolePrivileges)&&s.rolePrivileges.length===3,'SCHEMA_SECURITY_REQUIRED');
  need(s.rolePrivileges.map(x=>x.role).sort().join(',')==='anon,authenticated,service_role','SCHEMA_ROLES_REQUIRED');
  need(s.rolePrivileges.filter(x=>x.role!=='service_role').every(x=>x.create===false),'CLIENT_SCHEMA_CREATE_FORBIDDEN');
 }
}
export async function release(environment,{context: c=process.env,fetcher=fetch,runner,protection=auditProtection,recoveryBytes,testReceiptBytes,receiptDir=resolve('fsw-release-receipt')}={}) {
 let phase='authorization',attempted=false,privateDir;
 const receipt={schema:1,status:'FAIL',...binding(environment,c)};
 const run=(binary,args,env,input)=>{
  try{return runner?runner(binary,args,env,input):execFileSync(binary,args,{env,input,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000,maxBuffer:16*1024*1024});}
  catch {throw Error('FSW_SUBPROCESS_'+phase.toUpperCase()+'_FAILED_RECOVERY_REVIEW_REQUIRED');}
 };
 try {
  authorize(environment,c);
  receipt.backupRecovery=backupWaiver(environment);
  if(environment==='FairSwapProd')verifyTestReceipt(testReceiptBytes??readFileSync(resolve('test-evidence/receipt.json')),c.TEST_RECEIPT_SHA,c);
  phase='ci';await requireCi(c,fetcher);
  phase='protection';let p;
  try{p=await protection(environment,c.CHAT_RELEASE_AUDIT_TOKEN,fetcher,{sourceCommit:c.GITHUB_SHA,bundleSha256:SHA,actor:c.GITHUB_ACTOR,triggeringActor:c.GITHUB_TRIGGERING_ACTOR});}
  catch(error){throw Error(/^CHAT_[A-Z_]+$/.test(error?.message??'')?'FSW_PROTECTION_'+error.message:'FSW_PROTECTION_UNVERIFIABLE');}
  receipt.protectionSha256=p.snapshotSha256;
  phase='authority';
  if(recoveryBytes===undefined){try{recoveryBytes=readFileSync(join(root,'releases/candidates/fsw-sec-003/recovery',environment+'.json'));}catch{throw Error('FSW_REVIEWED_AUTHORITY_EVIDENCE_REQUIRED');}}
  receipt.authoritySha256=recovery(environment,recoveryBytes);
  phase='exposure';const exposed=await exposure(environment,c.SUPABASE_ACCESS_TOKEN,fetcher);receipt.exposureSha256=sha(JSON.stringify(exposed));
  need(c.CHAT_DATABASE_PASSWORD&&c.CHAT_DB_SSL_ROOT_CERT_PEM,'EXISTING_DATABASE_CREDENTIAL_REQUIRED');
  need(/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(c.CHAT_DB_POOLER_HOST??''),'SESSION_POOLER_HOST_REQUIRED');
  privateDir=mkdtempSync(join(tmpdir(),'fsw-sec-003-'));chmodSync(privateDir,0o700);
  const cert=join(privateDir,'root.crt');writeFileSync(cert,validateRootCertificate(c.CHAT_DB_SSL_ROOT_CERT_PEM),{flag:'wx',mode:0o600});
  const env={PATH:c.PATH,HOME:privateDir,NO_COLOR:'1',PGSSLMODE:'verify-full',PGSSLROOTCERT:cert,PGCONNECT_TIMEOUT:'10',PGPASSWORD:c.CHAT_DATABASE_PASSWORD,SUPABASE_DB_PASSWORD:c.CHAT_DATABASE_PASSWORD,SUPABASE_ACCESS_TOKEN:c.SUPABASE_ACCESS_TOKEN};
  const url=`postgresql://postgres.${refs[environment]}@${c.CHAT_DB_POOLER_HOST}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(cert)}&connect_timeout=10`;
  const psql=c.FSW_PSQL,cli=c.FSW_CLI;
  need(psql?.startsWith('/')&&cli?.startsWith('/'),'ABSOLUTE_PINNED_TOOLS_REQUIRED');
  phase='tools';need(run(psql,['--version'],env).trim()==='psql (PostgreSQL) 17.6','PG176_REQUIRED');
  need(run(cli,['--version'],env).trim()==='2.117.0','CLI_PIN_REQUIRED');
  for(const [args,flags] of [[['link','--help'],['--project-ref']],[['migration','fetch','--help'],['--linked']],[['db','push','--help'],['--db-url','--dry-run']]]) {
   const help=run(cli,args,env);need(flags.every(flag=>help.includes(flag)),'CLI_CONTRACT_CHANGED');
  }
  const capture=()=>{const x=JSON.parse(run(psql,['-XqAt','-v','ON_ERROR_STOP=1','-d',url,'-f',join(root,'tests/fsw-sec-003/capture-release.sql')],env));verifyCapture(environment,x);return x;};
  const schemas=()=>{const x=JSON.parse(run(psql,['-XqAt','-v','ON_ERROR_STOP=1','-d',url],env,schemaSql));verifySchemas(x);return x;};
  phase='capture';const before=capture(),schemaBefore=schemas();verifyPreflight(environment,before,before);
  const workspace=join(privateDir,'workspace');mkdirSync(workspace,{mode:0o700});
  const linked=args=>run(cli,[...args,'--workdir',workspace],env);
  phase='link';linked(['init']);linked(['link','--project-ref',refs[environment]]);
  need(readFileSync(join(workspace,'supabase/.temp/project-ref'),'utf8').trim()===refs[environment],'LINKED_TARGET_MISMATCH');
  phase='fetch';linked(['migration','fetch','--linked']);
  const migrations=join(workspace,'supabase/migrations');verifyHistory(before,migrations);
  verifyPreflight(environment,before,capture());
  copyFileSync(candidate,join(migrations,FILE));verifyHistory(before,migrations,true);
  // Linked preparation is genuine. Apply/dry-run use the explicit verified session
  // URL to pin the SAME target, port and TLS rather than an implicit CLI fallback.
  const push=extra=>run(cli,['db','push','--db-url',url,...extra,'--workdir',workspace],env);
  phase='dry_run';verifyDryRun(push(['--dry-run']));
  phase='preflight';
  recovery(environment,recoveryBytes);
  assert.deepEqual(receipt.backupRecovery,backupWaiver(environment));
  assert.deepEqual(await exposure(environment,c.SUPABASE_ACCESS_TOKEN,fetcher),exposed);
  await requireCi(c,fetcher);
  verifyHistory(before,migrations,true);verifyPreflight(environment,before,capture());assert.deepEqual(schemas(),schemaBefore);
  phase='apply';attempted=true;push(['--yes']);
  phase='postflight';const after=capture();verifyPostflight(environment,before,after);assert.deepEqual(schemas(),schemaBefore);
  assert.deepEqual(await exposure(environment,c.SUPABASE_ACCESS_TOKEN,fetcher),exposed);
  Object.assign(receipt,{status:'PASS',postflight:true,cliVersion:'2.117.0',tls:'verify-full',beforeSha256:sha(JSON.stringify(before)),afterSha256:sha(JSON.stringify(after)),schemaSecuritySha256:sha(JSON.stringify(schemaBefore))});
  return receipt;
 } catch(error) {
  receipt.blocker=/^FSW_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'FSW_VALIDATION_FAILED';
  throw Error(receipt.blocker);
 } finally {
  Object.assign(receipt,{phase,migrationAttempted:attempted,completedAt:new Date().toISOString()});
  if(privateDir)rmSync(privateDir,{recursive:true,force:true});
  mkdirSync(receiptDir,{recursive:true,mode:0o700});
  const bytes=JSON.stringify(receipt,null,2)+'\n';
  writeFileSync(join(receiptDir,'receipt.json'),bytes,{flag:'wx',mode:0o600});
  writeFileSync(join(receiptDir,'SHA256SUMS'),sha(bytes)+'  receipt.json\n',{flag:'wx',mode:0o600});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try{need(process.argv.length===3,'EXACT_ENVIRONMENT_ARGUMENT_REQUIRED');await release(process.argv[2]);console.log('FSW_SEC_003_RELEASE_PASS');}
 catch(e){console.error(/^FSW_[A-Z0-9_]+$/.test(e.message)?e.message:'FSW_RELEASE_BLOCKED');process.exitCode=1;}
}
