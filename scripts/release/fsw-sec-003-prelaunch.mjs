// Protected release only; importing this module never connects or writes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,copyFileSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {VERSION,FILE,SHA,refs,sha,verifyCandidate,verifyCapture,verifyHistory,materializeNullHistory,verifyPreflight,verifyPostflight,verifyDryRun} from '../../tests/fsw-sec-003/release-gate.mjs';
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
 for(const key of ['beforeSha256','afterSha256','schemaSecuritySha256','protectionSha256','exposureSha256'])need(/^[a-f0-9]{64}$/.test(r[key]??''),'COMPLETE_TEST_RECEIPT_REQUIRED');
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
// Match only fixed local assertion messages; never log actual/expected values.
const metadataChecks={
 'fresh metadata capture (<=15 minutes) required':'FRESHNESS',
 'verified TLS required':'TLS', 'PostgreSQL 17 target required':'SERVER_VERSION',
 'session/direct connection required':'SESSION_PORT', 'environment endpoint/user mismatch':'TARGET',
 'nonempty full ledger required':'LEDGER_EMPTY', 'unique sorted ledger required':'LEDGER_ORDER',
 'ledger version format':'LEDGER_VERSION', 'ledger migration name':'LEDGER_NAME',
 'unexpected NULL migration statements':'LEDGER_UNEXPECTED_NULL', 'migration statement hash required':'LEDGER_HASH',
 'both RPC functions required':'RPC_COUNT', 'RPC volatility':'RPC_VOLATILITY',
 'RPC search path':'RPC_SEARCH_PATH', 'RPC return type':'RPC_RETURN_TYPE',
 'RPC security mode':'RPC_SECURITY_MODE', 'reviewed function owner required':'RPC_OWNER',
 'reviewed execute ACL required':'RPC_EXECUTE_ACL', 'RPC argument names changed':'RPC_ARGUMENTS',
 'public wrapper drift':'PUBLIC_WRAPPER_BODY', 'private implementation drift':'PRIVATE_IMPLEMENTATION_BODY',
 'independent fresh ledger changed':'LEDGER_DRIFT', 'RPC metadata drift':'RPC_DRIFT', 'ACL/RLS drift':'ACL_RLS_DRIFT',
 'PUBLIC execute forbidden':'RPC_PUBLIC_EXECUTE', 'RPC schemas':'RPC_SCHEMAS',
 'security table inventory':'TABLE_INVENTORY', 'visibility-table RLS required':'TABLE_RLS', 'private schema exposed':'PRIVATE_SCHEMA_EXPOSED'
};
export function parseMetadata(environment,text) {
 let value;
 try{value=JSON.parse(text);}catch{throw Error('FSW_METADATA_INVALID_JSON');}
 try{verifyCapture(environment,value);}catch(error){
  const check=metadataChecks[error.message?.split('\n')[0]];
  throw Error('FSW_METADATA_'+(check??'STRUCTURE')+'_MISMATCH');
 }
 return value;
}
export function subprocessFailure(result,phase) {
 const raw=String(result.stderr??'');
 const state=raw.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5})\b/)?.[1];
 const states={'42601':'SQL_SYNTAX','42703':'SQL_COLUMN','42883':'SQL_FUNCTION','42P01':'SQL_RELATION','42501':'SQL_PERMISSION','25006':'READ_ONLY','57014':'TIMEOUT','28P01':'AUTHENTICATION','28000':'AUTHENTICATION'};
 const kind=states[state]??(/certificate|SSL|TLS/i.test(raw)?'TLS':/could not translate host|Name or service not known/i.test(raw)?'DNS':/connection.*(?:failed|refused|timed out)/i.test(raw)?'CONNECTION':result.error?.code==='ENOENT'?'TOOL_MISSING':result.error?.code==='ETIMEDOUT'?'TIMEOUT':'EXIT');
 return Error('FSW_SUBPROCESS_'+phase.toUpperCase()+'_'+kind+'_FAILED');
}
export function safeFailure(error,phase) {
 if(/^FSW_[A-Z0-9_]+$/.test(error?.message??'')) {
  if(error.message.startsWith('FSW_METADATA_'))return `FSW_CHECK_${phase.toUpperCase()}: ${error.message}; compare the named metadata invariant with the approved target; raw values withheld`;
  if(error.message.startsWith('FSW_SUBPROCESS_'))return `FSW_CHECK_${phase.toUpperCase()}: ${error.message}; check the named SQL, connection or tool failure before retry; raw output withheld`;
  return error.message;
 }
 const invariant=metadataChecks[error?.message?.split('\n')[0]];
 if(invariant)return `FSW_CHECK_${phase.toUpperCase()}: FSW_METADATA_${invariant}_MISMATCH; compare the named invariant with the approved target; raw values withheld`;
 const hints={authorization:'check owner, main commit and approved candidate',ci:'require successful backend CI for this commit',protection:'restore protected environment settings and audit access',exposure:'require public-only Data API exposure',tools:'install Supabase 2.117.0 and a PostgreSQL 17 client',capture:'check TLS, project identity and RPC metadata',fetch:'check fetched filenames and ledger SQL hashes',dry_run:'require exactly the approved pending migration',preflight:'resolve history, RPC or ACL drift before retry',apply:'inspect migration history before retry; do not repair ledger',postflight:'stop rollout and review installed body, history and ACL invariants'};
 return `FSW_CHECK_${phase.toUpperCase()}: ${hints[phase]??'check target credentials, TLS and release prerequisites'}; raw output withheld`;
}
export function subprocessOutput(result,phase,includeStderr=false) {
 if(result.error||result.status!==0)throw subprocessFailure(result,phase);
 return (result.stdout??'')+(includeStderr?(result.stderr??''):'');
}
export async function release(environment,{context: c=process.env,fetcher=fetch,runner,protection=auditProtection,testReceiptBytes,receiptDir=resolve('fsw-release-receipt')}={}) {
 let phase='authorization',attempted=false,privateDir;
 const receipt={schema:1,status:'FAIL',...binding(environment,c)};
 const run=(binary,args,env,input)=>{
  try{if(runner)return runner(binary,args,env,input);
   const result=spawnSync(binary,args,{env,input,encoding:'utf8',timeout:120000,maxBuffer:16*1024*1024});
   // Version identity is stdout only; other CLI output retains stderr diagnostics.
   return subprocessOutput(result,phase,binary===c.FSW_CLI&&!(args.length===1&&args[0]==='--version'));
  }
  catch(error) {if(/^FSW_SUBPROCESS_[A-Z_]+$/.test(error?.message??''))throw error;throw subprocessFailure({stderr:error?.stderr,error},phase);}
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
  phase='exposure';const exposed=await exposure(environment,c.SUPABASE_ACCESS_TOKEN,fetcher);receipt.exposureSha256=sha(JSON.stringify(exposed));
  need(c.CHAT_DATABASE_PASSWORD&&c.CHAT_DB_SSL_ROOT_CERT_PEM,'EXISTING_DATABASE_CREDENTIAL_REQUIRED');
  need(/^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(c.CHAT_DB_POOLER_HOST??''),'SESSION_POOLER_HOST_REQUIRED');
  privateDir=mkdtempSync(join(tmpdir(),'fsw-sec-003-'));chmodSync(privateDir,0o700);
  const cert=join(privateDir,'root.crt');writeFileSync(cert,validateRootCertificate(c.CHAT_DB_SSL_ROOT_CERT_PEM),{flag:'wx',mode:0o600});
  const env={PATH:c.PATH,HOME:privateDir,NO_COLOR:'1',PGSSLMODE:'verify-full',PGSSLROOTCERT:cert,PGCONNECT_TIMEOUT:'10',PGPASSWORD:c.CHAT_DATABASE_PASSWORD,SUPABASE_DB_PASSWORD:c.CHAT_DATABASE_PASSWORD,SUPABASE_ACCESS_TOKEN:c.SUPABASE_ACCESS_TOKEN};
  const url=`postgresql://postgres.${refs[environment]}@${c.CHAT_DB_POOLER_HOST}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(cert)}&connect_timeout=10`;
  const psql=c.FSW_PSQL,cli=c.FSW_CLI;
  need(psql?.startsWith('/')&&cli?.startsWith('/'),'ABSOLUTE_PINNED_TOOLS_REQUIRED');
  phase='tools';need(/^psql \(PostgreSQL\) 17\./.test(run(psql,['--version'],env).trim()),'PG17_CLIENT_REQUIRED');
  need(run(cli,['--version'],env).trim()==='2.117.0','CLI_PIN_REQUIRED');
  for(const [args,flags] of [[['link','--help'],['--project-ref']],[['migration','fetch','--help'],['--linked']],[['db','push','--help'],['--db-url','--dry-run']]]) {
   const help=run(cli,args,env);need(flags.every(flag=>help.includes(flag)),'CLI_CONTRACT_CHANGED');
  }
  const capture=()=>{return parseMetadata(environment,run(psql,['-XqAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-d',url,'-f',join(root,'tests/fsw-sec-003/capture-release.sql')],env));};
  const schemas=()=>{const x=JSON.parse(run(psql,['-XqAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate','-d',url],env,schemaSql));verifySchemas(x);return x;};
  phase='capture';const before=capture(),schemaBefore=schemas();verifyPreflight(environment,before,before);
  const workspace=join(privateDir,'workspace');mkdirSync(workspace,{mode:0o700});
  const linked=args=>run(cli,[...args,'--workdir',workspace],env);
  phase='link';linked(['init']);linked(['link','--project-ref',refs[environment]]);
  need(readFileSync(join(workspace,'supabase/.temp/project-ref'),'utf8').trim()===refs[environment],'LINKED_TARGET_MISMATCH');
  phase='fetch';linked(['migration','fetch','--linked']);
  const migrations=join(workspace,'supabase/migrations');materializeNullHistory(before,migrations);verifyHistory(before,migrations);
  verifyPreflight(environment,before,capture());
  copyFileSync(candidate,join(migrations,FILE));verifyHistory(before,migrations,true);
  // Linked preparation is genuine. Apply/dry-run use the explicit verified session
  // URL to pin the SAME target, port and TLS rather than an implicit CLI fallback.
  const push=extra=>run(cli,['db','push','--db-url',url,...extra,'--workdir',workspace],env);
  phase='dry_run';verifyDryRun(push(['--dry-run']));
  phase='preflight';
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
  receipt.blocker=safeFailure(error,phase);
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
 catch(e){console.error(e.message.startsWith('FSW_CHECK_')?e.message:safeFailure(e,'authorization'));process.exitCode=1;}
}
