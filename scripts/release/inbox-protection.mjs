// GET-only policy audit. Omitted privileged fields require independent evidence.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const repository='vivek2310sharma/FairSwap-Backend',base=`https://api.github.com/repos/${repository}`;
const environments=['FairSwapTest','FairSwapProd'];
export const governanceOwner='vivek2310sharma';
export function requireOwnerActors(env){
 if(env.GITHUB_ACTIONS!=='true'||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_ACTOR!==governanceOwner||env.GITHUB_TRIGGERING_ACTOR!==governanceOwner)throw Error('CHAT_OWNER_DISPATCH_REQUIRED');
}
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
 }else{
  const prs=policy.rules.filter(rule=>rule.type==='pull_request'),checks=policy.rules.filter(rule=>rule.type==='required_status_checks').flatMap(rule=>Array.isArray(rule.parameters?.required_status_checks)?rule.parameters.required_status_checks:[]).map(check=>check?.context);
  if(!prs.length||prs.some(rule=>rule.parameters?.required_approving_review_count!==0||rule.parameters.dismiss_stale_reviews_on_push!==true)||!checks.includes('backend-ci-success')||!checks.includes('chat-inbox-native-pg17'))fail('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
 }
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
function verifyCollaborators(repo,collaborators){
 if(repo?.owner?.login!==governanceOwner||repo.owner.type!=='User'||!id(repo.owner.id)||!Array.isArray(collaborators)||collaborators.length===0||collaborators.length>=100)fail('CHAT_COLLABORATOR_INVENTORY_UNVERIFIABLE');
 const seen=new Set(),logins=new Set();
 const inventory=collaborators.map(user=>{
  const p=user?.permissions;
  if(!id(user?.id)||typeof user.login!=='string'||!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(user.login)||user.type!=='User'||seen.has(user.id)||logins.has(user.login.toLowerCase())||!keys(p,['admin','maintain','push','pull','triage'])||['admin','maintain','push','pull','triage'].some(key=>typeof p[key]!=='boolean'))fail('CHAT_COLLABORATOR_INVENTORY_UNVERIFIABLE');
  seen.add(user.id);logins.add(user.login.toLowerCase());
  if(user.login===governanceOwner){if(user.id!==repo.owner.id||user.role_name!=='admin'||!p.admin||!p.push||!p.pull)fail('CHAT_SOLE_OWNER_ADMIN_REQUIRED');}
  else if(user.id===repo.owner.id||p.admin||p.maintain||!['read','triage','write'].includes(user.role_name))fail('CHAT_UNRECOGNIZED_PRIVILEGED_IDENTITY');
  const expected={read:{admin:false,maintain:false,push:false,pull:true,triage:false},triage:{admin:false,maintain:false,push:false,pull:true,triage:true},write:{admin:false,maintain:false,push:true,pull:true,triage:true},admin:{admin:true,maintain:true,push:true,pull:true,triage:true}}[user.role_name];
  if(canonicalJson(p)!==canonicalJson(expected))fail('CHAT_COLLABORATOR_INVENTORY_UNVERIFIABLE');
  return {id:user.id,login:user.login,type:user.type,role:user.role_name,permissions:p};
 }).sort((a,b)=>a.id-b.id);
 if(inventory.filter(user=>user.login===governanceOwner).length!==1)fail('CHAT_SOLE_OWNER_ADMIN_REQUIRED');
 return inventory;
}
// The snapshot contains non-secret metadata internally. Only digests leave the runner.
export async function inspectProtection(environment,token,sourceCommit,fetcher=fetch){
 if(!environments.includes(environment)||!token||!/^[a-f0-9]{40}$/.test(sourceCommit??''))fail('CHAT_PROTECTION_INPUT_REQUIRED');
 const get=client(token,fetcher);
 const [repo,env,rules,branches,scoped,global,ref,collaborators]=await Promise.all([get(''),get(`/environments/${environment}`),get('/rules/branches/main?per_page=100'),get(`/environments/${environment}/deployment-branch-policies?per_page=100`),get(`/environments/${environment}/secrets?per_page=100`),get('/actions/secrets?per_page=100'),get('/git/ref/heads/main'),get('/collaborators?affiliation=all&per_page=100')]);
 const inventory=verifyCollaborators(repo,collaborators);
 if(ref?.object?.sha!==sourceCommit||ref.object.type!=='commit')fail('CHAT_AUDIT_COMMIT_CHANGED');
 if(!Array.isArray(rules)||!rules.length||rules.length>=100)fail('CHAT_ADMIN_PAGINATION_INCOMPLETE');
 if(rules.some(rule=>!rule||typeof rule.type!=='string')||!Array.isArray(env?.protection_rules)||env.protection_rules.some(rule=>!rule||typeof rule.type!=='string'))fail('CHAT_ADMIN_PROTECTION_UNVERIFIABLE');
 const policies=complete(branches,'branch_policies'),environmentSecrets=complete(scoped,'secrets'),repositorySecrets=complete(global,'secrets');
 const reviewers=env?.protection_rules?.find(rule=>rule.type==='required_reviewers');
 if(repo?.full_name!==repository||!id(repo.id)||repo.visibility!=='public'||repo.default_branch!=='main'||env?.can_admins_bypass!==false||reviewers?.prevent_self_review!==false||!Array.isArray(reviewers.reviewers)||reviewers.reviewers.length!==1||reviewers.reviewers[0].type!=='User'||reviewers.reviewers[0].reviewer?.id!==repo.owner.id||reviewers.reviewers[0].reviewer?.login!==governanceOwner||env.deployment_branch_policy?.custom_branch_policies!==true||env.deployment_branch_policy?.protected_branches!==false)fail('CHAT_PROTECTED_APPROVAL_REQUIRED');
 if(policies.length!==1||policies[0]?.name!=='main'||policies[0]?.type!=='branch')fail('CHAT_MAIN_ONLY_ENVIRONMENT_REQUIRED');
 const prs=rules.filter(rule=>rule.type==='pull_request');
 if(rules.filter(rule=>rule.type==='required_status_checks').some(rule=>!Array.isArray(rule.parameters?.required_status_checks)||rule.parameters.required_status_checks.some(check=>typeof check?.context!=='string')))fail('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
 const checks=rules.filter(rule=>rule.type==='required_status_checks').flatMap(rule=>rule.parameters?.required_status_checks??[]).map(check=>check.context);
 if(!prs.length||prs.some(pr=>pr.parameters?.required_approving_review_count!==0||pr.parameters.dismiss_stale_reviews_on_push!==true)||!checks.includes('backend-ci-success')||!checks.includes('chat-inbox-native-pg17'))fail('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
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
 const snapshot={repository:{id:repo.id,full_name:repo.full_name,visibility:repo.visibility,default_branch:repo.default_branch,owner:repo.owner},collaborators:inventory,environment,sourceCommit,protectionRules:env.protection_rules,canAdminsBypass:env.can_admins_bypass,deploymentBranchPolicy:env.deployment_branch_policy,branches:policies,environmentSecretNames:environmentNames,repositorySecretNames:repositoryNames,effectiveRules:rules,rulesets};
 return {snapshotSha256:protectionHash(snapshot),rulesets,owner:{login:governanceOwner,id:repo.owner.id}};
}
function parseAttestation(raw){
 try{if(typeof raw!=='string'||!raw||raw.length>32000)fail('invalid');return JSON.parse(raw);}catch{fail('CHAT_ADMIN_ATTESTATION_REQUIRED');}
}
export async function verifyAdministrativeAttestation(environment,token,evidence,inspection,fetcher=fetch,now=Date.now()){
 const attestation=parseAttestation(evidence.attestationJson),p=attestation?.payload;
 if(!keys(attestation,['payload','attestationCommentId'])||!keys(p,['schema','repository','environment','sourceCommit','bundleSha256','ledgerSha256','snapshotSha256','observedAt','expiresAt','owner','reviewIssue','rulesets'])||p.schema!==2||p.repository!==repository||p.environment!==environment||p.sourceCommit!==evidence.sourceCommit||!sha(p.bundleSha256)||p.bundleSha256!==evidence.bundleSha256||!sha(p.ledgerSha256)||p.ledgerSha256!==evidence.ledgerSha256||!sha(p.snapshotSha256)||p.snapshotSha256!==inspection.snapshotSha256||!keys(p.owner,['login','id'])||canonicalJson(p.owner)!==canonicalJson(inspection.owner)||evidence.actor!==governanceOwner||evidence.triggeringActor!==governanceOwner||!id(p.reviewIssue)||!id(attestation.attestationCommentId))fail('CHAT_ADMIN_ATTESTATION_INVALID');
 if(!iso(p.observedAt)||!iso(p.expiresAt)||Date.parse(p.observedAt)>now||Date.parse(p.expiresAt)<=now||Date.parse(p.expiresAt)<=Date.parse(p.observedAt)||Date.parse(p.expiresAt)-Date.parse(p.observedAt)>86400000)fail('CHAT_ADMIN_ATTESTATION_STALE');
 if(!Array.isArray(p.rulesets)||p.rulesets.length!==inspection.rulesets.length||p.rulesets.some((rule,index)=>!keys(rule,['id','policySha256','updatedAt','bypassActors'])||rule.id!==inspection.rulesets[index].id||canonicalJson(rule.bypassActors)!==canonicalJson(requiredBypassActors(rule.id))||Date.parse(rule.updatedAt)>Date.parse(p.observedAt)||canonicalJson({id:rule.id,policySha256:rule.policySha256,updatedAt:rule.updatedAt})!==canonicalJson(inspection.rulesets[index])))fail('CHAT_ADMIN_ATTESTATION_RULESET_MISMATCH');
 const get=client(token,fetcher),attestationSha256=protectionHash(p);
 const [statement,permission]=await Promise.all([get('/issues/comments/'+attestation.attestationCommentId),get('/collaborators/'+governanceOwner+'/permission')]);
 if(statement?.user?.id!==p.owner.id||statement.user.login!==governanceOwner||statement.user.type!=='User'||permission?.permission!=='admin'||statement.issue_url!==base+'/issues/'+p.reviewIssue||!iso(statement.created_at)||statement.updated_at!==statement.created_at||Date.parse(statement.created_at)<Date.parse(p.observedAt)||Date.parse(statement.created_at)>now||statement.body!=='CHAT_RELEASE_OWNER_ATTESTATION_V2\n'+canonicalJson(p))fail('CHAT_ADMIN_ATTESTATION_REVIEW_REQUIRED');
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
