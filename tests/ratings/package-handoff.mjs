// Build only the explicitly scoped local handoff; never stages/commits Git files.
import {readFileSync,writeFileSync,readdirSync,copyFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../',import.meta.url));
const dir='releases/candidates/ratings-v1/';
const sha=b=>createHash('sha256').update(b).digest('hex');
const start=JSON.parse(readFileSync(root+dir+'starting-checkout.json','utf8').replace(/^\uFEFF/,''));
const concurrent=[];
for(const f of start.preserved_files){if(f.path==='package.json')continue;const current=sha(readFileSync(root+f.path));if(current!==f.sha256)concurrent.push({path:f.path,startingSha256:f.sha256,currentSha256:current});}
writeFileSync(root+dir+'concurrent-unrelated-changes.json',JSON.stringify({status:'UNRELATED_CONCURRENT_CHANGES_EXCLUDED',note:'These paths changed after the initial inventory. Ratings work did not edit them; they are excluded from payload and scoped diff. No restoration or overwrite performed.',files:concurrent},null,2)+'\n');
const current=readFileSync(root+'package.json','utf8');
const original=current.replace(/    "test:unit": "vitest run",\r?\n    "test:ratings": [^\r\n]+\r?\n    "test:ratings-contract": [^\r\n]+/, '    "test:unit": "vitest run"');
const oldHash=start.preserved_files.find(f=>f.path==='package.json').sha256;
const variants=[original,original.replace(/\r?\n/g,'\r\n'),original.replace(/\r\n/g,'\n')];
const old=variants.find(x=>sha(x)===oldHash);assert(old,'Cannot reconstruct original package.json exactly');
writeFileSync(root+dir+'package.starting.json',old);
const oldObject=JSON.parse(old),newObject=JSON.parse(current);delete newObject.scripts['test:ratings'];delete newObject.scripts['test:ratings-contract'];assert.deepEqual(newObject,oldObject);
const walk=rel=>readdirSync(root+rel,{withFileTypes:true}).filter(x=>x.name!=='node_modules').flatMap(x=>x.isDirectory()?walk(rel+'/'+x.name):[rel+'/'+x.name]);
const excluded=new Set([dir+'SHA256SUMS',dir+'scoped.diff',dir+'changed-files.json']);
let paths=['package.json','docs/contracts/ratings-v1.md',...walk('src/lib/ratings'),...walk('supabase/forward-migrations/ratings'),...walk('tests/ratings'),...walk(dir.slice(0,-1))].filter(x=>!excluded.has(x)).sort();
assert(paths.every(x=>!x.includes('node_modules')&&!x.includes('.env')));
writeFileSync(root+dir+'changed-files.json',JSON.stringify({baseHead:start.head,observedBranch:start.branch,synchronized:false,unrelatedFilesUnchanged:start.preserved_files.length-1-concurrent.length,concurrentUnrelatedChanges:concurrent.length,packageOriginalSha256:oldHash,files:[...paths,...excluded].sort(),scopedDiffExcludes:['SHA256SUMS','scoped.diff'],notes:'package.json patch is relative to exact starting dirty checkout; full source package snapshot also contains pre-existing dependency work. Apply only scoped script delta.'},null,2)+'\n');
paths.push(dir+'changed-files.json');paths.sort();
let diff='';
for(const path of paths){
 if(path==='package.json'){
  const r=spawnSync('git',['diff','--no-index','--text','--no-ext-diff','--',root+dir+'package.starting.json',root+'package.json'],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,1);const lines=r.stdout.split('\n');const firstHunk=lines.findIndex(x=>x.startsWith('@@'));
  diff+='diff --git a/package.json b/package.json\n--- a/package.json\n+++ b/package.json\n'+lines.slice(firstHunk).join('\n');
 }else{
  const text=readFileSync(root+path,'utf8').replace(/\r\n/g,'\n');const lines=text.endsWith('\n')?text.slice(0,-1).split('\n'):text.split('\n');
  diff+=`diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n`+lines.map(x=>'+'+x+'\n').join('');
  if(!text.endsWith('\n'))diff+='\\ No newline at end of file\n';
 }
}
writeFileSync(root+dir+'scoped.diff',diff);
paths.push(dir+'scoped.diff');paths.sort();
writeFileSync(root+dir+'SHA256SUMS',paths.map(path=>sha(readFileSync(root+path))+'  '+path).join('\n')+'\n');
console.log(`Prepared ${paths.length+1} scoped files; ${concurrent.length} unrelated concurrent changes excluded; exact original package verified`);
