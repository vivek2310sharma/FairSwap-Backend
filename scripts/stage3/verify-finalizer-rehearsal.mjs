// Step 1R diagnostic overlay. No extension/compatibility acceptance path.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync,mkdirSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyBaseline,manifestSha256} from '../ci/verify-baseline.mjs';
import {verifySecurity,verifyExtensionInventory,requiredSuites,inspectSuiteEvidence,isolationKeys,cleanupKeys,sanitizeDiagnostic} from './verify-db-results.mjs';
import {inspectTap} from './parse-compatibility.mjs';
import {sourceRoot,verifySource,expectedBodyHashes,digest,extraSuite} from './prepare-finalizer-rehearsal.mjs';
const json=p=>JSON.parse(readFileSync(p,'utf8'));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const observedExtensions=Object.freeze({pg_cron:'1.6.4',pg_net:'0.20.4',supabase_vault:'0.3.1'});
const allSuites={...requiredSuites,[extraSuite]:85};
function exactKeys(object,keys){assert.ok(object&&typeof object==='object'&&!Array.isArray(object));assert.deepEqual(Object.keys(object).sort(),[...keys].sort());}
function flags(o,keys){exactKeys(o,keys);assert.ok(keys.every(k=>o[k]===true));return true;}
function security(raw,phase){
 const file={before:'security-before.json',overlay:'security-overlay.json',after:'security-after.json'}[phase];
 const s=json(path.join(raw,file));verifySecurity(s,{allowUnapprovedExtensions:true});
 const inventory=verifyExtensionInventory(s.checks.extensions);
 assert.deepEqual(inventory.versions,observedExtensions);assert.equal(inventory.approved,false);return inventory;
}
function state(raw,phase,root){
 const s=json(path.join(raw,'state-'+phase+'.json'));
 exactKeys(s,['function','guards','cronOff','cronHistoryEmpty']);assert.equal(s.cronOff,true);assert.equal(s.cronHistoryEmpty,true);
 const f=s.function;exactKeys(f,['oid','owner','acl','config','definer','volatility','language','body']);
 assert.ok(Number.isSafeInteger(f.oid)&&f.oid>0&&Number.isSafeInteger(f.owner)&&f.owner>0);
 assert.equal(f.definer,true);assert.equal(f.volatility,'v');assert.equal(f.language,'plpgsql');
 assert.ok(Array.isArray(f.config)&&f.config.length===1&&['search_path=""',"search_path=''",'search_path='].includes(f.config[0]));
 assert.equal(f.body,expectedBodyHashes(root)[phase==='before'?'before':'after']);
 assert.ok(Array.isArray(s.guards)&&s.guards.length===5);
 const names=['listings','listing_car_contexts','listing_vehicle_contexts','listing_property_contexts','listing_media'];
 assert.deepEqual(s.guards.map(g=>g.table).sort(),names.sort());
 for(const g of s.guards){
  exactKeys(g,['name','table','enabled','function','body']);assert.equal(g.enabled,'O');
  assert.equal(g.name,g.table==='listings'?'z_0_test_submission_lifecycle':'zz_test_submission_child');
  assert.ok(Number.isSafeInteger(g.function)&&g.function>0);assert.match(g.body,/^[a-f0-9]{32}$/);
 }
 return s;
}
export function gate(phase,project,raw,root=sourceRoot){
 assert.ok(['before','overlay','after'].includes(phase));verifySource(root,true);verifyBaseline(root);verifyBaseline(project);
 security(raw,'before');const first=state(raw,'before',root);
 if(phase!=='before'){
  security(raw,'overlay');const next=state(raw,'overlay',root);
  const withoutBody=x=>Object.fromEntries(Object.entries(x).filter(([k])=>k!=='body'));
  assert.deepEqual(withoutBody(first.function),withoutBody(next.function));assert.deepEqual(first.guards,next.guards);
  if(phase==='after'){
   security(raw,'after');const last=state(raw,'after',root);
   assert.deepEqual(next.function,last.function);assert.deepEqual(first.guards,last.guards);
  }
 }
 return true;
}
export function inspectSupplement(log,exitCode){
 assert.equal(typeof log,'string');assert.ok(Number.isInteger(exitCode)&&exitCode>=0&&exitCode<=255);
 const rows=[...log.matchAll(/^(not ok|ok) ([0-9]+)(?:[ \t]|$)([^\r\n]*)/gm)];
 assert.ok(rows.length<=85&&rows.every((r,i)=>Number(r[2])===i+1));
 const plans=[...log.matchAll(/^1\.\.([0-9]+)\r?$/gm)],directives=rows.some(r=>/#\s*(?:SKIP|TODO)\b/i.test(r[3]));
 const failed=rows.filter(r=>r[1]==='not ok').map(r=>Number(r[2]));
 const passed=rows.filter(r=>r[1]==='ok'&&!/#\s*(?:SKIP|TODO)\b/i.test(r[3])).map(r=>Number(r[2]));
 const complete=plans.length===1&&plans[0][1]==='85'&&rows.length===85&&!directives
  &&!/(?:^|\n)(?:Bail out!|ERROR:|psql:.*ERROR:)/i.test(log)&&exitCode===0&&failed.length===0;
 return {file:extraSuite,exitCode,assertionsObserved:rows.length,passed,failed,result:complete?'PASS':'NOT_VERIFIED'};
}
function exit(raw,file){const s=readFileSync(path.join(raw,file+'.exit'),'utf8');assert.match(s,/^(?:0|[1-9][0-9]{0,2})\n?$/);const n=Number(s.trim());assert.ok(n<=255);return n;}
function attempt(fn,fallback=false){try{return fn();}catch{return fallback;}}
function imageChecks(raw,root){
 const pins=json(path.join(root,'scripts/stage3/toolchain.json')).database;
 const images=json(path.join(raw,'images.json'));exactKeys(images,Object.keys(pins.images));
 for(const [key,p]of Object.entries(pins.images)){const i=images[key];assert.equal(i.tag,p.tag);assert.equal(i.digest,p.digest);assert.equal(i.platform,'linux/amd64');assert.match(i.imageId,/^sha256:[a-f0-9]{64}$/);}
 return true;
}
function toolChecks(raw){
 const t=json(path.join(raw,'tools.json'));assert.equal(t.cliVersion,'2.117.0');assert.equal(t.nodeVersion,'24.15.0');assert.equal(t.os,'linux');assert.equal(t.arch,'amd64');assert.match(t.dockerVersion,/^[0-9]+\.[0-9]+\.[0-9]+$/);assert.ok(Number(t.dockerVersion.split('.')[0])>=28);return true;
}
const evidenceFiles=['result.json','suite-results.json','SHA256SUMS'];
function write(directory,report,suites){
 mkdirSync(directory,{recursive:true});
 assert.ok(readdirSync(directory).every(n=>evidenceFiles.includes(n)));
 assert.ok(readdirSync(directory).every(n=>lstatSync(path.join(directory,n)).isFile()&&!lstatSync(path.join(directory,n)).isSymbolicLink()));
 writeFileSync(path.join(directory,'result.json'),JSON.stringify(report,null,2)+'\n');
 writeFileSync(path.join(directory,'suite-results.json'),JSON.stringify(suites,null,2)+'\n');
 writeFileSync(path.join(directory,'SHA256SUMS'),evidenceFiles.slice(0,2).map(n=>digest(readFileSync(path.join(directory,n)))+'  '+n+'\n').join(''));
}
export function collect(raw,directory,root=sourceRoot){
 const suites=Object.keys(allSuites).map(file=>attempt(()=>{
  const log=readFileSync(path.join(raw,file+'.log'),'utf8'),code=exit(raw,file);
  return file===extraSuite?inspectSupplement(log,code):inspectSuiteEvidence(file,log,code);
 },{file,result:'NOT_VERIFIED',assertionsObserved:null,passed:[],failed:[]}));
 const retained=suites.filter(s=>Object.hasOwn(s,'exitCode'));
 const project=path.resolve(raw,'../project');
 // Independent checks run even when moderation or supplemental TAP fails.
 const checks={before:attempt(()=>gate('before',project,raw,root)),afterProposal:attempt(()=>gate('overlay',project,raw,root)),afterSql:attempt(()=>gate('after',project,raw,root))};
 const isolation={before:attempt(()=>flags(json(path.join(raw,'isolation-before.json')),isolationKeys)),after:attempt(()=>flags(json(path.join(raw,'isolation-after.json')),isolationKeys))};
 const cleanup=attempt(()=>{const c=json(path.join(raw,'cleanup.json'));exactKeys(c,cleanupKeys);assert.ok(cleanupKeys.every(k=>typeof c[k]==='boolean'));return Object.fromEntries(cleanupKeys.map(k=>[k,c[k]]));},'UNVERIFIED');
 const extensions=Object.fromEntries(['before','overlay','after'].map(p=>[p,attempt(()=>security(raw,p),null)]));
 const compatibility=attempt(()=>{const file='moderation_compatibility.test.sql',log=readFileSync(path.join(raw,file+'.log'),'utf8'),code=exit(raw,file);inspectSuiteEvidence(file,log,code);return inspectTap(log,code);},{executed:false,passed:false});
 const sourceVerified=attempt(()=>{verifySource(root,true);return true;});
 const imagesVerified=sourceVerified&&attempt(()=>imageChecks(raw,root)),toolsVerified=sourceVerified&&attempt(()=>toolChecks(raw));
 const manifestVerified=sourceVerified&&attempt(()=>{const m=json(path.join(raw,'manifest.json'));assert.equal(m.sha256,manifestSha256);assert.equal(m.before,true);assert.equal(m.after,true);return true;});
 const executionExit=attempt(()=>{const n=json(path.join(raw,'execution.json')).exitCode;assert.ok(Number.isInteger(n)&&n>=0&&n<=255);return n;},null);
 const counts={suitesExecuted:retained.length,suitesWithUnknownCounts:11-retained.filter(s=>s.assertionsObserved!==null).length,assertionsObserved:retained.reduce((n,s)=>n+(s.assertionsObserved??0),0),assertionsPassed:retained.reduce((n,s)=>n+s.passed.length,0),assertionsFailed:retained.reduce((n,s)=>n+s.failed.length,0)};
 const diagnostic=attempt(()=>sanitizeDiagnostic(json(path.join(raw,'diagnostic.json'))),{stage:'unclassified',category:'unclassified'});
 const complete=suites.length===11&&retained.length===11&&suites.every(s=>s.result==='PASS')&&counts.assertionsObserved===429&&counts.assertionsPassed===429
  &&Object.values(checks).every(Boolean)&&Object.values(isolation).every(Boolean)&&typeof cleanup==='object'&&cleanupKeys.every(k=>cleanup[k]===true)
  &&imagesVerified&&toolsVerified&&manifestVerified&&executionExit===0&&compatibility.passed===true&&same(diagnostic,{stage:'complete',category:'none'});
 const report={schemaVersion:1,kind:'STEP1R_DIAGNOSTIC_ONLY',success:false,compatibilityAccepted:false,extensionApproval:false,
  executionVerified:complete,concurrencyVerified:false,sourceVerified,executionExit,diagnostic,canonicalMigrations:checks.before?58:null,proposalApplications:checks.afterProposal?1:null,
  postgres:checks.before?{version:'17.6',versionNum:170006}:null,security:checks,isolation,imagesVerified,toolsVerified,manifestVerified,
  extensions,cleanup,counts,compatibility};
 write(directory,report,retained);return false;
}
export function verifyChecksums(directory){
 assert.deepEqual(readdirSync(directory).sort(),[...evidenceFiles].sort());
 for(const name of evidenceFiles){const s=lstatSync(path.join(directory,name));assert.ok(s.isFile()&&!s.isSymbolicLink());}
 const lines=readFileSync(path.join(directory,'SHA256SUMS'),'utf8').trimEnd().split('\n');assert.equal(lines.length,2);
 for(const [i,name]of evidenceFiles.slice(0,2).entries())assert.equal(lines[i],digest(readFileSync(path.join(directory,name)))+'  '+name);
 const r=json(path.join(directory,'result.json'));assert.equal(r.success,false);assert.equal(r.compatibilityAccepted,false);assert.equal(r.extensionApproval,false);return true;
}
export function invalidate(directory,diagnostic){
 write(directory,{schemaVersion:1,kind:'STEP1R_DIAGNOSTIC_ONLY',success:false,compatibilityAccepted:false,extensionApproval:false,
 executionVerified:false,cleanup:'FAILED',diagnostic:sanitizeDiagnostic(diagnostic)},[]);
 return false;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [mode,first,second,...rest]=process.argv.slice(2);
  if(['--before','--overlay','--after'].includes(mode)){assert.equal(rest.length,0);gate(mode.slice(2),first,second);}
  else if(mode==='--tap'){assert.equal(rest.length,0);assert.equal(inspectSupplement(readFileSync(first,'utf8'),Number(second)).result,'PASS');}
  else if(mode==='--collect'){assert.equal(rest.length,0);collect(first,second);throw new Error();}
  else if(mode==='--cleanup-failed'){assert.equal(rest.length,1);invalidate(first,{stage:second,category:rest[0]});throw new Error();}
  else if(mode==='--verify'){assert.ok(first&&!second&&rest.length===0);verifyChecksums(first);throw new Error();}
  else throw new Error();
 }catch{console.error('FAIL: Step 1R gate or acceptance; compatibility remains unapproved; raw output withheld');process.exitCode=1;}
}
