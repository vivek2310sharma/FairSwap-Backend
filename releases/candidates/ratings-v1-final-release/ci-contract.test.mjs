import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync as read} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url)),root=resolve(here,'../../..');
const json=p=>JSON.parse(read(resolve(here,p),'utf8'));
export function validateCi(source){
 const job=source.match(/^  ratings-hosted-readiness-pg17:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/m)?.[1];assert(job,'Mandatory PG17 readiness job missing');
 assert(!/continue-on-error|^    if:|secrets:|environment:|pull_request_target/.test(job));
 assert(job.includes('bash tests/ratings/build-native-pg17.sh'));
 assert(job.includes('node --test releases/candidates/ratings-v1-final-release/ci-contract.test.mjs'));
 assert(job.includes('run-pg17.sh'));assert(job.includes('env -i PATH='));
 const gate=source.slice(source.indexOf('  backend-ci-success:'));
 const needs=gate.match(/^    needs: \[([^\]]+)\]/m)?.[1].split(',').map(x=>x.trim());
 const jobs=[...source.slice(source.indexOf('\njobs:\n')).matchAll(/^  ([\w-]+):$/gm)].map(x=>x[1]).filter(x=>x!=='backend-ci-success');
 for(const id of jobs){assert(needs.includes(id),'Verification job omitted from aggregate: '+id);assert(gate.includes('needs.'+id+'.result'),'Missing result check: '+id);}
 assert(gate.includes('RATINGS_READINESS_RESULT: ${{ needs.ratings-hosted-readiness-pg17.result }}'));
 assert(gate.includes('"$RATINGS_READINESS_RESULT" == success'));
 assert(!gate.includes('continue-on-error'));assert(gate.includes('if: ${{ always() }}'));
}
test('hosted PG17 runs on every existing CI trigger and is mandatory in aggregate',()=>validateCi(read(resolve(root,'.github/workflows/backend-ci.yml'),'utf8').replaceAll('\r\n','\n')));
test('reviewed PR CI integration retains every original job, step and aggregate result check',()=>{
 const before=read(resolve(here,'ci-reviewed-head.before.yml'),'utf8'),after=read(resolve(here,'ci-reviewed-head.after.yml'),'utf8');validateCi(after);
 const stripped=after.replace(/^  ratings-hosted-readiness-pg17:\n[\s\S]*?(?=^  backend-ci-success:)/m,'').replace(', ratings-hosted-readiness-pg17]',']').replace(/^          RATINGS_READINESS_RESULT:.*\n/m,'').replace(' && "$RATINGS_READINESS_RESULT" == success','');
 assert.equal(stripped,before);
});
test('missing job, omitted dependency or ignored readiness failure cannot satisfy CI contract',()=>{
 const source=read(resolve(root,'.github/workflows/backend-ci.yml'),'utf8').replaceAll('\r\n','\n');
 for(const altered of [source.replace('ratings-hosted-readiness-pg17:','removed-readiness:'),source.replace(', ratings-hosted-readiness-pg17]',']'),source.replace('&& "$RATINGS_READINESS_RESULT" == success',''),source.replace('  ratings-hosted-readiness-pg17:\n','  ratings-hosted-readiness-pg17:\n    continue-on-error: true\n')])assert.throws(()=>validateCi(altered));
});
test('waiver is release-specific in both records and waives no other gate',()=>{
 for(const env of ['test','production'])for(const file of ['manifest.json','release-record.json','receipt.template.json']){
  const w=json(env+'/'+file).backupRestore;assert.equal(w.status,'WAIVED_BY_OWNER');assert.equal(w.release,'Ratings V1 only');assert.equal(w.backupExists,'NOT_VERIFIED');assert.equal(w.restoreTestPassed,false);assert(w.risk.includes('irreversible data loss'));assert(w.risk.includes('downtime'));assert(w.risk.includes('No other gate is waived'));
 }
});
test('six raw migration bytes equal source fetched at reviewed PR SHA',()=>{
 const sources=json('reviewed-ratings-source.json');assert.equal(sources.reviewedPrHead,'5d3378a9d35c734193bbfcf421864d3b91865947');assert.equal(sources.files.length,6);
 for(const f of sources.files)assert.equal(read(resolve(root,f.path),'utf8'),f.content,f.path);
});
test('HDR-03 NULL exception is Production-only and full ledger/security checks remain',()=>{
 const prod=read(resolve(here,'production/preflight.sql'),'utf8'),testSql=read(resolve(here,'test/preflight.sql'),'utf8');
 assert(prod.includes('HDR03_HISTORICAL_CONTRACT_DRIFT'));assert(prod.includes("version='20261023160752' and name='hdr03_production_unread_counts' and statements is null"));
 assert(!testSql.includes('HDR03_HISTORICAL'));assert(!prod.includes('BLOCKED_HISTORY_STATEMENTS_MISSING'));
 for(const sql of [prod,testSql]){assert(sql.includes('RATINGS_FULL_LEDGER_DRIFT'));assert(sql.includes('PROTECTED_CONTRACT_DRIFT'));assert(sql.includes('RATINGS_ENVIRONMENT_MISMATCH'));assert(sql.startsWith('begin read only;'));}
});
