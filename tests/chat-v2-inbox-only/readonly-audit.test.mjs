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
import {auditFixture,fixtureApi} from './audit-fixture.mjs';
const run=fixture=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses),fixture.evidence);

test('read-only omitted bypass lists require owner evidence even when explicitly empty',async()=>{
 const fixture=await auditFixture();
 assert.equal((await run(fixture)).protected,true);
 fixture.responses['/rulesets/25352225'].bypass_actors=[];
 assert.equal((await run(fixture)).protected,true);
 for(const attestationJson of [undefined,'','null','{}','private-token-not-json'])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses),{...fixture.evidence,attestationJson}),/CHAT_ADMIN_ATTESTATION/);
});

test('only the exact visible and owner-attested update actor is accepted',async()=>{
 const fixture=await auditFixture();
 fixture.responses['/rulesets/25821687'].bypass_actors=[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}];
 fixture.responses['/rulesets/25352225'].bypass_actors=[];
 assert.equal((await run(fixture)).protected,true);
 const owner=fixture.attestation.payload.rulesets.find(rule=>rule.id===25821687);
 for(const bypassActors of [[],undefined,[{actor_id:4,actor_type:'RepositoryRole',bypass_mode:'always'}],[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'pull_request'}]]){
  owner.bypassActors=bypassActors;fixture.evidence.attestationJson=JSON.stringify(fixture.attestation);
  await assert.rejects(()=>run(fixture),/CHAT_ADMIN_ATTESTATION_RULESET_MISMATCH/);
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
for(const [name,mutate]of Object.entries(invalidOwnerPolicies))test(`policy guard rejects ${name} before attestation`,async()=>{
 const fixture=await auditFixture();mutate(fixture.responses);
 await assert.rejects(()=>inspectProtection('FairSwapTest','fixture-token',fixture.evidence.sourceCommit,fixtureApi(fixture.responses)),/CHAT_/);
});

test('owner conditions and rule parameters remain bound to the exact reviewed snapshot',async()=>{
 for(const mutate of [r=>{r['/rulesets/25821687'].conditions.ref_name.include=['~DEFAULT_BRANCH'];},r=>{r['/rulesets/25821687'].rules[2].parameters={update_allows_fetch_and_merge:true};}]){
  const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),/CHAT_ADMIN_ATTESTATION_INVALID/);
 }
});

const invalidAttestations={
 'wrong commit':f=>{f.attestation.payload.sourceCommit='c'.repeat(40);},
 'wrong environment':f=>{f.attestation.payload.environment='FairSwapProd';},
 'wrong bundle':f=>{f.attestation.payload.bundleSha256='c'.repeat(64);},
 'wrong snapshot':f=>{f.attestation.payload.snapshotSha256='c'.repeat(64);},
 'expired attestation':f=>{f.attestation.payload.expiresAt=new Date(Date.now()-1000).toISOString();},
 'future observation':f=>{f.attestation.payload.observedAt=new Date(Date.now()+60000).toISOString();},
 'overlong validity':f=>{f.attestation.payload.expiresAt=new Date(Date.now()+2*86400000).toISOString();},
 'legacy second reviewer':f=>{f.attestation.payload.reviewer={login:'invented-reviewer',id:22};},
 'wrong owner identity':f=>{f.attestation.payload.owner={login:'contributor',id:33};},
 'wrong ledger':f=>{f.attestation.payload.ledgerSha256='d'.repeat(64);},
 'missing ruleset attestation':f=>{f.attestation.payload.rulesets=[];},
 'attested bypass permission':f=>{f.attestation.payload.rulesets[0].bypassActors=[{actor_id:1}];},
 'stale ruleset version':f=>{f.attestation.payload.rulesets[0].updatedAt='2020-01-01T00:00:00Z';},
 'unknown payload field':f=>{f.attestation.payload.ignoreBypass=true;},
};
for(const [name,mutate]of Object.entries(invalidAttestations))test(`attestation rejects ${name}`,async()=>{
 const fixture=await auditFixture();mutate(fixture);fixture.evidence.attestationJson=JSON.stringify(fixture.attestation);
 await assert.rejects(()=>run(fixture),/CHAT_ADMIN_ATTESTATION/);
});

const changes={
 'changed effective extra check':r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks.pop();},
 'changed required review count':r=>{r['/rules/branches/main?per_page=100'][0].parameters.required_approving_review_count=1;},
 'weakened stale review dismissal':r=>{r['/rules/branches/main?per_page=100'][0].parameters.dismiss_stale_reviews_on_push=false;},
 'missing required CI':r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks=[];},
 'ruleset changed after attestation':r=>{r['/rulesets/25352225'].updated_at=new Date().toISOString();},
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
 'non-admin owner':r=>{r['/collaborators/vivek2310sharma/permission'].permission='write';},
 'edited administrator statement':r=>{r['/issues/comments/101'].updated_at=new Date().toISOString();},
 'forged statement digest':r=>{r['/issues/comments/101'].body='unreviewed';},
 'wrong owner statement':r=>{r['/issues/comments/101'].body='CHAT_RELEASE_ADMIN_ATTESTATION_V1';},
 'wrong owner author':r=>{r['/issues/comments/101'].user.id=99;},
 'bot owner statement':r=>{r['/issues/comments/101'].user.type='Bot';},
 'wrong evidence repository':r=>{r['/issues/comments/101'].issue_url='https://api.github.com/repos/foreign/repo/issues/60';},
};
for(const [name,mutate]of Object.entries(changes))test(`audit fails closed: ${name}`,async()=>{
 const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),/CHAT_/);
});

