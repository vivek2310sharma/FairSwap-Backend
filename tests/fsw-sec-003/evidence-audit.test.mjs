// All transports are synthetic. No credentials, network, SQL or database fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collect, refs, repository, workflow, hash, verifyReceipt, writeReceipt, backupMetadata} from '../../scripts/release/fsw-sec-003-evidence-audit.mjs';
const now = Date.parse('2026-10-31T12:00:00Z');
const context = (environment='FairSwapTest') => ({GITHUB_ACTIONS:'true',GITHUB_EVENT_NAME:'workflow_dispatch',
  GITHUB_REPOSITORY:repository,GITHUB_REF:'refs/heads/main',GITHUB_WORKFLOW_REF:`${repository}/${workflow}@refs/heads/main`,
  GITHUB_ACTOR:'vivek2310sharma',GITHUB_TRIGGERING_ACTOR:'vivek2310sharma',GITHUB_SHA:'a'.repeat(40),APPROVED_SHA:'a'.repeat(40),
  GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',FSW_ENVIRONMENT:environment,SUPABASE_ACCESS_TOKEN:'SYNTHETIC_PROVIDER_SECRET',CHAT_RELEASE_AUDIT_TOKEN:'SYNTHETIC_AUDIT_SECRET'});
const backup = () => ({pitr_enabled:true,walg_enabled:true,backups:[{id:1,status:'COMPLETED',inserted_at:'2026-10-31T11:00:00Z',is_physical_backup:true}],
  physical_backup_data:{earliest_physical_backup_date_unix:1793358000,latest_physical_backup_date_unix:1793444400},secret:'NEVER_PERSIST'});
const owner = {id:7,login:'vivek2310sharma',type:'User'};
function github(path, c, environment) {
  const checks = {type:'required_status_checks',parameters:{required_status_checks:[{context:'backend-ci-success'},{context:'chat-inbox-native-pg17'}]}};
  const pr = {type:'pull_request',parameters:{required_approving_review_count:0,dismiss_stale_reviews_on_push:true}};
  const rules = [{type:'deletion'},{type:'non_fast_forward'},{type:'update'}].map(rule => ({...rule,ruleset_id:25821687}));
  rules.push(...[checks,pr].map(rule => ({...rule,ruleset_id:25352225})));
  if (path === '') return {id:1,owner,full_name:repository,visibility:'public',default_branch:'main'};
  if (path === `/environments/${environment}`) return {can_admins_bypass:false,protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:owner}]}],deployment_branch_policy:{custom_branch_policies:true,protected_branches:false}};
  if (path.includes('/deployment-branch-policies')) return {total_count:1,branch_policies:[{name:'main',type:'branch'}]};
  if (path.includes('/environments/') && path.includes('/secrets')) return {total_count:2,secrets:[{name:'CHAT_DATABASE_PASSWORD'},{name:'CHAT_RELEASE_AUDIT_TOKEN'}]};
  if (path.startsWith('/actions/secrets')) return {total_count:0,secrets:[]};
  if (path.startsWith('/git/ref/')) return {object:{sha:c.GITHUB_SHA,type:'commit'}};
  if (path.startsWith('/collaborators')) return [{...owner,role_name:'admin',permissions:{admin:true,maintain:true,push:true,pull:true,triage:true}}];
  if (path.startsWith('/rules/branches')) return rules;
  if (path.startsWith('/rulesets/')) {
    const id = Number(path.split('/').at(-1)), isOwner = id === 25821687;
    return {id,name:isOwner?'main-owner-only-updates':'protect-main',enforcement:'active',target:'branch',source_type:'Repository',source:repository,
      conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},updated_at:'2026-10-30T00:00:00Z',
      rules:rules.filter(rule => rule.ruleset_id === id).map(({ruleset_id,...rule}) => rule),
      bypass_actors:isOwner?[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}]:[]};
  }
  throw Error('Unexpected synthetic endpoint');
}
function harness(environment='FairSwapTest', options={}) {
  const c = {...context(environment),...options.context}, calls=[];
  const fetcher = async (url, init) => {
    calls.push(url);
    assert.equal(init.method,'GET'); assert.equal(init.redirect,'error'); assert.equal(init.cache,'no-store');
    assert.equal(init.body,undefined);
    const sb = `https://api.supabase.com/v1/projects/${refs[environment]}`;
    if (url.startsWith('https://api.supabase.com/') && !url.startsWith(sb)) return {status:options.oppositeStatus??403};
    let data;
    if (url === sb) data = {id:refs[environment],name:environment};
    else if (url === sb+'/database/backups') data = backup();
    else if (url === sb+'/postgrest') data = {db_schema:'public',jwt_secret:'NEVER_PERSIST'};
    else data = github(url.replace(`https://api.github.com/repos/${repository}`,''),c,environment);
    const reply = {status:200,ok:true,headers:new Headers({'content-type':'application/json'}),json:async () => data};
    options.change?.(url,data,reply);
    return reply;
  };
  return {c,calls,run:() => collect(environment,{context:c,fetcher,now})};
}
for (const environment of Object.keys(refs)) test(environment+': independent GET metadata, protection recheck and run-bound sanitized receipt', async () => {
  const h = harness(environment), r = await h.run();
  assert.equal(r.status,'PASS'); assert.equal(r.projectRef,refs[environment]);
  assert.equal(r.releaseEligible,false); assert.equal(r.recovery,'UNVERIFIED'); assert.equal(r.privilegedWriterInventory,'UNVERIFIED');
  assert.equal(r.checks.backups.restore,'UNVERIFIED'); assert.equal(r.checks.backups.retention.status,'UNVERIFIED');
  assert.equal(h.calls.filter(url => url.endsWith('/rulesets/25821687')).length,2);
  const bytes = JSON.stringify(r);
  for (const secret of ['SYNTHETIC_PROVIDER_SECRET','SYNTHETIC_AUDIT_SECRET','NEVER_PERSIST','jwt_secret','CHAT_DATABASE_PASSWORD']) assert.ok(!bytes.includes(secret));
  assert.deepEqual(verifyReceipt(bytes,hash(bytes),environment,h.c,now),r);
});
for (const [field,value] of Object.entries({FSW_ENVIRONMENT:'other',GITHUB_REPOSITORY:'other/repo',GITHUB_REF:'refs/heads/dev',GITHUB_ACTOR:'other',GITHUB_TRIGGERING_ACTOR:'other',APPROVED_SHA:'b'.repeat(40),GITHUB_EVENT_NAME:'push',GITHUB_RUN_ATTEMPT:'0',GITHUB_WORKFLOW_REF:'forged'})) test('zero provider calls for invalid '+field,async () => {
  const h=harness('FairSwapTest',{context:{[field]:value}}); await assert.rejects(h.run); assert.equal(h.calls.length,0);
});
test('wrong provider project prevents backup and config reads',async () => {
  const h=harness('FairSwapTest',{change:(url,data)=>{if(url.endsWith(refs.FairSwapTest))data.id=refs.FairSwapProd;}});
  const r=await h.run(); assert.equal(r.checks.target.status,'UNVERIFIED'); assert.ok(!h.calls.some(url=>url.endsWith('/backups')||url.endsWith('/postgrest')));
});
for(const status of [200,401,429,500]) test('opposite target must return a genuine scope denial: '+status,async()=>{
  const r=await harness('FairSwapTest',{oppositeStatus:status}).run(); assert.equal(r.checks.target.status,'UNVERIFIED'); assert.equal(r.status,'UNVERIFIED');
});
for(const route of ['/database/backups','/postgrest','/rulesets/25821687']) for(const status of [401,403,404,429,500]) test(route+' unavailable '+status+' is UNVERIFIED',async()=>{
  const r=await harness('FairSwapTest',{change:(url,data,reply)=>{if(url.endsWith(route)){reply.status=status;reply.ok=false;}}}).run();
  assert.equal(r.status,route.includes('backups')?'PASS':'UNVERIFIED');
  assert.equal(r.checks[route.includes('backups')?'backups':route.includes('postgrest')?'exposure':'protections'].status,'UNVERIFIED');
});
for(const key of ['SUPABASE_ACCESS_TOKEN','CHAT_RELEASE_AUDIT_TOKEN']) test('missing existing credential '+key,async()=>{
  const r=await harness('FairSwapTest',{context:{[key]:''}}).run();assert.equal(r.status,'UNVERIFIED');
});
for(const kind of ['html','redirect','malformed','pagination','duplicate','missing','future','invalidDate','unknownStatus']) test('unexpected or incomplete backup response: '+kind,async()=>{
  const r=await harness('FairSwapTest',{change:(url,data,reply)=>{
    if(!url.endsWith('/backups'))return;
    if(kind==='html')reply.headers.set('content-type','text/html');
    if(kind==='redirect')reply.redirected=true;
    if(kind==='malformed')reply.json=async()=>{throw Error('NEVER_PERSIST');};
    if(kind==='pagination')reply.headers.set('link','<https://invalid>; rel="next"');
    if(kind==='duplicate')data.backups.push({...data.backups[0]});
    if(kind==='missing')delete data.backups;
    if(kind==='future')data.backups[0].inserted_at='2026-11-01T00:00:00Z';
    if(kind==='invalidDate')data.backups[0].inserted_at='2026-02-30T00:00:00Z';
    if(kind==='unknownStatus')data.backups[0].status='UNKNOWN';
  }}).run();assert.equal(r.checks.backups.status,'UNVERIFIED');assert.equal(r.checks.exposure.status,'PASS');
});
for(const field of ['next_page','has_more','total_count']) test('incomplete API inventory '+field,async()=>{
  const r=await harness('FairSwapTest',{change:(url,data)=>{if(url.endsWith('/backups'))data[field]=1;}}).run();assert.equal(r.checks.backups.status,'UNVERIFIED');
});
for(const kind of ['collaborators','bypass','secretCount']) test('incomplete GitHub inventory '+kind,async()=>{
  const r=await harness('FairSwapTest',{change:(url,data)=>{
    if(kind==='collaborators'&&url.includes('/collaborators'))data.length=0;
    if(kind==='bypass'&&url.includes('/rulesets/'))delete data.bypass_actors;
    if(kind==='secretCount'&&url.includes('/actions/secrets'))data.total_count=1;
  }}).run();assert.equal(r.checks.protections.status,'UNVERIFIED');assert.equal(r.checks.backups.status,'PASS');
});
test('empty, failed and expired backup lists never pass',()=>{
  for(const change of [d=>d.backups=[],d=>d.backups[0].status='FAILED',d=>d.backups[0].inserted_at='2026-10-01T00:00:00Z']){
    const d=backup();change(d);assert.equal(backupMetadata(d,now).status,'UNVERIFIED');
  }
});
test('unexpected exposed schema is a recorded failure with no secret config persisted',async()=>{
  const r=await harness('FairSwapTest',{change:(url,data)=>{if(url.endsWith('/postgrest'))data.db_schema='public,app_security';}}).run();
  assert.equal(r.checks.exposure.status,'FAIL');assert.equal(r.status,'UNVERIFIED');
});
test('forged, expired, cross-run, cross-attempt, wrong target and wrong source receipts rejected',async()=>{
  const h=harness(),r=await h.run(),bytes=JSON.stringify(r);
  assert.throws(()=>verifyReceipt(bytes,'0'.repeat(64),'FairSwapTest',h.c,now));
  for(const [key,value] of Object.entries({runId:'124',runAttempt:'2',sourceCommit:'b'.repeat(40),sourceSha256:'0'.repeat(64),environment:'FairSwapProd',projectRef:refs.FairSwapProd,workflow:'forged',releaseEligible:true,observedAt:'2026-10-29T12:00:00Z',privilegedWriterInventory:'PASS'})){
    const forged=JSON.stringify({...r,[key]:value});assert.throws(()=>verifyReceipt(forged,hash(forged),'FairSwapTest',h.c,now),key);
  }
  assert.throws(()=>verifyReceipt(bytes,hash(bytes),'FairSwapTest',h.c,now-1));
  const missing=structuredClone(r);delete missing.checks.backups;const b=JSON.stringify(missing);assert.throws(()=>verifyReceipt(b,hash(b),'FairSwapTest',h.c,now));
});
test('receipt directory and files cannot be overwritten',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'fsw-audit-test-'));
  try{const r=await harness().run(),out=join(dir,'receipt');const digest=writeReceipt(r,out);
    assert.equal(hash(readFileSync(join(out,'receipt.json'))),digest);
    assert.equal(readFileSync(join(out,'SHA256SUMS'),'utf8'),digest+'  receipt.json\n');
    assert.throws(()=>writeReceipt(r,out));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('workflow remains isolated from deployments, uses protected independent jobs and immutable trusted receipts',()=>{
  const w=readFileSync(new URL('../../'+workflow,import.meta.url),'utf8');
  for(const text of ['workflow_dispatch:','github.triggering_actor','inputs.approved_sha == github.sha','environment: ${{ matrix.environment }}','fail-fast: false','overwrite: false','always()','artifact-ids: ${{ steps.artifact.outputs.artifact-id }}','TRUSTED_RECEIPT_SHA: ${{ steps.collect.outputs.sha256 }}','persist-credentials: false'])assert.ok(w.includes(text),text);
  for(const text of ['push:','pull_request:','schedule:','write-all','id-token:','continue-on-error','FSW_SEC_003_RELEASE_ENABLED','CHAT_DATABASE_PASSWORD','supabase db','fsw-sec-003-release.mjs'])assert.ok(!w.includes(text),text);
});

test('waiver is exact and exposure remains independently mandatory',async()=>{
 const h=harness('FairSwapTest');const r=await h.run();
 assert.equal(r.backupRecovery.status,'WAIVED_BY_OWNER');
 for(const mutate of [w=>w.scope.push('writer-authority'),w=>w.sha256='0'.repeat(64),w=>w.projectRef=refs.FairSwapProd,w=>w.version='20261101000000']){
 const changed=structuredClone(r);mutate(changed.backupRecovery);const bytes=JSON.stringify(changed);
 assert.throws(()=>verifyReceipt(bytes,hash(bytes),'FairSwapTest',h.c,now));
 }
});
