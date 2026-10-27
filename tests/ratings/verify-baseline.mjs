import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const git=(...args)=>{const r=spawnSync('git',args,{encoding:null,maxBuffer:8*1024*1024,windowsHide:true});if(r.status!==0)throw new Error('Git read failed');return r.stdout;};
const manifest='docs/extraction/MIGRATION_MANIFEST.sha256';
const source=git('show',`HEAD:${manifest}`).toString('utf8');
const entries=source.trimEnd().split('\n');assert.equal(entries.length,58);
for(const line of entries){const [,expected,path]=line.match(/^([a-f0-9]{64})  (.+)$/);assert.equal(createHash('sha256').update(git('show',`HEAD:${path}`)).digest('hex'),expected);
 assert.equal(git('hash-object','--path',path,path).toString().trim(),git('rev-parse',`HEAD:${path}`).toString().trim());}
assert.equal(git('hash-object','--path',manifest,manifest).toString().trim(),git('rev-parse',`HEAD:${manifest}`).toString().trim());
console.log('PASS 58 pinned historical Git blobs, unchanged working source under Git EOL conversion, and unchanged manifest');
