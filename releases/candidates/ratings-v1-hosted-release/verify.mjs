// Offline integrity and preservation verification; success never authorizes deployment.
import {readFileSync as read,readdirSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../..');
const json=p=>JSON.parse(read(resolve(here,p),'utf8'));
const hash=x=>createHash('sha256').update(x).digest('hex');
const order=json('migration-order.json');assert.equal(order.length,6);
assert.deepEqual(order.map(x=>x.version),['20261026083608','20261026083610','20261026083612','20261026083613','20261026083614','20261026094908']);
for(const env of ['test','production']){
 const m=json(env+'/manifest.json');assert.equal(m.observedLedger.count,env==='test'?87:71);
 assert.equal(m.projectRef,env==='test'?'wpppxlnbzqynvhpeuavd':'kriuhwppxgxsyyrbjsau');
 assert.equal(m.observedLedger.rows.length,m.observedLedger.count);
 assert.equal(new Set(m.observedLedger.rows.map(x=>x.version)).size,m.observedLedger.count);
 assert(m.observedLedger.rows.every(x=>!order.some(y=>y.version===x.version)));
 assert.deepEqual(readdirSync(resolve(here,env,'supabase/migrations')).sort(),order.map(x=>x.file));
 assert.deepEqual(m.applyOrder,order);
 for(const x of order){assert.equal(hash(read(resolve(root,x.source))),x.sha256);assert.equal(hash(read(resolve(here,env,'supabase/migrations',x.file))),x.sha256);}
 for(const name of ['preflight.sql','postflight.sql','inactive.sql','rollback-disable.sql']){
  const sql=read(resolve(here,env,name),'utf8');assert(sql.includes(m.projectRef));assert(!sql.includes(env==='test'?'kriuhwppxgxsyyrbjsau':'wpppxlnbzqynvhpeuavd'));
  if(name.endsWith('flight.sql')){assert(sql.startsWith('begin read only;'));assert(sql.includes('RATINGS_FULL_LEDGER_DRIFT'));}
 }
 assert.equal(json(env+'/receipt.template.json').status,'NOT_EXECUTED');
}
assert.deepEqual(json('production/manifest.json').missingLedgerStatements,['20261023160752']);
const drift=[];
for(const x of json('starting-state.json').unrelated)if(x.sha256!==null){const observed=existsSync(resolve(root,x.path))?hash(read(resolve(root,x.path))):null;if(observed!==x.sha256)drift.push({path:x.path,startingSha256:x.sha256,observedSha256:observed});}
if(existsSync(resolve(here,'SHA256SUMS')))for(const line of read(resolve(here,'SHA256SUMS'),'utf8').trim().split('\n')){
 const [,expected,path]=line.match(/^([0-9a-f]{64})  (.+)$/);assert.equal(hash(read(resolve(here,path))),expected,path);
}
console.log('PASS isolated 87/71 manifests, six byte-identical payloads, environment guards and missing-history blocker');
console.log(drift.length?'UNRELATED CONCURRENT DRIFT: '+JSON.stringify(drift):'PASS unrelated byte preservation');
if(process.argv.includes('--preservation')&&drift.length)process.exitCode=1;
if(process.argv.includes('--ready')){console.error('BLOCKED: exclusive authority, current per-environment backup/restore and full source history provenance are not supplied; Production ledger statements unavailable. This package is not apply-ready.');process.exitCode=2;}