test('all denied endpoints, transport/JSON failures and pagination links fail closed without upstream text',async()=>{
 const fixture=await auditFixture();
 for(const path of Object.keys(fixture.responses))await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{denied:[path]}),fixture.evidence),/CHAT_ADMIN_PROTECTION_UNVERIFIABLE/);
 for(const path of ['/rules/branches/main?per_page=100','/rulesets/25352225','/actions/secrets?per_page=100'])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{links:{[path]:'<https://api.github.com/next>; rel="next"'}}),fixture.evidence),/CHAT_ADMIN_PAGINATION_INCOMPLETE/);
 for(const fetcher of [async()=>{throw Error('private-upstream-token');},async()=>({ok:true,headers:new Headers(),json:async()=>{throw Error('private-upstream-token');}})])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),error=>error.message==='CHAT_ADMIN_PROTECTION_UNVERIFIABLE');
});

test('audit-only verifies both environments using GETs, without DB credentials or database claims',async()=>{
 for(const environment of ['FairSwapTest','FairSwapProd']){
  const bundle=bundleHash(),fixture=await auditFixture(environment,bundle),calls=[],reports=[];
  const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',CHAT_APPROVED_LEDGER_JSON:fixture.ledgerJson,LEDGER_SHA:fixture.evidence.ledgerSha256,GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,CHAT_RELEASE_AUDIT_TOKEN:'fixture-token',CHAT_RELEASE_ADMIN_ATTESTATION_JSON:fixture.evidence.attestationJson};
  const result=await auditOnly(environment,bundle,{env,fetcher:fixtureApi(fixture.responses,{calls}),report:v=>reports.push(v)});
  assert.equal(result.status,'verified');assert.equal(result.databaseAccess,false);assert.equal(result.activation,false);assert.equal(result.flagsOff,undefined);
  assert(calls.every(c=>c.method==='GET'&&c.redirect==='error'));assert.equal(reports[0].status,'UNAPPROVED_SNAPSHOT');assert(!JSON.stringify([result,...reports]).includes('fixture-token'));
  await assert.rejects(()=>auditOnly(environment,bundle,{env:{...env,CHAT_DATABASE_PASSWORD:'do-not-use'},fetcher:()=>assert.fail('API must not run'),report:()=>{}}),/DATABASE_SECRET_FORBIDDEN/);
  await assert.rejects(()=>auditOnly(environment,bundle,{env:{...env,CHAT_RELEASE_ADMIN_ATTESTATION_JSON:''},fetcher:fixtureApi(fixture.responses),report:()=>{}}),/ATTESTATION_REQUIRED/);
  await assert.rejects(()=>auditOnly(environment,bundle,{env:{...env,GITHUB_REF:'refs/heads/unreviewed'},fetcher:()=>assert.fail('API must not run')}),/IMMUTABLE_INPUT/);
 }
});

test('protection changes while administrative comments are checked are rejected by the final snapshot',async()=>{
 const fixture=await auditFixture(),api=fixtureApi(fixture.responses);let changed=false;
 const fetcher=async(url,options)=>{
  const result=await api(url,options);
  if(url.endsWith('/issues/comments/101')&&!changed){changed=true;fixture.responses['/rules/branches/main?per_page=100'][1].parameters.required_status_checks.pop();}
  return result;
 };
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),/CHAT_PROTECTION_CHANGED_DURING_AUDIT/);
});

test('an attestation expiring during API verification cannot produce a successful audit',async()=>{
 const fixture=await auditFixture(),api=fixtureApi(fixture.responses),clock=Date.now;
 const fetcher=async(url,options)=>{const result=await api(url,options);if(url.endsWith('/issues/comments/101'))Date.now=()=>Date.parse(fixture.attestation.payload.expiresAt)+1;return result;};
 try{await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),/CHAT_ADMIN_ATTESTATION_STALE/);}finally{Date.now=clock;}
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

test('owner-only proof requires the ledger and rejects a fabricated second reviewer',async()=>{
 const fixture=await auditFixture();
 assert.equal(fixture.attestation.payload.schema,2);assert.equal(fixture.attestation.payload.reviewer,undefined);assert.equal(fixture.attestation.approvalCommentId,undefined);
 for(const delta of [{ledgerSha256:'e'.repeat(64)},{actor:'contributor'},{triggeringActor:'contributor'}])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses),{...fixture.evidence,...delta}),/ATTESTATION_INVALID/);
 fixture.attestation.approvalCommentId=102;fixture.evidence.attestationJson=JSON.stringify(fixture.attestation);
 await assert.rejects(()=>run(fixture),/ATTESTATION_INVALID/);
});

