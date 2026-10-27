// Assemble only this task's local handoff. No Git mutation, network or deployment.
import {readFileSync as read,writeFileSync as write,readdirSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve,relative} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../..');
const prefix='releases/candidates/ratings-v1-final-release/';
const hash=x=>createHash('sha256').update(x).digest('hex');
const walk=p=>readdirSync(p,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(resolve(p,x.name)):[resolve(p,x.name)]);
const put=(p,x)=>write(resolve(here,p),typeof x==='string'?x:JSON.stringify(x,null,2)+'\n');
const diff=(a,b)=>{const r=spawnSync('git',['diff','--no-index','--no-prefix','--',a,b],{cwd:root,encoding:'utf8'});if(![0,1].includes(r.status))throw Error(r.stderr);return r.stdout;};
const label=(d,path)=>d.split('\n').map(line=>line.startsWith('diff --git ')?`diff --git a/${path} b/${path}`:line.startsWith('--- ')?'--- a/'+path:line.startsWith('+++ ')?'+++ b/'+path:line).join('\n');
const workflow='.github/workflows/backend-ci.yml';
const workflowPatch=label(diff(prefix+'ci-reviewed-head.before.yml',prefix+'ci-reviewed-head.after.yml'),workflow);
put('ci-reviewed-head.patch',workflowPatch);
put('local-workflow.diff',label(diff('artifacts/ratings/final-start/backend-ci.yml',workflow),workflow));
const start=JSON.parse(read(resolve(here,'starting-state.json'),'utf8'));
const drift=start.unrelated.filter(x=>x.sha256!==null&&x.path!==workflow).map(x=>({...x,observedSha256:existsSync(resolve(root,x.path))?hash(read(resolve(root,x.path))):null})).filter(x=>x.sha256!==x.observedSha256);
put('preservation.json',{status:drift.length?'UNRELATED_CONCURRENT_DRIFT':'PASS',authorizedExistingFileEdit:workflow,originalWorkflowSavedAt:'artifacts/ratings/final-start/backend-ci.yml',originalWorkflowSha256:hash(read(resolve(root,'artifacts/ratings/final-start/backend-ci.yml'))),localAfterWorkflowSha256:hash(read(resolve(root,workflow))),reviewedBeforeWorkflowSha256:hash(read(resolve(here,'ci-reviewed-head.before.yml'))),reviewedAfterWorkflowSha256:hash(read(resolve(here,'ci-reviewed-head.after.yml'))),unrelatedDrift:drift,taskEditsToHistoricalOrRatingsMigrations:[]});
const excluded=p=>['scoped.diff','SHA256SUMS','changed-files.json'].includes(p)||p.endsWith('.zip')||p.endsWith('.zip.sha256');
let files=walk(here).map(p=>relative(here,p).replaceAll('\\','/')).filter(p=>!excluded(p));files.push('changed-files.json');files.sort();
put('changed-files.json',{startingLocalHead:start.head,reviewedPrHead:start.reviewedPrHead,synchronized:false,files:[{path:workflow,change:'MODIFIED',diffBase:'exact reviewed PR source, not old local HEAD',localOnlyDelta:'local-workflow.diff'},...files.map(p=>({path:prefix+p,change:'ADDED'}))],derivedArtifacts:['scoped.diff','SHA256SUMS','ratings-v1-final-release-handoff.zip','ratings-v1-final-release-handoff.zip.sha256'],immutableMigrationEdits:[],noHostedWrites:true});
let patch=workflowPatch;
for(const p of files){const path=prefix+p;const content=read(resolve(here,p),'utf8').replaceAll('\r\n','\n');const lines=content.replace(/\n$/,'').split('\n');patch+=`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`+lines.map(x=>'+'+x+'\n').join('');}
put('scoped.diff',patch);
const payload=walk(here).map(p=>relative(here,p).replaceAll('\\','/')).filter(p=>p!=='SHA256SUMS'&&!p.endsWith('.zip')&&!p.endsWith('.zip.sha256')).sort();
put('SHA256SUMS',payload.map(p=>hash(read(resolve(here,p)))+'  '+p).join('\n')+'\n');
console.log(`PASS ${files.length} candidate additions plus mandatory workflow change; ${payload.length} SHA-256 payload entries; ${drift.length} unrelated changes recorded`);
