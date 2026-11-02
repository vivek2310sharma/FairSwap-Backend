import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../../.github/workflows/backend-ci.yml',import.meta.url),'utf8');
test('native posting regression is mandatory in the existing aggregate-gated PG17 job',()=>{
 const job=workflow.split('  ratings-native-pg17:')[1]?.split('\n  ratings-hosted-readiness-pg17:')[0];assert(job);
 assert.match(job,/tests\/ratings\/build-native-pg17\.sh/);
 const step=job.split('      - name: Require Posting V2.1.2 native PG17 multi-connection regressions')[1]?.split('\n      - name:')[0];assert(step);
 assert.match(step,/tests\/posting-v212\/run-native\.sh/);assert.doesNotMatch(step,/continue-on-error:|if:|\|\|\s*true/);
 const gate=workflow.split('  backend-ci-success:')[1];assert.match(gate,/needs:.*ratings-native-pg17/);assert.match(gate,/PG17_RESULT.*success/);
});
test('existing pinned dependency installation feeds the full posting fixture checks',()=>{
 assert.match(workflow,/npm ci --prefix tests\/ratings --ignore-scripts/);
 assert.match(workflow,/node scripts\/ci\/test-posting-v2\.mjs --pglite-module=tests\/ratings\/node_modules\/@electric-sql\/pglite\/dist\/index\.js/);
});
