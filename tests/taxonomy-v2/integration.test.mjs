import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8');

test('all SQL/native/dependency prerequisites are pinned to current tracked main blobs',()=>{
 const pins=JSON.parse(read('tests/taxonomy-v2/prerequisites.json'));
 assert.equal(pins.commit,'1d475c3ff1326d2f2de3bb8e96b6947baaf77484');
 assert.equal(Object.keys(pins.files).length,18);
 for(const [path,pin] of Object.entries(pins.files)){
  const bytes=readFileSync(new URL('../../'+path,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256,path);
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`),bytes])).digest('hex'),pin.gitBlob,path);
 }
 const runner=read('tests/taxonomy-v2/run.mjs');
 assert.match(runner,/20261104120000_posting_v2_wearables/);
 assert(!runner.includes('20261103090000'));
 assert(!runner.includes('../FairSwap-Web'));
 assert(!runner.includes("require('pg')"));
 assert.match(runner,/tests\/ratings/);
 assert.match(runner,/native-races\.mjs/);
 assert(existsSync(new URL('../posting-v212/native-adapter.mjs',import.meta.url)));
});
test('PGlite and native taxonomy checks run in existing required jobs before aggregate success',()=>{
 const ci=read('.github/workflows/backend-ci.yml');
 const unit=ci.slice(ci.indexOf('  unit-integrity:'),ci.indexOf('  database-pg15:'));
 const native=ci.slice(ci.indexOf('  ratings-native-pg17:'),ci.indexOf('  ratings-hosted-readiness-pg17:'));
 for(const count of [53,55]){
  assert(unit.includes(`node tests/taxonomy-v2/run.mjs --category-count=${count}`));
  assert(native.includes(`node tests/taxonomy-v2/run.mjs --category-count=${count} --native-bin=`));
 }
 assert(unit.includes('tests/release/taxonomy-v2-release.test.mjs'));
 assert(native.indexOf('build-native-pg17.sh')<native.indexOf('tests/taxonomy-v2/run.mjs'));
 assert.match(ci,/needs: \[unit-integrity, database-pg15, ratings-native-pg17, ratings-hosted-readiness-pg17\]/);
 assert(!ci.includes('continue-on-error: true'));
});
