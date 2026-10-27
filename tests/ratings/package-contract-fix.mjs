// Explicit delta payload only. No Git mutations or external services.
import {readFileSync,writeFileSync,readdirSync,mkdirSync,copyFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync,execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import assert from 'node:assert/strict';
const dir='releases/candidates/ratings-v1-contract-fix/';
const artifacts='artifacts/ratings-contract-fix/';
const sha=b=>createHash('sha256').update(b).digest('hex');
const start=JSON.parse(readFileSync(artifacts+'starting.json','utf8'));
const modified=['docs/contracts/ratings-v1.md','src/lib/ratings/contract.ts','tests/ratings/contract.test.mjs','tests/ratings/native-adapter.mjs','tests/ratings/run-native.ps1','tests/ratings/run.mjs'];
const added=['supabase/forward-migrations/ratings/20261026094908_ratings_consumer_contract.sql','tests/ratings/consumer-contract.mjs','tests/ratings/run-native.sh','tests/ratings/build-native-pg17.sh','tests/ratings/pg17-source.json','tests/ratings/prepare-contract-fix-release.mjs','tests/ratings/package-contract-fix.mjs'];
const own=new Set([...modified,...added]);
const preserved=start.files.filter(x=>!own.has(x.path));
const unrelatedChanges=preserved.filter(x=>!existsSync(x.path)||sha(readFileSync(x.path))!==x.sha256);
const concurrentPaths=new Set(['.github/workflows/backend-ci.yml','scripts/ci/emit-chat-net-privileges-sql.mjs','scripts/ci/run-chat-net-privileges-pg15.sh','scripts/ci/test-chat-v2.mjs','supabase/forward-migrations/chat-v2/README.md','tests/chat-v2/edge-auth.test.mjs']);
assert(unrelatedChanges.every(x=>concurrentPaths.has(x.path)&&existsSync(x.path)),'Unexpected concurrent overlap; inspect before packaging');
assert.equal(execFileSync('git',['rev-parse','HEAD']).toString().trim(),start.head);
for(const path of modified)assert.equal(sha(readFileSync(artifacts+'before/'+path)),start.files.find(x=>x.path===path).sha256);
writeFileSync(dir+'preservation.json',JSON.stringify({baseHead:start.head,branch:start.branch,synchronized:false,startingFilesChecked:preserved.length,unchangedFiles:preserved.length-unrelatedChanges.length,concurrentUnrelatedFiles:unrelatedChanges.map(x=>({path:x.path,startingSha256:x.sha256,currentSha256:sha(readFileSync(x.path)),disposition:'Not edited by Ratings; untouched and excluded'})),initialFiveMigrationsUnchanged:true,allOriginalRatingsReleaseArtifactsUnchanged:true,allExistingPackageAndConfigFilesUnchanged:true,notes:'All starting files outside the explicit delta were compared byte-for-byte. Six unrelated CI/Chat V2 files changed concurrently; no Ratings overlap, restoration or overwrite. The six changes previously recorded by the original Ratings handoff also remain excluded and untouched. No other repository was edited.'},null,2)+'\n');
let diff='',stats=[];
for(const path of [...modified,...added].sort()){
 const current=readFileSync(path,'utf8').replace(/\r\n/g,'\n');
 if(modified.includes(path)){
  const r=spawnSync('git',['diff','--no-index','--text','--no-ext-diff','--',artifacts+'before/'+path,path],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,1);const lines=r.stdout.replace(/\r\n/g,'\n').split('\n');const first=lines.findIndex(x=>x.startsWith('@@'));
  diff+=`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`+lines.slice(first).join('\n');
  stats.push({path,status:'modified',beforeSha256:start.files.find(x=>x.path===path).sha256,sha256:sha(readFileSync(path))});
 }else{
  const lines=current.endsWith('\n')?current.slice(0,-1).split('\n'):current.split('\n');
  diff+=`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`+lines.map(x=>'+'+x+'\n').join('');
  if(!current.endsWith('\n'))diff+='\\ No newline at end of file\n';
  stats.push({path,status:'added',sha256:sha(readFileSync(path))});
 }
}
writeFileSync(dir+'scoped.diff',diff);
const releaseFiles=readdirSync(dir).filter(x=>!['SHA256SUMS','changed-files.json'].includes(x)).map(x=>dir+x);
const inventory=[...modified,...added,...releaseFiles,dir+'changed-files.json',dir+'SHA256SUMS'].sort();
writeFileSync(dir+'changed-files.json',JSON.stringify({localBaseSha:start.head,branch:start.branch,synchronized:false,pr59Base:'d5cc399d2b8e0ae3f3fcc91c800bcc2be4d7af19 (user-reported, not local HEAD)',sourceFiles:stats,files:inventory,scopedDiff:'Source changes relative to exact local pre-task Ratings files. Release metadata/logs supplied directly; scoped.diff excludes itself and generated release metadata. Existing five migrations are prerequisites, omitted from payload.',excluded:['all unrelated files','root package/config/lock/toolchain','all .github workflows','Chat V2 PR #58','historical migrations','initial five Ratings migrations','prior ratings-v1 release artifacts','dependencies','real environment files','database data']},null,2)+'\n');
writeFileSync(dir+'SHA256SUMS',inventory.filter(x=>x!==dir+'SHA256SUMS').map(x=>sha(readFileSync(x))+'  '+x).join('\n')+'\n');
const payload=artifacts+'payload';
for(const path of inventory){const to=payload+'/'+path;mkdirSync(dirname(to),{recursive:true});copyFileSync(path,to);}
// Verify the exact scoped patch applies to reconstructed starting files without
// touching the working repository, then compare all patched source bytes under LF.
const check=artifacts+'patch-check';mkdirSync(check,{recursive:true});
for(const path of modified){const to=check+'/'+path;mkdirSync(dirname(to),{recursive:true});writeFileSync(to,readFileSync(artifacts+'before/'+path,'utf8').replace(/\r\n/g,'\n'));}
const patch=resolve(dir+'scoped.diff');
for(const args of [['apply','--check','--whitespace=error',patch],['apply','--whitespace=error',patch]]){
 const r=spawnSync('git',args,{cwd:resolve(check),env:{...process.env,GIT_CEILING_DIRECTORIES:resolve(artifacts)},encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
}
for(const path of [...modified,...added])assert.equal(readFileSync(check+'/'+path,'utf8').replace(/\r\n/g,'\n'),readFileSync(path,'utf8').replace(/\r\n/g,'\n'));
console.log(`PASS ${preserved.length-unrelatedChanges.length} starting files unchanged; ${unrelatedChanges.length} unrelated concurrent changes preserved/excluded; ${inventory.length} scoped payload files; patch application and source equality verified`);
