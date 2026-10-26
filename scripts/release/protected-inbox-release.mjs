import {readFileSync,writeFileSync,mkdtempSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {resolve,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildPlan,hash,classifyCliFailure,verifyHistoryWorkspace} from './protected-inbox-plan.mjs';
import {manifest} from './chat-v2-inbox-only.mjs';
import {auditProtection} from './inbox-protection.mjs';
export function verifyTestReceipt(receipt,expected){
 if(receipt.environment!=='FairSwapTest'||receipt.status!=='verified'||receipt.sourceCommit!==expected.sha||receipt.runId!==expected.runId||receipt.runAttempt!==expected.runAttempt||receipt.bundleSha256!==expected.bundle||receipt.sourceSha256!==manifest.sha256||receipt.flagsOff!==5||!/^[a-f0-9]{64}$/.test(receipt.historySha256))throw Error('CHAT_SAME_RUN_TEST_EVIDENCE_REQUIRED');
}
const root=resolve(fileURLToPath(new URL('../../',import.meta.url)));
export function bundleHash(){
 const paths=JSON.parse(readFileSync(join(root,'releases/candidates/chat-v2-inbox-only/protected-files.json'),'utf8'));
 return hash(paths.map(path=>{if(!/^(scripts|tests|releases|\.github)\//.test(path)||path.includes('..'))throw Error('CHAT_BUNDLE_PATH_INVALID');return hash(readFileSync(join(root,path)))+'  '+path;}).join('\n')+'\n');
}
export async function release(environment,ledgerHash,bundle){
 const names={fairswaptest:'FairSwapTest',fairswapprod:'FairSwapProd'},name=names[environment];
 if(!name||process.env.GITHUB_REPOSITORY!=='vivek2310sharma/FairSwap-Backend'||process.env.GITHUB_REF!=='refs/heads/main'||process.env.CHAT_RELEASE_ENABLED!=='true'||process.env.CHAT_ENVIRONMENT_ENABLED!=='true'||process.env.CHAT_WEB_FLAG_OFF_CONFIRMED!=='true'||!/^https:\/\/github.com\/vivek2310sharma\/FairSwap-Backend\//.test(process.env.CHAT_BACKEND_AUTHORITY_RECEIPT??''))throw Error('CHAT_SEPARATE_AUTHORITY_REQUIRED');
 if(!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA??'')||bundleHash()!==bundle||!process.env.CHAT_DATABASE_PASSWORD)throw Error('CHAT_IMMUTABLE_INPUT_REQUIRED');
 await auditProtection(name,process.env.CHAT_RELEASE_AUDIT_TOKEN);
 const raw=process.env.CHAT_APPROVED_LEDGER_JSON??'';if(hash(raw)!==ledgerHash)throw Error('CHAT_APPROVED_LEDGER_HASH_MISMATCH');
 const plan=buildPlan(environment,JSON.parse(raw));
 if(environment==='fairswapprod')verifyTestReceipt(JSON.parse(readFileSync(resolve('test-evidence/receipt.json'),'utf8')),{sha:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,bundle});
 const ref=manifest.environments[environment].projectRef,host=`db.${ref}.supabase.co`;
 const env={PATH:process.env.PATH,HOME:process.env.HOME,PGHOST:host,PGPORT:'5432',PGUSER:'postgres',PGDATABASE:'postgres',PGSSLMODE:'verify-full',PGCONNECT_TIMEOUT:'10',PGPASSWORD:process.env.CHAT_DATABASE_PASSWORD,SUPABASE_DB_PASSWORD:process.env.CHAT_DATABASE_PASSWORD,NO_COLOR:'1'};
 const run=(binary,args,input)=>{try{return execFileSync(binary,args,{input,env,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:120000,maxBuffer:2e6});}catch(error){throw Error(`CHAT_SUBPROCESS_${classifyCliFailure(String(error.stdout??'')+'\n'+String(error.stderr??''))}_RECOVERY_REVIEW`);}};
 if(run('supabase',['--version']).trim().split('\n')[0]!=='2.117.0')throw Error('CHAT_CLI_PIN_MISMATCH');
 const help=run('supabase',['migration','up','--help']);if(!help.includes('--include-all')||!help.includes('--db-url'))throw Error('CHAT_CLI_CONTRACT_CHANGED');
 const fetchHelp=run('supabase',['migration','fetch','--help']);if(!fetchHelp.includes('--db-url'))throw Error('CHAT_CLI_CONTRACT_CHANGED');
 run('psql',['-X','-q','-v','ON_ERROR_STOP=1'],plan.preflight);
 const isolated=mkdtempSync(join(tmpdir(),'chat-inbox-approved-'));mkdirSync(join(isolated,'supabase/migrations'),{recursive:true});
 try{
 writeFileSync(join(isolated,'supabase/config.toml'),'project_id="chat-inbox-isolated"\n[db]\nmajor_version=17\n');
 // Fetch only already-recorded history into private files; never repair or fabricate it.
 // All remote versions must be present locally even when migration up uses --include-all.
 const connection=`postgresql://postgres@${host}:5432/postgres?sslmode=verify-full`;
 run('supabase',['migration','fetch','--db-url',connection,'--workdir',isolated]);
 const approvedLedger=JSON.parse(raw).ledger;
 verifyHistoryWorkspace(isolated,approvedLedger);
 // Recheck exact statement-array hashes after fetch; no history source enters artifacts.
 run('psql',['-X','-q','-v','ON_ERROR_STOP=1'],plan.preflight);
 writeFileSync(join(isolated,'supabase/migrations',`${manifest.version}_${manifest.name}.sql`),plan.execution,{mode:0o600});
 verifyHistoryWorkspace(isolated,approvedLedger,{pending:true});
 // Historical versions are real applied sources, skipped by CLI; only this file is pending.
 run('supabase',['migration','up','--include-all','--db-url',connection,'--workdir',isolated]);
 const result=run('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],plan.postflight);
 const lines=result.split('\n').filter(line=>line.trim().startsWith('{'));if(lines.length!==1)throw Error('CHAT_POSTFLIGHT_RECEIPT_INVALID');
 const post=JSON.parse(lines[0]);if(post.flagsOff!==5||post.version!==manifest.version||!/^[a-f0-9]{64}$/.test(post.historySha256))throw Error('CHAT_POSTFLIGHT_RECEIPT_INVALID');
 const receipt={schema:1,status:'verified',environment:name,version:manifest.version,cliVersion:'2.117.0',postgresVersionNum:post.postgresVersionNum,sourceCommit:process.env.GITHUB_SHA,runId:process.env.GITHUB_RUN_ID,runAttempt:process.env.GITHUB_RUN_ATTEMPT,bundleSha256:bundle,sourceSha256:manifest.sha256,executionSha256:plan.executionSha256,ledgerSha256:plan.ledgerSha256,historySha256:post.historySha256,flagsOff:5};
 mkdirSync('release-receipt',{recursive:true});if(existsSync('release-receipt/receipt.json'))throw Error('CHAT_IMMUTABLE_RECEIPT_ALREADY_EXISTS');
 const text=JSON.stringify(receipt,null,2)+'\n';writeFileSync('release-receipt/receipt.json',text,{flag:'wx'});writeFileSync('release-receipt/SHA256SUMS',hash(text)+'  receipt.json\n',{flag:'wx'});
 return receipt;
 }finally{
  // Only our freshly allocated private directory may be removed. Never retain
  // fetched historical SQL in later steps, receipts, source or public artifacts.
  if(dirname(resolve(isolated))!==resolve(tmpdir())||!basename(isolated).startsWith('chat-inbox-approved-'))throw Error('CHAT_PRIVATE_CACHE_PATH_INVALID');
  rmSync(isolated,{recursive:true,force:true});
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await release(...process.argv.slice(2));console.log('CHAT_INBOX_RELEASE_VERIFIED_FLAGS_OFF');}catch(error){const message=error instanceof Error?error.message:'';const code=/^CHAT_[A-Z_]+$/.test(message)?message:'CHAT_INTERNAL_OR_UPSTREAM_FAILURE';console.error(`CHAT_RELEASE_BLOCKED_OR_INTERRUPTED: ${code}; use protected recovery procedure. No raw diagnostics emitted.`);process.exitCode=1;}
}
