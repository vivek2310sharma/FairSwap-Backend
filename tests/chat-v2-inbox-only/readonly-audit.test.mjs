import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditProtection,bundleHash,inspectProtection,requireOwnerActors} from '../../scripts/release/inbox-protection.mjs';
import {auditOnly} from '../../scripts/release/audit-inbox-only.mjs';
import {auditFixture as originalFixture,fixtureApi} from './audit-fixture.mjs';
async function auditFixture(...args){
 const fixture=await originalFixture(...args);
 fixture.responses['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}];
 fixture.responses['/rulesets/25352225'].bypass_actors=[];
 return fixture;
}
const run=fixture=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses),fixture.evidence);

test('automatic audit needs no comment or ledger JSON and rejects omitted bypass metadata',async()=>{
 const fixture=await auditFixture();delete fixture.evidence.attestationJson;
 assert.equal((await run(fixture)).protected,true);
 for(const id of [25352225,25821687]){
  const copy=structuredClone(fixture);delete copy.responses['/rulesets/'+id].bypass_actors;
  await assert.rejects(()=>run(copy),/CHAT_RULESET_BYPASS_UNVERIFIABLE/);
 }
});

const invalidOwnerPolicies={
 'wrong owner name':r=>{r['/rulesets/25821687'].name='another-name';},
 'wrong owner ID':r=>{r['/rulesets/25821687'].id=99;},
 'wrong owner source':r=>{r['/rulesets/25821687'].source='foreign/repository';},
 'inherited owner exception':r=>{r['/rulesets/25821687'].source_type='Organization';},
 'owner wildcard target':r=>{r['/rulesets/25821687'].conditions.ref_name.include=['refs/heads/*'];},
 'owner non-main target':r=>{r['/rulesets/25821687'].conditions.ref_name.include=['refs/heads/release'];},
 'owner additional target':r=>{r['/rulesets/25821687'].conditions.ref_name.include.push('refs/heads/release');},
 'owner exclusions':r=>{r['/rulesets/25821687'].conditions.ref_name.exclude=['refs/heads/main'];},
 'owner missing conditions':r=>{delete r['/rulesets/25821687'].conditions;},
 'owner extra condition':r=>{r['/rulesets/25821687'].conditions.repository_name={include:['*'],exclude:[]};},
 'owner removed deletion rule':r=>{r['/rulesets/25821687'].rules.shift();},
 'owner removed non-fast-forward rule':r=>{r['/rulesets/25821687'].rules.splice(1,1);},
 'owner removed update rule':r=>{r['/rulesets/25821687'].rules.pop();},
 'owner duplicate update rule':r=>{r['/rulesets/25821687'].rules.push({type:'update'});},
 'owner PR rule':r=>{r['/rulesets/25821687'].rules.push({type:'pull_request'});},
 'owner CI rule':r=>{r['/rulesets/25821687'].rules.push({type:'required_status_checks'});},
 'effective PR assigned to owner':r=>{r['/rules/branches/main?per_page=100'][0].ruleset_id=25821687;},
 'effective CI assigned to owner':r=>{r['/rules/branches/main?per_page=100'][1].ruleset_id=25821687;},
 'owner missing effective update':r=>{r['/rules/branches/main?per_page=100'].pop();},
 'unknown effective ruleset':r=>{r['/rules/branches/main?per_page=100'].push({type:'update',ruleset_id:99});},
 'owner changed actor':r=>{r['/rulesets/25821687'].bypass_actors=[{actor_id:4,actor_type:'RepositoryRole',bypass_mode:'always'}];},
 'owner string actor ID':r=>{r['/rulesets/25821687'].bypass_actors=[{actor_id:'5',actor_type:'RepositoryRole',bypass_mode:'always'}];},
 'owner extra actor field':r=>{r['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always',other:true}];},
 'owner changed actor type':r=>{r['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'User',bypass_mode:'always'}];},
 'owner changed bypass mode':r=>{r['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'pull_request'}];},
 'owner additional actor':r=>{r['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'},{actor_id:6,actor_type:'RepositoryRole',bypass_mode:'always'}];},
 'owner empty visible list':r=>{r['/rulesets/25821687'].bypass_actors=[];},
 'owner malformed visible list':r=>{r['/rulesets/25821687'].bypass_actors=null;},
 'approval ruleset given owner actor':r=>{r['/rulesets/25352225'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}];},
 'approval ruleset renamed':r=>{r['/rulesets/25352225'].name='another-name';},
 'approval scope broadened':r=>{r['/rulesets/25352225'].conditions.ref_name.include=['refs/heads/*'];},
};
for(const [name,mutate]of Object.entries(invalidOwnerPolicies))test(`policy guard rejects ${name} before deployment`,async()=>{
 const fixture=await auditFixture();mutate(fixture.responses);
 await assert.rejects(()=>inspectProtection('FairSwapTest','fixture-token',fixture.evidence.sourceCommit,fixtureApi(fixture.responses)),/CHAT_/);
});

test('automatic snapshots bind conditions and rule parameters; mid-audit drift fails',async()=>{
 const fixture=await auditFixture(),first=await run(fixture);
 fixture.responses['/rulesets/25821687'].conditions.ref_name.include=['~DEFAULT_BRANCH'];
 assert.notEqual((await run(fixture)).snapshotSha256,first.snapshotSha256);
 const api=fixtureApi(fixture.responses);let reads=0;
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',async(url,options)=>{
  if(url.endsWith('/rulesets/25821687')&&++reads===2)fixture.responses['/rulesets/25821687'].rules[2].parameters={update_allows_fetch_and_merge:true};
  return api(url,options);
 },fixture.evidence),/CHAT_PROTECTION_CHANGED_DURING_AUDIT/);
});

