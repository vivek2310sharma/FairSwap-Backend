// Offline evidence-chain verification, not migration-history repair.
import {readFileSync as read} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../../..');
const json=p=>JSON.parse(read(resolve(here,p),'utf8'));
const lf=s=>s.replaceAll('\r\n','\n');
const sha=s=>createHash('sha256').update(s).digest('hex');
export function verifySource(){
 const remote=json('reviewed-source.json'),receipt=json('receipt.json');
 const manifest=JSON.parse(read(resolve(root,'releases/production/hdr-03/manifest.json'),'utf8'));
 const reviewed=lf(remote.content),local=lf(read(resolve(root,remote.path),'utf8'));
 assert.equal(remote.commit,'24ed66196d8402fbfc0aa80f4f47abd943a61447');
 assert.equal(local,reviewed,'Local historical SQL differs from merged PR #49');
 assert.equal(sha(local),manifest.files['supabase/migrations/'+manifest.migration.file]);
 assert.equal(receipt.id,6371622862);assert.equal(receipt.author,'vivek2310sharma');
 for(const marker of ['24ed66196d8402fbfc0aa80f4f47abd943a61447','20261023160752_hdr03_production_unread_counts','single transaction','exact history receipt'])assert(receipt.body.includes(marker));
 return {reviewedSqlLfSha256:sha(local),gitBlob:remote.gitBlob,mergeSha:remote.commit,receiptUrl:receipt.url};
}
if(process.argv[1]===fileURLToPath(import.meta.url))console.log('PASS HDR-03 reviewed PR #49 SQL, immutable manifest and deployment receipt: '+JSON.stringify(verifySource()));
