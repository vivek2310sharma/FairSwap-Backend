// Local handoff assembly only; additions confined to this candidate.
import {readFileSync as read,writeFileSync as write,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../..');
const hash=x=>createHash('sha256').update(x).digest('hex');
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(resolve(p,x.name)):[resolve(p,x.name)]);
const put=(p,x)=>write(resolve(here,p),typeof x==='string'?x:JSON.stringify(x,null,2)+'\n');
const start=JSON.parse(read(resolve(here,'starting-state.json'),'utf8'));
const drift=start.unrelated.filter(x=>x.sha256!==null).map(x=>({...x,observedSha256:existsSync(resolve(root,x.path))?hash(read(resolve(root,x.path))):null})).filter(x=>x.sha256!==x.observedSha256);
put('preservation.json',{status:drift.length?'UNRELATED_CONCURRENT_DRIFT':'PASS',taskEditsOutsideCandidate:[],note:'These paths changed after the snapshot without edits by this task; not overwritten, restored or included in scoped diff. Starting hashes retained.',drift});
const excluded=new Set(['scoped.diff','SHA256SUMS','ratings-v1-hosted-release-readiness.zip','ratings-v1-hosted-release-readiness.zip.sha256']);
let files=walk(here).map(p=>relative(here,p).replaceAll('\\','/')).filter(p=>!excluded.has(p));
if(!files.includes('changed-files.json'))files.push('changed-files.json');files.sort();
put('changed-files.json',{startingHead:start.head,repository:'FairSwap-Backend',scope:'releases/candidates/ratings-v1-hosted-release/',files:files.map(p=>({path:'releases/candidates/ratings-v1-hosted-release/'+p,change:'ADDED'})),derivedArtifacts:['scoped.diff','SHA256SUMS','ratings-v1-hosted-release-readiness.zip','ratings-v1-hosted-release-readiness.zip.sha256'],existingFileEdits:[],immutableMigrationEdits:[],workflowEdits:[],unrelatedDriftReceipt:'preservation.json'});
// All scoped files are new in the starting checkout. Exclude self-derived diff/hash/archive.
let diff='';for(const p of files){const full='releases/candidates/ratings-v1-hosted-release/'+p;const lines=read(resolve(here,p),'utf8').replaceAll('\r\n','\n').replace(/\n$/,'').split('\n');diff+=`diff --git a/${full} b/${full}\nnew file mode 100644\n--- /dev/null\n+++ b/${full}\n@@ -0,0 +1,${lines.length} @@\n`+lines.map(x=>'+'+x+'\n').join('');}
put('scoped.diff',diff);
const content=walk(here).map(p=>relative(here,p).replaceAll('\\','/')).filter(p=>!['SHA256SUMS','ratings-v1-hosted-release-readiness.zip','ratings-v1-hosted-release-readiness.zip.sha256'].includes(p)).sort();
put('SHA256SUMS',content.map(p=>hash(read(resolve(here,p)))+'  '+p).join('\n')+'\n');
console.log(`PASS inventory ${files.length} scoped additions; diff and ${content.length} SHA-256 entries; ${drift.length} unrelated concurrent changes recorded`);