const changes={
 'non-admin owner':r=>{const owner=r['/collaborators?affiliation=all&per_page=100'].find(user=>user.login==='vivek2310sharma');owner.permissions.admin=false;},
 'changed effective extra check':r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks.pop();},
 'changed required review count':r=>{r['/rules/branches/main?per_page=100'][0].parameters.required_approving_review_count=1;},
 'weakened stale review dismissal':r=>{r['/rules/branches/main?per_page=100'][0].parameters.dismiss_stale_reviews_on_push=false;},
 'missing required CI':r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks=[];},
 'disabled ruleset':r=>{r['/rulesets/25352225'].enforcement='disabled';},
 'visible bypass actors':r=>{r['/rulesets/25352225'].bypass_actors=[{actor_id:1}];},
 'malformed visible bypass list':r=>{r['/rulesets/25352225'].bypass_actors=null;},
 'changed environment reviewer':r=>{r['/environments/FairSwapTest'].protection_rules[0].reviewers[0].reviewer.id=99;},
 'missing environment reviewers':r=>{r['/environments/FairSwapTest'].protection_rules[0].reviewers=[];},
 'owner self-review prohibited':r=>{r['/environments/FairSwapTest'].protection_rules[0].prevent_self_review=true;},
 'administrator bypass allowed':r=>{r['/environments/FairSwapTest'].can_admins_bypass=true;},
 'weakened deployment branch restriction':r=>{r['/environments/FairSwapTest/deployment-branch-policies?per_page=100'].branch_policies[0].name='release/*';},
 'leaked repository database secret name':r=>{r['/actions/secrets?per_page=100']={total_count:1,secrets:[{name:'CHAT_DATABASE_PASSWORD'}]};},
 'leaked repository audit secret name':r=>{r['/actions/secrets?per_page=100']={total_count:1,secrets:[{name:'CHAT_RELEASE_AUDIT_TOKEN'}]};},
 'missing environment secret name':r=>{r['/environments/FairSwapTest/secrets?per_page=100']={total_count:0,secrets:[]};},
 'incomplete secrets page':r=>{r['/actions/secrets?per_page=100'].total_count=101;},
 'incomplete branch page':r=>{r['/environments/FairSwapTest/deployment-branch-policies?per_page=100'].total_count=2;},
 'changed main commit':r=>{r['/git/ref/heads/main'].object.sha='c'.repeat(40);},
};
for(const [name,mutate]of Object.entries(changes))test(`audit fails closed: ${name}`,async()=>{
 const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),/CHAT_/);
});

