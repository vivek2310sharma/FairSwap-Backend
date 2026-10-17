import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
export const base='cd9d697dd620375c681f2cff42340011d6242201';
export function verifyEvent(e, head) {
  assert.equal(e.repository?.full_name,'vivek2310sharma/FairSwap-Backend');
  const p=e.pull_request; assert.ok(p);
  assert.equal(p.head?.repo?.full_name,e.repository.full_name);
  assert.equal(p.base?.repo?.full_name,e.repository.full_name);
  assert.equal(p.head.ref,'test/stage3-moderation-pg17-compat');
  assert.equal(p.base.ref,'chore/backend-extraction-baseline');
  assert.equal(p.base.sha,base);
  assert.match(p.head.sha,/^[a-f0-9]{40}$/);
  assert.equal(head,p.head.sha);
}
export function verifyChanges(files) {
  assert.ok(files.length>0);
  assert.ok(files.every(f=>/^(scripts\/stage3\/[^/]+|tests\/stage3\/[^/]+|\.github\/workflows\/stage3-pg17-compat\.yml|docs\/extraction\/STAGE3_PG17_COMPATIBILITY\.md)$/.test(f)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const git=(...a)=>execFileSync('git',a,{encoding:'utf8'}).trim();
    assert.equal(process.env.GITHUB_EVENT_NAME,'pull_request');
    verifyEvent(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8')),git('rev-parse','HEAD'));
    git('merge-base','--is-ancestor',base,'HEAD');
    verifyChanges(git('diff','--name-only',base,'HEAD').split('\n').filter(Boolean));
    assert.equal(git('status','--porcelain'),'');
    console.log('PASS: same-repository PR, exact base, designated branches and source scope');
  } catch { console.error('FAIL: Stage 3 PR provenance or source scope');process.exitCode=1; }
}
