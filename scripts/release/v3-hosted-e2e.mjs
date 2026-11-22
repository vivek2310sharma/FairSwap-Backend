import {createHash} from 'node:crypto';
import {getJson,downloadArtifact,readZipEntries} from './accessories-v1-release.mjs';
const repo='vivek2310sharma/FairSwap-Web';
export const STEPS=['sessions_upload','ownership_authorization','frozen_retry','incomplete_nonpublic','held_nonpublic','clean_auto_publication','buyer_visibility'];
const hash=x=>createHash('sha256').update(x).digest('hex');
const need=(x,code)=>{if(!x)throw Error('V3_HOSTED_E2E_'+code);};
export function validateHostedReceipt(r,plan,c,run,now=Date.now()){
 const time=Date.parse(r?.generatedAt);
 need(r?.schema==='v3-hosted-e2e/2'&&r.result==='PASS'&&r.slug===plan.candidate.slug&&r.projectRef==='wpppxlnbzqynvhpeuavd'
  &&r.testActivationRunId===c.TEST_ACTIVATION_RUN_ID&&r.runId===String(run.id)&&r.runAttempt===run.run_attempt
  &&r.runnerSha===c.WEB_STAGING_SHA&&r.deployedWebSha===c.WEB_STAGING_SHA&&r.runnerSha===run.head_sha
  &&Number.isSafeInteger(r.deploymentId)&&/^https:\/\/[a-z0-9-]+\.vercel\.app\/?$/.test(r.baseUrl??'')
  &&Number.isFinite(time)&&time<=now&&now-time<=7*86400000&&time>=Date.parse(run.created_at)&&time<=Date.parse(run.updated_at)
  &&r.cleanup?.verified===true&&r.cleanup.requested===2&&Number.isInteger(r.cleanup.retired)&&r.cleanup.retired>=0
  &&Number.isInteger(r.cleanup.alreadyInactive)&&r.cleanup.alreadyInactive>=0&&r.cleanup.retired+r.cleanup.alreadyInactive===2
  &&r.steps&&Object.keys(r.steps).length===STEPS.length&&STEPS.every(s=>r.steps[s]===true),'RECEIPT_INVALID');
 return r;
}
export async function requireHostedE2e(plan,c,fetcher=fetch){
 need(/^[1-9][0-9]*$/.test(c.TEST_E2E_RUN_ID??'')&&c.WEB_EVIDENCE_TOKEN,'EVIDENCE_UNAVAILABLE');
 const token=c.WEB_EVIDENCE_TOKEN,base=`https://api.github.com/repos/${repo}`;
 const get=path=>getJson(base+'/'+path,token,fetcher);
 const run=await get('actions/runs/'+c.TEST_E2E_RUN_ID);
 const workflow=await get('actions/workflows/wearables-e2e-test.yml');
 need(String(run.id)===c.TEST_E2E_RUN_ID&&run.workflow_id===workflow.id&&workflow.path==='.github/workflows/wearables-e2e-test.yml'
  &&run.path===workflow.path&&run.head_sha===c.WEB_STAGING_SHA&&run.head_branch==='staging'&&run.head_repository?.full_name===repo
  &&run.event==='workflow_dispatch'&&run.status==='completed'&&run.conclusion==='success'&&run.actor?.login==='vivek2310sharma'
  &&run.triggering_actor?.login==='vivek2310sharma'&&Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0,'RUN_INVALID');
 const data=await get(`actions/runs/${run.id}/artifacts?per_page=100`);
 const artifacts=data.artifacts?.filter(a=>a.name===`v3-hosted-e2e-${plan.candidate.slug}-${run.id}-${run.run_attempt}`&&a.expired===false
  &&String(a.workflow_run?.id)===String(run.id)&&a.workflow_run?.head_sha===run.head_sha);
 need(artifacts?.length===1,'ARTIFACT_REQUIRED');const a=artifacts[0];
 need(Number.isSafeInteger(a.id)&&a.archive_download_url===`${base}/actions/artifacts/${a.id}/zip`,'ARTIFACT_URL_INVALID');
 const bytes=await downloadArtifact(a.archive_download_url,token,fetcher);need(a.digest==='sha256:'+hash(bytes),'ARTIFACT_DIGEST_INVALID');
 const files=readZipEntries(bytes),body=files.get('v3-hosted-e2e.json');
 need(body&&files.get('SHA256SUMS_v3')?.toString()===hash(body)+'  v3-hosted-e2e.json\n','CHECKSUM_INVALID');
 const r=validateHostedReceipt(JSON.parse(body.toString()),plan,c,run);
 const d=await get('deployments/'+r.deploymentId);const statuses=await get(`deployments/${r.deploymentId}/statuses?per_page=1`);
 need(d.id===r.deploymentId&&d.sha===r.deployedWebSha&&d.environment==='Preview'&&d.production_environment!==true
  &&[r.deployedWebSha,'staging'].includes(d.ref)&&statuses[0]?.state==='success'
  &&(statuses[0].environment_url??statuses[0].target_url)===r.baseUrl,'DEPLOYMENT_INVALID');
 return {runId:r.runId,artifactId:a.id,artifactDigest:a.digest,slug:r.slug,webSha:r.deployedWebSha};
}