test('all used endpoints, transport failures and pagination fail closed without upstream text',async()=>{
 const fixture=await auditFixture(),calls=[];
 await auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{calls}),fixture.evidence);
 for(const path of Object.keys(fixture.responses).filter(path=>!path.startsWith('/issues/comments/')&&path!=='/collaborators/vivek2310sharma/permission'))
  await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{denied:[path]}),fixture.evidence),/CHAT_ADMIN_PROTECTION_UNVERIFIABLE/);
 for(const path of ['/rules/branches/main?per_page=100','/rulesets/25352225','/actions/secrets?per_page=100'])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{links:{[path]:'<https://api.github.com/next>; rel="next"'}}),fixture.evidence),/CHAT_ADMIN_PAGINATION_INCOMPLETE/);
 for(const fetcher of [async()=>{throw Error('private-upstream-token');},async()=>({ok:true,headers:new Headers(),json:async()=>{throw Error('private-upstream-token');}})])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),error=>error.message==='CHAT_ADMIN_PROTECTION_UNVERIFIABLE');
});

test('optional audit-only verifies both environments without database credentials or deployment claims',async()=>{
 for(const environment of ['FairSwapTest','FairSwapProd']){
  const bundle=bundleHash(),fixture=await auditFixture(environment,bundle),calls=[];
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,CHAT_RELEASE_AUDIT_TOKEN:'fixture-token'};
  const result=await auditOnly(environment,bundle,{env,fetcher:fixtureApi(fixture.responses,{calls})});
  assert.equal(result.status,'verified');assert.equal(result.databaseAccess,false);assert.equal(result.activation,false);assert.equal(result.flagsOff,undefined);
  assert(calls.every(c=>c.method==='GET'&&c.redirect==='error'));assert(!JSON.stringify(result).includes('fixture-token'));
  await assert.rejects(()=>auditOnly(environment,bundle,{env:{...env,CHAT_DATABASE_PASSWORD:'private'},fetcher:()=>assert.fail('API must not run')}),/DATABASE_SECRET_FORBIDDEN/);
  await assert.rejects(()=>auditOnly(environment,bundle,{env:{...env,GITHUB_REF:'refs/heads/unreviewed'},fetcher:()=>assert.fail('API must not run')}),/IMMUTABLE_INPUT/);
 }
});

test('malformed protection metadata fails with fixed categories rather than being treated as empty',async()=>{
 for(const mutate of [r=>{r['/environments/FairSwapTest'].protection_rules=null;},r=>{r['/rules/branches/main?per_page=100']=[null];},r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks=[null];}]){
  const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),error=>/^CHAT_[A-Z_]+$/.test(error.message));
 }
});

test('audit workflow has separately protected sequential jobs and cannot reach the release path',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 const audit=workflow.slice(workflow.indexOf('  audit_verify:'));
 assert(workflow.includes('inputs.deploy && !inputs.audit_only'));assert(audit.includes('inputs.audit_only && !inputs.deploy'));
 assert(audit.includes('environment: FairSwapTest'));assert(audit.includes('environment: FairSwapProd'));assert(audit.includes('needs: audit_test'));
 assert(!/CHAT_DATABASE_PASSWORD|CHAT_RELEASE_ENABLED|install-inbox-cli|protected-inbox-release\.mjs|psql|migration up|set enabled/.test(audit));
 assert(!/child_process|protected-inbox-release|protected-inbox-plan|supabase-js/.test(readFileSync(new URL('../../scripts/release/audit-inbox-only.mjs',import.meta.url),'utf8')));
 const protectedFiles=JSON.parse(readFileSync(new URL('../../releases/candidates/chat-v2-inbox-only/protected-files.json',import.meta.url),'utf8'));
 for(const file of ['scripts/release/audit-inbox-only.mjs','tests/chat-v2-inbox-only/readonly-audit.test.mjs','tests/chat-v2-inbox-only/audit-fixture.mjs'])assert(protectedFiles.includes(file));
});

test('the required native PG17 PR job runs the read-only audit suite without filters or conditional skips',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-pg17.yml',import.meta.url),'utf8');
 assert(/^  pull_request:\s*$/m.test(workflow));assert(/^  chat-inbox-native-pg17:\s*$/m.test(workflow));
 assert(workflow.includes('- run: node --test tests/chat-v2-inbox-only/protected-release.test.mjs tests/chat-v2-inbox-only/readonly-audit.test.mjs'));
 assert(workflow.includes('- run: bash scripts/ci/run-chat-inbox-pg17.sh'));
 assert(!/^\s*(?:if|paths|paths-ignore):/m.test(workflow));assert(!/continue-on-error:|secrets\./.test(workflow));
 assert(workflow.includes('contents: read'));assert(workflow.includes('persist-credentials: false'));
});

