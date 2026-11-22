import {createHash} from 'node:crypto';
import test from 'node:test';import assert from 'node:assert/strict';
import {validateHostedReceipt,requireHostedE2e,STEPS} from '../../scripts/release/v3-hosted-e2e.mjs';
const sha='a'.repeat(40),now=Date.now();
const c={WEB_STAGING_SHA:sha,TEST_ACTIVATION_RUN_ID:'12'};
const plan={candidate:{slug:'v2-books'}};
const run={id:15,run_attempt:1,head_sha:sha,created_at:new Date(now-10000).toISOString(),updated_at:new Date(now).toISOString()};
const receipt={schema:'v3-hosted-e2e/2',result:'PASS',slug:'v2-books',projectRef:'wpppxlnbzqynvhpeuavd',testActivationRunId:'12',runId:'15',runAttempt:1,
 runnerSha:sha,deployedWebSha:sha,deploymentId:4,baseUrl:'https://synthetic.vercel.app',generatedAt:new Date(now-1000).toISOString(),steps:Object.fromEntries(STEPS.map(s=>[s,true])),cleanup:{verified:true,requested:2,retired:2,alreadyInactive:0}};
test('hosted E2E receipt binds category, activation, project, Web, attempt, every check and cleanup',()=>{
 assert.equal(validateHostedReceipt(receipt,plan,c,run,now),receipt);
 for(const change of [{slug:'v2-tables-chairs'},{testActivationRunId:'11'},{projectRef:'prod'},{runnerSha:'b'.repeat(40)},{runId:'16'},{runAttempt:2},{result:'SKIPPED'},{schema:'V3_LEAF_VERIFIED'},{generatedAt:new Date(now-8*86400000).toISOString()},{cleanup:{verified:false}}])assert.throws(()=>validateHostedReceipt({...receipt,...change},plan,c,run,now));
 for(const step of STEPS)assert.throws(()=>validateHostedReceipt({...receipt,steps:{...receipt.steps,[step]:false}},plan,c,run,now));
});
test('missing evidence, failed or foreign workflow runs never authorize Production',async()=>{
 await assert.rejects(requireHostedE2e(plan,c,()=>{throw Error('no fetch');}),/EVIDENCE_UNAVAILABLE/);
 const ctx={...c,TEST_E2E_RUN_ID:'15',WEB_EVIDENCE_TOKEN:'mock'};
 for(const run of [{status:'completed',conclusion:'failure'},{head_repository:{full_name:'attacker/repo'}},{}])await assert.rejects(requireHostedE2e(plan,ctx,async()=>({ok:true,json:async()=>run})),/RUN_INVALID/);
});

function receiptZip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, value] of Object.entries(files)) {
    const n = Buffer.from(name), body = Buffer.from(value);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50); d.writeUInt32LE(body.length, 20); d.writeUInt32LE(body.length, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(offset, 42);
    local.push(h,n,body); central.push(d,n); offset += h.length+n.length+body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local,directory,end]);
}

test('successful hosted artifact is checked end-to-end; tampering, expiry and run forgeries fail closed',async()=>{
 const hash=x=>createHash('sha256').update(x).digest('hex');const body=JSON.stringify(receipt);
 const zip=receiptZip({'v3-hosted-e2e.json':body,SHA256SUMS_v3:hash(body)+'  v3-hosted-e2e.json\n'});
 const ctx={...c,TEST_E2E_RUN_ID:'15',WEB_EVIDENCE_TOKEN:'mock'};
 const complete={...run,workflow_id:7,path:'.github/workflows/wearables-e2e-test.yml',head_branch:'staging',head_repository:{full_name:'vivek2310sharma/FairSwap-Web'},event:'workflow_dispatch',status:'completed',conclusion:'success',actor:{login:'vivek2310sharma'},triggering_actor:{login:'vivek2310sharma'}};
 const artifact={id:9,name:'v3-hosted-e2e-v2-books-15-1',expired:false,workflow_run:{id:15,head_sha:sha},archive_download_url:'https://api.github.com/repos/vivek2310sharma/FairSwap-Web/actions/artifacts/9/zip',digest:'sha256:'+hash(zip)};
 const mock=(change={})=>async url=>({ok:true,arrayBuffer:async()=>zip,json:async()=>{
  if(url.includes('/actions/workflows/'))return {id:7,path:complete.path};
  if(url.includes('/artifacts?'))return {artifacts:[{...artifact,...change.artifact}]};
  if(url.includes('/actions/runs/'))return {...complete,...change.run};
  if(url.includes('/statuses?'))return [{state:change.state??'success',environment_url:receipt.baseUrl}];
  return {id:4,sha,environment:'Preview',production_environment:false,ref:'staging'};
 }});
 assert.equal((await requireHostedE2e(plan,ctx,mock())).artifactId,9);
 for(const change of [{artifact:{digest:'forged'}},{artifact:{expired:true}},{artifact:{name:'wrong-category'}},{run:{run_attempt:2}},{run:{conclusion:'failure'}},{run:{head_sha:'b'.repeat(40)}},{state:'failure'}])await assert.rejects(requireHostedE2e(plan,ctx,mock(change)));
});
