import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const assertions=74;
export function inspectTap(log,exitCode) {
  assert.equal(typeof log,'string');
  assert.ok(Number.isInteger(exitCode)&&exitCode>=0);
  const plans=[...log.matchAll(/^1\.\.(\d+)\r?$/gm)];
  const rows=[...log.matchAll(/^(not ok|ok) (\d+)(?:[ \t]|$)([^\r\n]*)/gm)];
  const observed=[...log.matchAll(/^# STAGE3 (\{[^\r\n]+\})\r?$/gm)].map(m=>JSON.parse(m[1]));
  const observations=observed.map(o=>{
    assert.deepEqual(Object.keys(o).sort(),['case','sqlstate','request_status','listing_status','attempt_count','results','revision_matches','lease_retained'].sort());
    assert.ok(['goods','cars','two-wheelers','property'].includes(o.case));
    assert.match(o.sqlstate,/^[A-Z0-9]{5}$/);
    assert.ok(['pending','claimed','completed','retry','failed','superseded'].includes(o.request_status));
    assert.ok(['pending_review','active','rejected'].includes(o.listing_status));
    for(const k of ['attempt_count','results'])assert.ok(Number.isSafeInteger(o[k])&&o[k]>=0&&o[k]<=100);
    for(const k of ['revision_matches','lease_retained'])assert.equal(typeof o[k],'boolean');
    return o;
  });
  assert.equal(new Set(observations.map(o=>o.case)).size,observations.length);
  const complete=plans.length===1&&Number(plans[0][1])===assertions&&rows.length===assertions
    &&rows.every((r,i)=>Number(r[2])===i+1)&&observations.length===4;
  const failed=rows.filter(r=>r[1]==='not ok').map(r=>Number(r[2]));
  const directives=rows.some(r=>/#\s*(?:SKIP|TODO)\b/i.test(r[3]));
  const errors=/(?:^|\n)(?:Bail out!|ERROR:|psql:.*ERROR:)/i.test(log);
  return {executed:true,passed:complete&&failed.length===0&&!directives&&!errors&&exitCode===0,
    assertionsObserved:rows.length,failed,observations};
}
export function verifyTap(log,exitCode) {
  const result=inspectTap(log,exitCode);assert.equal(result.passed,true);return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try { const [log,exit]=process.argv.slice(2);verifyTap(readFileSync(log,'utf8'),Number(exit)); }
 catch { console.error('FAIL: Stage 3 TAP incomplete or compatibility assertions failed');process.exitCode=1; }
}