test('audit-only CLI rejects database credentials before any API and emits only a fixed failure',()=>{
 const privateValue='synthetic-do-not-echo-credential';
 const result=spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/release/audit-inbox-only.mjs',import.meta.url)),'FairSwapTest','b'.repeat(64)],{encoding:'utf8',env:{PATH:process.env.PATH,CHAT_DATABASE_PASSWORD:privateValue}});
 assert.equal(result.status,1);assert.equal(result.stderr.trim(),'CHAT_AUDIT_DATABASE_SECRET_FORBIDDEN');assert.equal(result.stdout,'');assert(!result.stderr.includes(privateValue));
});

test('owner-authored PRs need no independent approval while contributor PRs retain no main-update bypass',async()=>{
 const fixture=await auditFixture();
 assert.equal(fixture.responses['/rules/branches/main?per_page=100'][0].parameters.required_approving_review_count,0);
 assert.equal((await run(fixture)).protected,true);
 const owner=fixture.responses['/collaborators?affiliation=all&per_page=100'].find(user=>user.permissions.admin);
 assert.equal(owner.login,'vivek2310sharma');
 for(const bypass of [{actor_id:33,actor_type:'User',bypass_mode:'always'},{actor_id:4,actor_type:'RepositoryRole',bypass_mode:'always'}]){
  fixture.responses['/rulesets/25821687'].bypass_actors=[bypass];
  await assert.rejects(()=>run(fixture),/CHAT_RULESET_BYPASS_FORBIDDEN/);
 }
});

const inventoryChanges={
 'another administrator could merge':r=>{const users=r['/collaborators?affiliation=all&per_page=100'];users[1].role_name='admin';users[1].permissions={...users[0].permissions};},
 'maintainer elevation':r=>{const user=r['/collaborators?affiliation=all&per_page=100'][1];user.role_name='maintain';user.permissions.maintain=true;},
 'custom privileged role':r=>{r['/collaborators?affiliation=all&per_page=100'][1].role_name='custom-admin';},
 'unrecognized permission field':r=>{r['/collaborators?affiliation=all&per_page=100'][1].permissions.bypass_rules=true;},
 'inconsistent base role':r=>{r['/collaborators?affiliation=all&per_page=100'][1].role_name='read';},
 'missing permission metadata':r=>{delete r['/collaborators?affiliation=all&per_page=100'][1].permissions.admin;},
 'bot privilege':r=>{r['/collaborators?affiliation=all&per_page=100'][1].type='Bot';},
 'duplicate collaborator':r=>{r['/collaborators?affiliation=all&per_page=100'].push(structuredClone(r['/collaborators?affiliation=all&per_page=100'][1]));},
 'empty collaborator login':r=>{r['/collaborators?affiliation=all&per_page=100'][1].login='';},
 'duplicate collaborator login':r=>{const copy=structuredClone(r['/collaborators?affiliation=all&per_page=100'][1]);copy.id=44;r['/collaborators?affiliation=all&per_page=100'].push(copy);},
 'missing owner':r=>{r['/collaborators?affiliation=all&per_page=100'].shift();},
 'empty inventory':r=>{r['/collaborators?affiliation=all&per_page=100']=[];},
 'malformed inventory':r=>{r['/collaborators?affiliation=all&per_page=100']={};},
 'full possibly truncated inventory':r=>{r['/collaborators?affiliation=all&per_page=100']=Array(100).fill(r['/collaborators?affiliation=all&per_page=100'][0]);},
 'wrong repository owner':r=>{r[''].owner.login='someone-else';},
 'additional deployment reviewer':r=>{r['/environments/FairSwapTest'].protection_rules[0].reviewers.push({type:'User',reviewer:{id:33,login:'contributor'}});},
 'team deployment reviewer':r=>{r['/environments/FairSwapTest'].protection_rules[0].reviewers[0].type='Team';},
 'policy PR approvals changed':r=>{r['/rulesets/25352225'].rules[0].parameters.required_approving_review_count=1;},
 'policy CI weakened':r=>{r['/rulesets/25352225'].rules[1].parameters.required_status_checks=[];},
 'PR requirement removed':r=>{r['/rules/branches/main?per_page=100']=r['/rules/branches/main?per_page=100'].filter(rule=>rule.type!=='pull_request');},
};
for(const [name,mutate]of Object.entries(inventoryChanges))test(`solo-owner governance rejects ${name}`,async()=>{
 const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),/CHAT_/);
});

