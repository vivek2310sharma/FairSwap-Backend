import './offline-guard.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {auditProtection,bundleHash} from '../../scripts/release/inbox-protection.mjs';
import {auditOnly} from '../../scripts/release/audit-inbox-only.mjs';
import {auditFixture,fixtureApi} from './audit-fixture.mjs';
const run=fixture=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses),fixture.evidence);

test('read-only omitted bypass lists require independently reviewed evidence even when explicitly empty',async()=>{
 const fixture=await auditFixture();
 assert.equal((await run(fixture)).protected,true);
 fixture.responses['/rulesets/1'].bypass_actors=[];
 assert.equal((await run(fixture)).protected,true);
 for(const attestationJson of [undefined,'','null','{}','private-token-not-json'])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses),{...fixture.evidence,attestationJson}),/CHAT_ADMIN_ATTESTATION/);
});

const invalidAttestations={
 'wrong commit':f=>{f.attestation.payload.sourceCommit='c'.repeat(40);},
 'wrong environment':f=>{f.attestation.payload.environment='FairSwapProd';},
 'wrong bundle':f=>{f.attestation.payload.bundleSha256='c'.repeat(64);},
 'wrong snapshot':f=>{f.attestation.payload.snapshotSha256='c'.repeat(64);},
 'expired attestation':f=>{f.attestation.payload.expiresAt=new Date(Date.now()-1000).toISOString();},
 'future observation':f=>{f.attestation.payload.observedAt=new Date(Date.now()+60000).toISOString();},
 'overlong validity':f=>{f.attestation.payload.expiresAt=new Date(Date.now()+2*86400000).toISOString();},
 'self approval':f=>{f.attestation.payload.reviewer={...f.attestation.payload.attestor};},
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
 'changed required review count':r=>{r['/rules/branches/main?per_page=100'][0].parameters.required_approving_review_count=0;},
 'weakened stale review dismissal':r=>{r['/rules/branches/main?per_page=100'][0].parameters.dismiss_stale_reviews_on_push=false;},
 'missing required CI':r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks=[];},
 'ruleset changed after attestation':r=>{r['/rulesets/1'].updated_at=new Date().toISOString();},
 'disabled ruleset':r=>{r['/rulesets/1'].enforcement='disabled';},
 'visible bypass actors':r=>{r['/rulesets/1'].bypass_actors=[{actor_id:1}];},
 'malformed visible bypass list':r=>{r['/rulesets/1'].bypass_actors=null;},
 'changed environment reviewer':r=>{r['/environments/FairSwapTest'].protection_rules[0].reviewers[0].reviewer.id=99;},
 'missing environment reviewers':r=>{r['/environments/FairSwapTest'].protection_rules[0].reviewers=[];},
 'self-review allowed':r=>{r['/environments/FairSwapTest'].protection_rules[0].prevent_self_review=false;},
 'administrator bypass allowed':r=>{r['/environments/FairSwapTest'].can_admins_bypass=true;},
 'weakened deployment branch restriction':r=>{r['/environments/FairSwapTest/deployment-branch-policies?per_page=100'].branch_policies[0].name='release/*';},
 'leaked repository database secret name':r=>{r['/actions/secrets?per_page=100']={total_count:1,secrets:[{name:'CHAT_DATABASE_PASSWORD'}]};},
 'leaked repository audit secret name':r=>{r['/actions/secrets?per_page=100']={total_count:1,secrets:[{name:'CHAT_RELEASE_AUDIT_TOKEN'}]};},
 'missing environment secret name':r=>{r['/environments/FairSwapTest/secrets?per_page=100']={total_count:0,secrets:[]};},
 'incomplete secrets page':r=>{r['/actions/secrets?per_page=100'].total_count=101;},
 'incomplete branch page':r=>{r['/environments/FairSwapTest/deployment-branch-policies?per_page=100'].total_count=2;},
 'changed main commit':r=>{r['/git/ref/heads/main'].object.sha='c'.repeat(40);},
 'non-admin attestor':r=>{r['/collaborators/fixture-admin/permission'].permission='write';},
 'non-admin reviewer':r=>{r['/collaborators/fixture-reviewer/permission'].permission='write';},
 'edited administrator statement':r=>{r['/issues/comments/101'].updated_at=new Date().toISOString();},
 'forged statement digest':r=>{r['/issues/comments/101'].body='unreviewed';},
 'forged approval digest':r=>{r['/issues/comments/102'].body='unreviewed';},
 'wrong approval author':r=>{r['/issues/comments/102'].user.id=99;},
 'bot approval':r=>{r['/issues/comments/102'].user.type='Bot';},
 'wrong evidence repository':r=>{r['/issues/comments/102'].issue_url='https://api.github.com/repos/foreign/repo/issues/60';},
};
for(const [name,mutate]of Object.entries(changes))test(`audit fails closed: ${name}`,async()=>{
 const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),/CHAT_/);
});

