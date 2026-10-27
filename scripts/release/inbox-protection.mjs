// GET-only policy audit. Omitted privileged fields require independent evidence.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const repository='vivek2310sharma/FairSwap-Backend',base=`https://api.github.com/repos/${repository}`;
const environments=['FairSwapTest','FairSwapProd'];
const digest=value=>createHash('sha256').update(value).digest('hex');
export const canonicalJson=value=>JSON.stringify(normalize(value));
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])]));
 return value;
}
export const protectionHash=value=>digest(canonicalJson(value));
export function bundleHash(){
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const paths=JSON.parse(readFileSync(join(root,'releases/candidates/chat-v2-inbox-only/protected-files.json'),'utf8'));
 return digest(paths.map(path=>{if(!/^(scripts|tests|releases|\.github)\//.test(path)||path.includes('..'))throw Error('CHAT_BUNDLE_PATH_INVALID');return digest(readFileSync(join(root,path)))+'  '+path;}).join('\n')+'\n');
}
const fail=code=>{throw Error(code);};
const id=value=>Number.isSafeInteger(value)&&value>0;
const sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const iso=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const keys=(value,expected)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...expected].sort().join(',');
const ownerRulesetId=25821687,approvalRulesetId=25352225;
const ownerRuleTypes=['deletion','non_fast_forward','update'];
function requiredBypassActors(rulesetId){
 if(rulesetId===ownerRulesetId)return [{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}];
 if(rulesetId===approvalRulesetId)return [];
 fail('CHAT_RULESET_UNRECOGNIZED');
}
function verifyRulesetShape(policy,effectiveRules){
 const owner=policy.id===ownerRulesetId;
 requiredBypassActors(policy.id); // No other ruleset can inherit this exception.
 const conditions=policy.conditions,ref=conditions?.ref_name;
 if(policy.name!==(owner?'main-owner-only-updates':'protect-main')||policy.source_type!=='Repository'||policy.source!==repository||!keys(conditions,['ref_name'])||!keys(ref,['include','exclude'])||!Array.isArray(ref.include)||ref.include.length!==1||!['refs/heads/main','~DEFAULT_BRANCH'].includes(ref.include[0])||!Array.isArray(ref.exclude)||ref.exclude.length!==0)fail('CHAT_RULESET_SCOPE_MISMATCH');
 if(!Array.isArray(policy.rules)||policy.rules.some(rule=>typeof rule?.type!=='string'))fail('CHAT_RULESET_RULES_MISMATCH');
 const types=list=>list.map(rule=>rule.type).sort();
 if(owner){
  if(canonicalJson(types(policy.rules))!==canonicalJson(ownerRuleTypes)||canonicalJson(types(effectiveRules))!==canonicalJson(ownerRuleTypes))fail('CHAT_OWNER_UPDATE_RULESET_REQUIRED');
 }else if(!['pull_request','required_status_checks'].every(type=>policy.rules.some(rule=>rule.type===type)))fail('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
}
function client(token,fetcher){
 return async path=>{
  try{
   const response=await fetcher(base+path,{method:'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
   if(response.ok!==true||!response.headers||typeof response.headers.get!=='function')fail('CHAT_ADMIN_PROTECTION_UNVERIFIABLE');
   if(/rel\s*=\s*"?next\b/i.test(response.headers.get('link')??''))fail('CHAT_ADMIN_PAGINATION_INCOMPLETE');
   return await response.json();
  }catch(error){if(error?.message==='CHAT_ADMIN_PAGINATION_INCOMPLETE')throw error;fail('CHAT_ADMIN_PROTECTION_UNVERIFIABLE');}
 };
}
function complete(value,key){
 if(!Array.isArray(value?.[key])||!Number.isSafeInteger(value.total_count)||value.total_count!==value[key].length||value.total_count<0||value.total_count>100)fail('CHAT_ADMIN_PAGINATION_INCOMPLETE');
 return value[key];
}
// The snapshot contains non-secret metadata internally. Only digests leave the runner.
export async function inspectProtection(environment,token,sourceCommit,fetcher=fetch){
 if(!environments.includes(environment)||!token||!/^[a-f0-9]{40}$/.test(sourceCommit??''))fail('CHAT_PROTECTION_INPUT_REQUIRED');
 const get=client(token,fetcher);
 const [repo,env,rules,branches,scoped,global,ref]=await Promise.all([get(''),get(`/environments/${environment}`),get('/rules/branches/main?per_page=100'),get(`/environments/${environment}/deployment-branch-policies?per_page=100`),get(`/environments/${environment}/secrets?per_page=100`),get('/actions/secrets?per_page=100'),get('/git/ref/heads/main')]);
 if(ref?.object?.sha!==sourceCommit||ref.object.type!=='commit')fail('CHAT_AUDIT_COMMIT_CHANGED');
 if(!Array.isArray(rules)||!rules.length||rules.length>=100)fail('CHAT_ADMIN_PAGINATION_INCOMPLETE');
 if(rules.some(rule=>!rule||typeof rule.type!=='string')||!Array.isArray(env?.protection_rules)||env.protection_rules.some(rule=>!rule||typeof rule.type!=='string'))fail('CHAT_ADMIN_PROTECTION_UNVERIFIABLE');
 const policies=complete(branches,'branch_policies'),environmentSecrets=complete(scoped,'secrets'),repositorySecrets=complete(global,'secrets');
 const reviewers=env?.protection_rules?.find(rule=>rule.type==='required_reviewers');
 if(repo?.full_name!==repository||!id(repo.id)||repo.visibility!=='public'||repo.default_branch!=='main'||env?.can_admins_bypass!==false||reviewers?.prevent_self_review!==true||!Array.isArray(reviewers.reviewers)||!reviewers.reviewers.length||reviewers.reviewers.some(r=>!['User','Team'].includes(r.type)||!id(r.reviewer?.id))||env.deployment_branch_policy?.custom_branch_policies!==true||env.deployment_branch_policy?.protected_branches!==false)fail('CHAT_PROTECTED_APPROVAL_REQUIRED');
 if(policies.length!==1||policies[0]?.name!=='main'||policies[0]?.type!=='branch')fail('CHAT_MAIN_ONLY_ENVIRONMENT_REQUIRED');
 const prs=rules.filter(rule=>rule.type==='pull_request');
 if(rules.filter(rule=>rule.type==='required_status_checks').some(rule=>!Array.isArray(rule.parameters?.required_status_checks)||rule.parameters.required_status_checks.some(check=>typeof check?.context!=='string')))fail('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
 const checks=rules.filter(rule=>rule.type==='required_status_checks').flatMap(rule=>rule.parameters?.required_status_checks??[]).map(check=>check.context);
 if(!prs.length||prs.some(pr=>!Number.isSafeInteger(pr.parameters?.required_approving_review_count)||pr.parameters.required_approving_review_count<1||pr.parameters.dismiss_stale_reviews_on_push!==true)||!checks.includes('backend-ci-success')||!checks.includes('chat-inbox-native-pg17'))fail('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
 if(rules.some(rule=>!id(rule.ruleset_id)))fail('CHAT_RULESET_METADATA_REQUIRED');
 const ids=[...new Set(rules.map(rule=>rule.ruleset_id))].sort((a,b)=>a-b),rulesets=[];
 if(canonicalJson(ids)!==canonicalJson([approvalRulesetId,ownerRulesetId]))fail('CHAT_RULESET_UNRECOGNIZED');
 if(rules.some(rule=>['pull_request','required_status_checks'].includes(rule.type)&&rule.ruleset_id!==approvalRulesetId))fail('CHAT_APPROVAL_RULESET_BYPASS_FORBIDDEN');
 for(const rulesetId of ids){
  const policy=await get(`/rulesets/${rulesetId}`);
  if(policy?.id!==rulesetId||policy.enforcement!=='active'||policy.target!=='branch'||!iso(policy.updated_at))fail('CHAT_RULESET_METADATA_REQUIRED');
  verifyRulesetShape(policy,rules.filter(rule=>rule.ruleset_id===rulesetId));
  // Absence proves nothing; visible and attested lists must match the pinned policy.
  if(Object.hasOwn(policy,'bypass_actors')&&canonicalJson(policy.bypass_actors)!==canonicalJson(requiredBypassActors(rulesetId)))fail('CHAT_RULESET_BYPASS_FORBIDDEN');
  const {bypass_actors,_links,...visible}=policy;
  rulesets.push({id:rulesetId,policySha256:protectionHash(visible),updatedAt:policy.updated_at});
 }
 const names=list=>{if(list.some(s=>typeof s?.name!=='string'||!/^[A-Z0-9_]+$/.test(s.name))||new Set(list.map(s=>s.name)).size!==list.length)fail('CHAT_ADMIN_PAGINATION_INCOMPLETE');return list.map(s=>s.name).sort();};
 const environmentNames=names(environmentSecrets),repositoryNames=names(repositorySecrets);
 for(const name of ['CHAT_DATABASE_PASSWORD','CHAT_RELEASE_AUDIT_TOKEN'])if(!environmentNames.includes(name)||repositoryNames.includes(name))fail('CHAT_ENVIRONMENT_ONLY_SECRET_REQUIRED');
 const snapshot={repository:{id:repo.id,full_name:repo.full_name,visibility:repo.visibility,default_branch:repo.default_branch},environment,sourceCommit,protectionRules:env.protection_rules,canAdminsBypass:env.can_admins_bypass,deploymentBranchPolicy:env.deployment_branch_policy,branches:policies,environmentSecretNames:environmentNames,repositorySecretNames:repositoryNames,effectiveRules:rules,rulesets};
 return {snapshotSha256:protectionHash(snapshot),rulesets};
}
function parseAttestation(raw){
 try{if(typeof raw!=='string'||!raw||raw.length>32000)fail('invalid');return JSON.parse(raw);}catch{fail('CHAT_ADMIN_ATTESTATION_REQUIRED');}
}
export async function verifyAdministrativeAttestation(environment,token,evidence,inspection,fetcher=fetch,now=Date.now()){
 const attestation=parseAttestation(evidence.attestationJson),p=attestation?.payload;
 const person=value=>keys(value,['login','id'])&&id(value.id)&&typeof value.login==='string'&&/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value.login);
 if(!keys(attestation,['payload','attestationCommentId','approvalCommentId'])||!keys(p,['schema','repository','environment','sourceCommit','bundleSha256','snapshotSha256','observedAt','expiresAt','attestor','reviewer','reviewIssue','rulesets'])||p.schema!==1||p.repository!==repository||p.environment!==environment||p.sourceCommit!==evidence.sourceCommit||!sha(p.bundleSha256)||p.bundleSha256!==evidence.bundleSha256||!sha(p.snapshotSha256)||p.snapshotSha256!==inspection.snapshotSha256||!person(p.attestor)||!person(p.reviewer)||p.attestor.id===p.reviewer.id||p.attestor.login.toLowerCase()===p.reviewer.login.toLowerCase()||!id(p.reviewIssue)||!id(attestation.attestationCommentId)||!id(attestation.approvalCommentId)||attestation.attestationCommentId===attestation.approvalCommentId)fail('CHAT_ADMIN_ATTESTATION_INVALID');
 if(!iso(p.observedAt)||!iso(p.expiresAt)||Date.parse(p.observedAt)>now||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)<=Date.parse(p.observedAt)||Date.parse(p.expiresAt)-Date.parse(p.observedAt)>86400000)fail('CHAT_ADMIN_ATTESTATION_STALE');
 if(!Array.isArray(p.rulesets)||p.rulesets.length!==inspection.rulesets.length||p.rulesets.some((rule,index)=>!keys(rule,['id','policySha256','updatedAt','bypassActors'])||rule.id!==inspection.rulesets[index].id||canonicalJson(rule.bypassActors)!==canonicalJson(requiredBypassActors(rule.id))||Date.parse(rule.updatedAt)>Date.parse(p.observedAt)||canonicalJson({id:rule.id,policySha256:rule.policySha256,updatedAt:rule.updatedAt})!==canonicalJson(inspection.rulesets[index])))fail('CHAT_ADMIN_ATTESTATION_RULESET_MISMATCH');
 const get=client(token,fetcher),attestationSha256=protectionHash(p);
 const [statement,approval,authorPermission,reviewerPermission]=await Promise.all([get(`/issues/comments/${attestation.attestationCommentId}`),get(`/issues/comments/${attestation.approvalCommentId}`),get(`/collaborators/${p.attestor.login}/permission`),get(`/collaborators/${p.reviewer.login}/permission`)]);
 for(const [comment,person,permission]of [[statement,p.attestor,authorPermission],[approval,p.reviewer,reviewerPermission]]){
  if(comment?.user?.id!==person.id||comment.user.login!==person.login||comment.user.type!=='User'||permission?.permission!=='admin'||comment.issue_url!==base+`/issues/${p.reviewIssue}`||!iso(comment.created_at)||comment.updated_at!==comment.created_at||Date.parse(comment.created_at)<Date.parse(p.observedAt)||Date.parse(comment.created_at)>now)fail('CHAT_ADMIN_ATTESTATION_REVIEW_REQUIRED');
 }
 if(statement.body!==`CHAT_RELEASE_ADMIN_ATTESTATION_V1\n${canonicalJson(p)}`||approval.body!==`CHAT_RELEASE_ADMIN_APPROVAL_V1\n${attestationSha256}`||Date.parse(approval.created_at)<Date.parse(statement.created_at))fail('CHAT_ADMIN_ATTESTATION_REVIEW_REQUIRED');
 const rechecked=await inspectProtection(environment,token,evidence.sourceCommit,fetcher);
 if(rechecked.snapshotSha256!==inspection.snapshotSha256)fail('CHAT_PROTECTION_CHANGED_DURING_AUDIT');
 if(Date.parse(p.expiresAt)<=Date.now())fail('CHAT_ADMIN_ATTESTATION_STALE');
 return attestationSha256;
}
export async function auditProtection(environment,token,fetcher=fetch,evidence={}){
 const inspection=await inspectProtection(environment,token,evidence.sourceCommit,fetcher);
 const attestationSha256=await verifyAdministrativeAttestation(environment,token,evidence,inspection,fetcher);
 return {environment,public:true,protected:true,sourceCommit:evidence.sourceCommit,snapshotSha256:inspection.snapshotSha256,attestationSha256};
}