test('complete collaborator inventory is mandatory, including denial and pagination checks',async()=>{
 const fixture=await auditFixture(),path='/collaborators?affiliation=all&per_page=100';
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{denied:[path]}),fixture.evidence),/UNVERIFIABLE/);
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{links:{[path]:'<https://api.github.com/next>; rel="next"'}}),fixture.evidence),/PAGINATION_INCOMPLETE/);
});

test('both original and rerun deployment actors must be the owner before any API access',async()=>{
 const fixture=await auditFixture('FairSwapTest',bundleHash());
 const context={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma'};
 requireOwnerActors(context);
 for(const delta of [{GITHUB_ACTOR:'contributor'},{GITHUB_TRIGGERING_ACTOR:'contributor'},{GITHUB_EVENT_NAME:'pull_request'},{GITHUB_ACTIONS:'false'}]){
  assert.throws(()=>requireOwnerActors({...context,...delta}),/CHAT_OWNER_DISPATCH_REQUIRED/);
  await assert.rejects(()=>auditOnly('FairSwapTest',bundleHash(),{env:{...context,...delta},fetcher:()=>assert.fail('API must not run')}),/CHAT_OWNER_DISPATCH_REQUIRED/);
 }
});

test('one deploy dispatch captures ledgers automatically and carries trusted Test outputs to Prod',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 const jobs=workflow.slice(workflow.indexOf('jobs:')).split(/\n(?=  [a-z_]+:\n)/).slice(1);
 assert.equal(jobs.length,6);
 for(const job of jobs){assert(job.includes("github.actor == 'vivek2310sharma'"));assert(job.includes("github.triggering_actor == 'vivek2310sharma'"));}
 assert(workflow.includes('needs: [verify, test]'));assert(workflow.includes('needs.test.outputs.ledger_sha'));
 assert(workflow.includes('fairswapprod "$BUNDLE_SHA" "$TEST_LEDGER_SHA"'));
 for(const stale of ['CHAT_APPROVED_LEDGER_JSON','CHAT_RELEASE_ADMIN_ATTESTATION_JSON','CHAT_BACKEND_AUTHORITY_RECEIPT','inputs.test_ledger_sha256','inputs.prod_ledger_sha256'])assert(!workflow.includes(stale));
 assert(workflow.includes('artifact-ids: ${{ needs.test.outputs.artifact_id }}'));
 assert(workflow.includes('EXPECTED_RECEIPT_SHA: ${{ needs.test.outputs.receipt_sha }}'));
});

test('unauthorized Production release stops before GitHub API or database access',async()=>{
 const fixture=await auditFixture('FairSwapProd',bundleHash()),directory=mkdtempSync(join(tmpdir(),'chat-solo-owner-prod.'));
 try{
  mkdirSync(join(directory,'test-evidence'));writeFileSync(join(directory,'test-evidence/receipt.json'),JSON.stringify({environment:'FairSwapTest',status:'failed'}));
  const env={PATH:process.env.PATH,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',CHAT_RELEASE_ENABLED:'true',CHAT_ENVIRONMENT_ENABLED:'true',CHAT_WEB_FLAG_OFF_CONFIRMED:'true',CHAT_BACKEND_AUTHORITY_RECEIPT:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/60',CHAT_APPROVED_LEDGER_JSON:fixture.ledgerJson,CHAT_DATABASE_PASSWORD:'synthetic-private-database-password'};
  for(const [delta,expected]of [[{},'CHAT_SAME_RUN_TEST_EVIDENCE_REQUIRED'],[{GITHUB_ACTOR:'contributor'},'CHAT_OWNER_DISPATCH_REQUIRED'],[{GITHUB_TRIGGERING_ACTOR:'contributor'},'CHAT_OWNER_DISPATCH_REQUIRED']]){
   const result=spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/release/protected-inbox-release.mjs',import.meta.url)),'fairswapprod',bundleHash(),'f'.repeat(64)],{cwd:directory,encoding:'utf8',env:{...env,...delta}});
   assert.equal(result.status,1);assert(result.stderr.includes(expected));assert(!result.stderr.includes('synthetic-private'));assert.equal(result.stdout,'');
  }
 }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert(basename(directory).startsWith('chat-solo-owner-prod.'));rmSync(directory,{recursive:true,force:true});}
});