test('all manual workflow jobs require the original and triggering owner; audit ledgers are bound',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 const jobs=workflow.slice(workflow.indexOf('jobs:')).split(/\n(?=  [a-z_]+:\n)/).slice(1);
 assert.equal(jobs.length,6);
 for(const job of jobs){assert(job.includes("github.actor == 'vivek2310sharma'"));assert(job.includes("github.triggering_actor == 'vivek2310sharma'"));}
 assert(workflow.includes('fairswapprod "$LEDGER_SHA" "$BUNDLE_SHA" "$TEST_LEDGER_SHA"'));
 const audit=workflow.slice(workflow.indexOf('  audit_verify:'));
 assert.equal((audit.match(/CHAT_APPROVED_LEDGER_JSON:/g)??[]).length,2);
 assert(audit.includes('inputs.test_ledger_sha256'));assert(audit.includes('inputs.prod_ledger_sha256'));
 assert(!audit.includes('CHAT_DATABASE_PASSWORD'));
});

test('audit-only refuses an unapproved ledger before inspecting GitHub',async()=>{
 const fixture=await auditFixture('FairSwapTest',bundleHash());
 const env={GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,CHAT_APPROVED_LEDGER_JSON:fixture.ledgerJson,LEDGER_SHA:'0'.repeat(64)};
 await assert.rejects(()=>auditOnly('FairSwapTest',bundleHash(),{env,fetcher:()=>assert.fail('API must not run')}),/CHAT_APPROVED_LEDGER_HASH_MISMATCH/);
});

test('unauthorized Production release stops before GitHub API or database access',async()=>{
 const fixture=await auditFixture('FairSwapProd',bundleHash()),directory=mkdtempSync(join(tmpdir(),'chat-solo-owner-prod.'));
 try{
  mkdirSync(join(directory,'test-evidence'));writeFileSync(join(directory,'test-evidence/receipt.json'),JSON.stringify({environment:'FairSwapTest',status:'failed'}));
  const env={PATH:process.env.PATH,GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,GITHUB_RUN_ID:'1',GITHUB_RUN_ATTEMPT:'1',CHAT_RELEASE_ENABLED:'true',CHAT_ENVIRONMENT_ENABLED:'true',CHAT_WEB_FLAG_OFF_CONFIRMED:'true',CHAT_BACKEND_AUTHORITY_RECEIPT:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/60',CHAT_APPROVED_LEDGER_JSON:fixture.ledgerJson,CHAT_DATABASE_PASSWORD:'synthetic-private-database-password'};
  for(const [delta,expected]of [[{},'CHAT_SAME_RUN_TEST_EVIDENCE_REQUIRED'],[{GITHUB_ACTOR:'contributor'},'CHAT_OWNER_DISPATCH_REQUIRED'],[{GITHUB_TRIGGERING_ACTOR:'contributor'},'CHAT_OWNER_DISPATCH_REQUIRED']]){
   const result=spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/release/protected-inbox-release.mjs',import.meta.url)),'fairswapprod',fixture.evidence.ledgerSha256,bundleHash(),'f'.repeat(64)],{cwd:directory,encoding:'utf8',env:{...env,...delta}});
   assert.equal(result.status,1);assert(result.stderr.includes(expected));assert(!result.stderr.includes('synthetic-private'));assert.equal(result.stdout,'');
  }
 }finally{assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert(basename(directory).startsWith('chat-solo-owner-prod.'));rmSync(directory,{recursive:true,force:true});}
});

test('GitHub offset timestamps canonicalize for owner proof while raw policy timestamps remain fingerprinted',async()=>{
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
   await assert.rejects(()=>run(fixture),/CHAT_ADMIN_ATTESTATION_INVALID/);
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

test('owner observedAt and expiresAt remain strict valid UTC-Z timestamps',async()=>{
 for(const field of ['observedAt','expiresAt'])for(const stamp of ['2026-10-27T15:52:55.449+01:00','2026-02-29T12:00:00Z','2026-10-27T24:00:00Z']){
  const fixture=await auditFixture();fixture.attestation.payload[field]=stamp;fixture.evidence.attestationJson=JSON.stringify(fixture.attestation);
  await assert.rejects(()=>run(fixture),error=>error.message==='CHAT_ADMIN_ATTESTATION_STALE');
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

test('offset ruleset updates newer than owner observation cannot authorize release',async()=>{
 const clock=Date.now;Date.now=()=>Date.parse('2026-10-28T00:00:00Z');
 try{
  const fixture=await auditFixture('FairSwapTest','b'.repeat(64),{25352225:'2026-10-28T01:00:00+01:00'});
  await assert.rejects(()=>run(fixture),error=>error.message==='CHAT_ADMIN_ATTESTATION_RULESET_MISMATCH');
 }finally{Date.now=clock;}
});
