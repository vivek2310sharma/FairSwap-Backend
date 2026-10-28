import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {resolve,join,dirname,basename,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {X509Certificate} from 'node:crypto';
import {buildPlan,hash,classifyCliFailure,verifyHistoryWorkspace,historyCaptureSql,parseHistoryCapture} from './protected-inbox-plan.mjs';
import {manifest} from './chat-v2-inbox-only.mjs';
import {auditProtection,bundleHash,requireOwnerActors,governanceOwner} from './inbox-protection.mjs';
export {bundleHash} from './inbox-protection.mjs';
// Shared session pooler only: raw hostname, fixed mode/port and project identity.
export function databaseConnection(environment,context,rootCert){
 const ref=manifest.environments[environment]?.projectRef;
 if(!ref)throw Error('CHAT_ENVIRONMENT_REQUIRED');
 const host=context.CHAT_DB_POOLER_HOST;
 if(typeof host!=='string'||host.length===0)throw Error('CHAT_DB_POOLER_HOST_REQUIRED');
 if(host.length>253||!/^aws-[0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*\.pooler\.supabase\.com$/.test(host))throw Error('CHAT_DB_POOLER_HOST_INVALID');
 if(typeof context.CHAT_DATABASE_PASSWORD!=='string'||!context.CHAT_DATABASE_PASSWORD)throw Error('CHAT_DATABASE_PASSWORD_REQUIRED');
 if(typeof rootCert!=='string'||!isAbsolute(rootCert))throw Error('CHAT_DB_SSL_ROOT_CERT_FILE_REQUIRED');
 const user=`postgres.${ref}`;
 const connection=`postgresql://${user}@${host}:5432/postgres?sslmode=verify-full&sslrootcert=${encodeURIComponent(rootCert)}&connect_timeout=10`;
 const env={PATH:context.PATH,HOME:context.HOME,PGHOST:host,PGPORT:'5432',PGUSER:user,PGDATABASE:'postgres',PGSSLMODE:'verify-full',PGSSLROOTCERT:rootCert,PGCONNECT_TIMEOUT:'10',PGPASSWORD:context.CHAT_DATABASE_PASSWORD,SUPABASE_DB_PASSWORD:context.CHAT_DATABASE_PASSWORD,NO_COLOR:'1'};
 return {connection,env};
}
export function validateRootCertificate(value,now=Date.now()){
 if(typeof value!=='string'||value.length===0)throw Error('CHAT_DB_SSL_ROOT_CERT_REQUIRED');
 try{
  if(value.length>65536)throw Error();
  const pem=value.trim().replaceAll('\r\n','\n')+'\n';
  if(!/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n$/.test(pem))throw Error();
  const cert=new X509Certificate(pem);
  if(!cert.ca||!Number.isFinite(now)||Date.parse(cert.validFrom)>now||Date.parse(cert.validTo)<=now)throw Error();
  return pem;
 }catch{throw Error('CHAT_DB_SSL_ROOT_CERT_INVALID');}
}
// The action sees a private file path; PEM bytes never enter subprocess env/args.
export async function withDatabaseConnection(environment,context,action){
 const directory=mkdtempSync(join(tmpdir(),'chat-inbox-tls-'));
 try{
  const config=databaseConnection(environment,context,join(directory,'root.crt'));
  const pem=validateRootCertificate(context.CHAT_DB_SSL_ROOT_CERT_PEM);
  try{chmodSync(directory,0o700);writeFileSync(config.env.PGSSLROOTCERT,pem,{flag:'wx',mode:0o600});}
  catch{throw Error('CHAT_DB_SSL_ROOT_CERT_FILE_FAILURE');}
  return await action(config);
 }finally{
  if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('chat-inbox-tls-'))throw Error('CHAT_PRIVATE_CACHE_PATH_INVALID');
  try{rmSync(directory,{recursive:true,force:true});}catch{throw Error('CHAT_DB_SSL_ROOT_CERT_CLEANUP_FAILURE');}
 }
}
export function verifyTestReceipt(receipt,expected){
 if(receipt?.schema!==3||receipt.environment!=='FairSwapTest'||receipt.status!=='verified'||receipt.sourceCommit!==expected.sha||receipt.runId!==expected.runId||receipt.runAttempt!==expected.runAttempt||receipt.bundleSha256!==expected.bundle||receipt.sourceSha256!==manifest.sha256||receipt.flagsOff!==5||receipt.webFlagOffConfirmed!==true||receipt.version!==manifest.version||receipt.cliVersion!=='2.117.0'||Math.floor(receipt.postgresVersionNum/10000)!==17||!/^[a-f0-9]{64}$/.test(receipt.historySha256)||!/^[a-f0-9]{64}$/.test(receipt.protectionSnapshotSha256)||!/^[a-f0-9]{64}$/.test(receipt.executionSha256)||!/^[a-f0-9]{64}$/.test(expected.testLedgerSha256??'')||receipt.capturedLedgerSha256!==expected.testLedgerSha256||receipt.governanceOwner!==governanceOwner||receipt.actor!==governanceOwner||receipt.triggeringActor!==governanceOwner)throw Error('CHAT_SAME_RUN_TEST_EVIDENCE_REQUIRED');
}
export async function release(environment,bundle,testLedgerHash,{context=process.env,fetcher=fetch,runner}={}){
 requireOwnerActors(context);
 const names={fairswaptest:'FairSwapTest',fairswapprod:'FairSwapProd'},name=names[environment];
 if(!name||context.GITHUB_REPOSITORY!=='vivek2310sharma/FairSwap-Backend'||context.GITHUB_REF!=='refs/heads/main'||context.CHAT_RELEASE_ENABLED!=='true'||context.CHAT_ENVIRONMENT_ENABLED!=='true'||context.CHAT_WEB_FLAG_OFF_CONFIRMED!=='true')throw Error('CHAT_OWNER_AUTHORIZATION_REQUIRED');
 if(!/^[1-9][0-9]*$/.test(context.GITHUB_RUN_ID??'')||!/^[1-9][0-9]*$/.test(context.GITHUB_RUN_ATTEMPT??'')||!/^[a-f0-9]{40}$/.test(context.GITHUB_SHA??'')||bundleHash()!==bundle||!context.CHAT_DATABASE_PASSWORD)throw Error('CHAT_IMMUTABLE_INPUT_REQUIRED');
 if(environment==='fairswapprod')verifyTestReceipt(JSON.parse(readFileSync(resolve('test-evidence/receipt.json'),'utf8')),{sha:context.GITHUB_SHA,runId:context.GITHUB_RUN_ID,runAttempt:context.GITHUB_RUN_ATTEMPT,bundle,testLedgerSha256:testLedgerHash});
 return withDatabaseConnection(environment,context,async({connection,env})=>{
 const protection=await auditProtection(name,context.CHAT_RELEASE_AUDIT_TOKEN,fetcher,{sourceCommit:context.GITHUB_SHA,bundleSha256:bundle,actor:context.GITHUB_ACTOR,triggeringActor:context.GITHUB_TRIGGERING_ACTOR});

 const run=(stage,binary,args,input)=>{try{if(runner)return runner(binary,args,input,env);return execFileSync(binary,args,{input,env,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000,maxBuffer:2e6});}catch(error){throw Error(`CHAT_SUBPROCESS_${stage}_${classifyCliFailure(String(error.stdout??'')+'\n'+String(error.stderr??'')+'\n'+String(error.code??''))}_RECOVERY_REVIEW`);}};
 if(run('CLI_VERSION','supabase',['--version']).trim().split('\n')[0]!=='2.117.0')throw Error('CHAT_CLI_PIN_MISMATCH');
 const help=run('CLI_APPLY_HELP','supabase',['migration','up','--help']);if(!help.includes('--include-all')||!help.includes('--db-url'))throw Error('CHAT_CLI_CONTRACT_CHANGED');
 const fetchHelp=run('CLI_FETCH_HELP','supabase',['migration','fetch','--help']);if(!fetchHelp.includes('--db-url'))throw Error('CHAT_CLI_CONTRACT_CHANGED');
 const snapshot=parseHistoryCapture(run('HISTORY_CAPTURE','psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],historyCaptureSql(environment)));
 const plan=buildPlan(environment,snapshot),ledgerHash=plan.ledgerSha256;
 run('PREFLIGHT_BEFORE_FETCH','psql',['-X','-q','-v','ON_ERROR_STOP=1'],plan.preflight);
 const isolated=mkdtempSync(join(tmpdir(),'chat-inbox-approved-'));mkdirSync(join(isolated,'supabase/migrations'),{recursive:true});
 try{
 writeFileSync(join(isolated,'supabase/config.toml'),'project_id="chat-inbox-isolated"\n[db]\nmajor_version=17\n');
 // Fetch only already-recorded history into private files; never repair or fabricate it.
 // All remote versions must be present locally even when migration up uses --include-all.
 run('HISTORY_FETCH','supabase',['migration','fetch','--db-url',connection,'--workdir',isolated]);
 const approvedLedger=snapshot.ledger;
 verifyHistoryWorkspace(isolated,approvedLedger);
 // Recheck exact statement-array hashes after fetch; no history source enters artifacts.
 run('PREFLIGHT_BEFORE_APPLY','psql',['-X','-q','-v','ON_ERROR_STOP=1'],plan.preflight);
 writeFileSync(join(isolated,'supabase/migrations',`${manifest.version}_${manifest.name}.sql`),plan.execution,{mode:0o600});
 verifyHistoryWorkspace(isolated,approvedLedger,{pending:true});
 // Historical versions are real applied sources, skipped by CLI; only this file is pending.
 run('MIGRATION_APPLY','supabase',['migration','up','--include-all','--db-url',connection,'--workdir',isolated]);
 const result=run('POSTFLIGHT','psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],plan.postflight);
 const lines=result.split('\n').filter(line=>line.trim().startsWith('{'));if(lines.length!==1)throw Error('CHAT_POSTFLIGHT_RECEIPT_INVALID');
 const post=JSON.parse(lines[0]);if(post.flagsOff!==5||!Number.isInteger(post.postgresVersionNum)||Math.floor(post.postgresVersionNum/10000)!==17||post.version!==manifest.version||!/^[a-f0-9]{64}$/.test(post.historySha256))throw Error('CHAT_POSTFLIGHT_RECEIPT_INVALID');
 const receipt={schema:3,status:'verified',environment:name,version:manifest.version,cliVersion:'2.117.0',postgresVersionNum:post.postgresVersionNum,sourceCommit:context.GITHUB_SHA,runId:context.GITHUB_RUN_ID,runAttempt:context.GITHUB_RUN_ATTEMPT,bundleSha256:bundle,sourceSha256:manifest.sha256,executionSha256:plan.executionSha256,ledgerSha256:plan.ledgerSha256,capturedLedgerSha256:ledgerHash,historySha256:post.historySha256,flagsOff:5,webFlagOffConfirmed:true,protectionSnapshotSha256:protection.snapshotSha256,governanceOwner,actor:context.GITHUB_ACTOR,triggeringActor:context.GITHUB_TRIGGERING_ACTOR};
 mkdirSync('release-receipt',{recursive:true});if(existsSync('release-receipt/receipt.json'))throw Error('CHAT_IMMUTABLE_RECEIPT_ALREADY_EXISTS');
 const text=JSON.stringify(receipt,null,2)+'\n';writeFileSync('release-receipt/receipt.json',text,{flag:'wx'});writeFileSync('release-receipt/SHA256SUMS',hash(text)+'  receipt.json\n',{flag:'wx'});
 return receipt;
 }finally{
  // Only our freshly allocated private directory may be removed. Never retain
  // fetched historical SQL in later steps, receipts, source or public artifacts.
  if(dirname(resolve(isolated))!==resolve(tmpdir())||!basename(isolated).startsWith('chat-inbox-approved-'))throw Error('CHAT_PRIVATE_CACHE_PATH_INVALID');
  rmSync(isolated,{recursive:true,force:true});
 }
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{if(process.argv.length<4||process.argv.length>5)throw Error('CHAT_RELEASE_INPUT_REQUIRED');await release(...process.argv.slice(2));console.log('CHAT_INBOX_RELEASE_VERIFIED_FLAGS_OFF');}catch(error){const message=error instanceof Error?error.message:'';const code=/^CHAT_[A-Z_]+$/.test(message)?message:'CHAT_INTERNAL_OR_UPSTREAM_FAILURE';console.error(`CHAT_RELEASE_BLOCKED_OR_INTERRUPTED: ${code}; use protected recovery procedure. No raw diagnostics emitted.`);process.exitCode=1;}
}