test('GitHub offset timestamps canonicalize while raw policy timestamps remain fingerprinted',async()=>{
 const clock=Date.now;Date.now=()=>Date.parse('2026-10-28T00:00:00Z');
 try{
  const stamps={25352225:'2026-10-27T15:52:55.449+01:00',25821687:'2026-10-25T13:56:33.413+01:00'};
  const fixture=await auditFixture('FairSwapTest','b'.repeat(64),stamps);
  assert.deepEqual(fixture.inspection.rulesets.map(rule=>rule.updatedAt),['2026-10-27T14:52:55.449Z','2026-10-25T12:56:33.413Z']);
  assert.equal((await run(fixture)).protected,true);
  for(const stamp of ['2026-10-27T09:22:55.449-05:30','2026-10-28T04:52:55.449+14:00','2026-10-27T14:52:55.449Z']){
   fixture.responses['/rulesets/25352225'].updated_at=stamp;
   const inspection=await inspectProtection('FairSwapTest','fixture-token',fixture.evidence.sourceCommit,fixtureApi(fixture.responses));
   assert.equal(inspection.rulesets[0].updatedAt,'2026-10-27T14:52:55.449Z');
   assert.notEqual(inspection.rulesets[0].policySha256,fixture.inspection.rulesets[0].policySha256);
   assert.notEqual((await run(fixture)).snapshotSha256,fixture.inspection.snapshotSha256);
  }
 }finally{Date.now=clock;}
});

test('invalid API timestamp calendars, missing zones and ambiguous offsets fail closed',async()=>{
 const fixture=await auditFixture();
 for(const stamp of ['2026-02-29T12:00:00Z','2026-04-31T12:00:00+01:00','2026-10-27T24:00:00Z','2026-10-27T12:00:60Z','2026-10-27T12:00:00','2026-10-27T12:00:00-00:00','2026-10-27T12:00:00+14:01','2026-10-27T12:00:00+15:00','2026-10-27T12:00:00+01:60','2026-10-27T12:00:00+0100','2026-10-27T12:00:00+1:00','private-upstream-value',null,123]){
  fixture.responses['/rulesets/25352225'].updated_at=stamp;
  await assert.rejects(()=>run(fixture),error=>error.message==='CHAT_RULESET_METADATA_REQUIRED');
 }
});

test('missing or malformed effective ruleset IDs require provider metadata without inferring source rules',async()=>{
 for(const value of [undefined,null,'25352225',0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  const fixture=await auditFixture(),calls=[];
  if(value===undefined)delete fixture.responses['/rules/branches/main?per_page=100'][0].ruleset_id;
  else fixture.responses['/rules/branches/main?per_page=100'][0].ruleset_id=value;
  await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{calls}),fixture.evidence),error=>error.message==='CHAT_EFFECTIVE_RULE_RULESET_ID_REQUIRED');
  assert(!calls.some(call=>call.path.startsWith('/rulesets/')));
 }
});

test('offset ruleset updates during automatic verification cannot authorize release',async()=>{
 const clock=Date.now;Date.now=()=>Date.parse('2026-10-28T00:00:00Z');
 try{
  const fixture=await auditFixture('FairSwapTest','b'.repeat(64),{25352225:'2026-10-28T01:00:00+01:00'});
  const api=fixtureApi(fixture.responses);let reads=0;
  await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',async(url,options)=>{
   if(url.endsWith('/rulesets/25352225')&&++reads===2)fixture.responses['/rulesets/25352225'].updated_at='2026-10-28T02:00:00+01:00';
   return api(url,options);
  },fixture.evidence),error=>error.message==='CHAT_PROTECTION_CHANGED_DURING_AUDIT');
 }finally{Date.now=clock;}
});