test('all denied endpoints, transport/JSON failures and pagination links fail closed without upstream text',async()=>{
 const fixture=await auditFixture();
 for(const path of Object.keys(fixture.responses))await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{denied:[path]}),fixture.evidence),/CHAT_ADMIN_PROTECTION_UNVERIFIABLE/);
 for(const path of ['/rules/branches/main?per_page=100','/rulesets/1','/actions/secrets?per_page=100'])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fixtureApi(fixture.responses,{links:{[path]:'<https://api.github.com/next>; rel="next"'}}),fixture.evidence),/CHAT_ADMIN_PAGINATION_INCOMPLETE/);
 for(const fetcher of [async()=>{throw Error('private-upstream-token');},async()=>({ok:true,headers:new Headers(),json:async()=>{throw Error('private-upstream-token');}})])await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),error=>error.message==='CHAT_ADMIN_PROTECTION_UNVERIFIABLE');
});

test('audit-only verifies both environments using GETs, without DB credentials or database claims',async()=>{
 for(const environment of ['FairSwapTest','FairSwapProd']){
  const bundle=bundleHash(),fixture=await auditFixture(environment,bundle),calls=[],reports=[];
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'vivek2310sharma/FairSwap-Backend',GITHUB_REF:'refs/heads/main',GITHUB_SHA:fixture.evidence.sourceCommit,CHAT_RELEASE_AUDIT_TOKEN:'fixture-token',CHAT_RELEASE_ADMIN_ATTESTATION_JSON:fixture.evidence.attestationJson};
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
  if(url.endsWith('/issues/comments/102')&&!changed){changed=true;fixture.responses['/rules/branches/main?per_page=100'][1].parameters.required_status_checks.pop();}
  return result;
 };
 await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),/CHAT_PROTECTION_CHANGED_DURING_AUDIT/);
});

test('an attestation expiring during API verification cannot produce a successful audit',async()=>{
 const fixture=await auditFixture(),api=fixtureApi(fixture.responses),clock=Date.now;
 const fetcher=async(url,options)=>{const result=await api(url,options);if(url.endsWith('/issues/comments/102'))Date.now=()=>Date.parse(fixture.attestation.payload.expiresAt)+1;return result;};
 try{await assert.rejects(()=>auditProtection('FairSwapTest','fixture-token',fetcher,fixture.evidence),/CHAT_ADMIN_ATTESTATION_STALE/);}finally{Date.now=clock;}
});

test('malformed protection metadata fails with fixed categories rather than being treated as empty',async()=>{
 for(const mutate of [r=>{r['/environments/FairSwapTest'].protection_rules=null;},r=>{r['/rules/branches/main?per_page=100']=[null];},r=>{r['/rules/branches/main?per_page=100'][1].parameters.required_status_checks=[null];}]){
  const fixture=await auditFixture();mutate(fixture.responses);await assert.rejects(()=>run(fixture),error=>/^CHAT_[A-Z_]+$/.test(error.message));
 }
});

test('audit workflow has independently protected sequential jobs and cannot reach the release path',()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/chat-v2-inbox-release.yml',import.meta.url),'utf8');
 const audit=workflow.slice(workflow.indexOf('  audit_verify:'));
 assert(workflow.includes('inputs.deploy && !inputs.audit_only'));assert(audit.includes('inputs.audit_only && !inputs.deploy'));
 assert(audit.includes('environment: FairSwapTest'));assert(audit.includes('environment: FairSwapProd'));assert(audit.includes('needs: audit_test'));
 assert(!/CHAT_DATABASE_PASSWORD|CHAT_RELEASE_ENABLED|install-inbox-cli|protected-inbox-release\.mjs|psql|migration up|set enabled/.test(audit));
 assert(!/child_process|protected-inbox-release|protected-inbox-plan|supabase-js/.test(readFileSync(new URL('../../scripts/release/audit-inbox-only.mjs',import.meta.url),'utf8')));
 const protectedFiles=JSON.parse(readFileSync(new URL('../../releases/candidates/chat-v2-inbox-only/protected-files.json',import.meta.url),'utf8'));
 for(const file of ['scripts/release/audit-inbox-only.mjs','tests/chat-v2-inbox-only/readonly-audit.test.mjs','tests/chat-v2-inbox-only/audit-fixture.mjs'])assert(protectedFiles.includes(file));
});

test('audit-only CLI rejects database credentials before any API and emits only a fixed failure',()=>{
 const privateValue='synthetic-do-not-echo-credential';
 const result=spawnSync(process.execPath,['--import',new URL('./offline-guard.mjs',import.meta.url).href,fileURLToPath(new URL('../../scripts/release/audit-inbox-only.mjs',import.meta.url)),'FairSwapTest','b'.repeat(64)],{encoding:'utf8',env:{PATH:process.env.PATH,CHAT_DATABASE_PASSWORD:privateValue}});
 assert.equal(result.status,1);assert.equal(result.stderr.trim(),'CHAT_AUDIT_DATABASE_SECRET_FORBIDDEN');assert.equal(result.stdout,'');assert(!result.stderr.includes(privateValue));
});
