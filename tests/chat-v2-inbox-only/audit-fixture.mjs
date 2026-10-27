// Synthetic API metadata only. No real administrator approval or network access.
import {inspectProtection,canonicalJson} from '../../scripts/release/inbox-protection.mjs';
import {createHash} from 'node:crypto';
export const apiBase='https://api.github.com/repos/vivek2310sharma/FairSwap-Backend';
export function fixtureApi(responses,{links={},denied=[],calls=[]}={}){
 return async(url,options)=>{
  const path=url.replace(apiBase,'');calls.push({path,method:options.method,redirect:options.redirect});
  return {ok:!denied.includes(path)&&Object.hasOwn(responses,path),headers:new Headers(links[path]?{link:links[path]}:{}),json:async()=>structuredClone(responses[path])};
 };
}
export async function auditFixture(environment='FairSwapTest',bundleSha256='b'.repeat(64),updatedAt={}){
 const now=Date.now(),stamp=delta=>new Date(now+delta).toISOString(),sourceCommit='a'.repeat(40);
 const responses={
  '':{id:123,full_name:'vivek2310sharma/FairSwap-Backend',visibility:'public',default_branch:'main',owner:{login:'vivek2310sharma',id:11,type:'User'}},
  [`/environments/${environment}`]:{protection_rules:[{type:'required_reviewers',prevent_self_review:false,reviewers:[{type:'User',reviewer:{id:11,login:'vivek2310sharma'}}]}],deployment_branch_policy:{custom_branch_policies:true,protected_branches:false},can_admins_bypass:false},
  '/rules/branches/main?per_page=100':[{type:'pull_request',ruleset_id:25352225,parameters:{required_approving_review_count:0,dismiss_stale_reviews_on_push:true}},{type:'required_status_checks',ruleset_id:25352225,parameters:{required_status_checks:[{context:'backend-ci-success'},{context:'chat-inbox-native-pg17'},{context:'existing-extra-check'}]}}],
  [`/environments/${environment}/deployment-branch-policies?per_page=100`]:{total_count:1,branch_policies:[{name:'main',type:'branch'}]},
  [`/environments/${environment}/secrets?per_page=100`]:{total_count:2,secrets:[{name:'CHAT_DATABASE_PASSWORD'},{name:'CHAT_RELEASE_AUDIT_TOKEN'}]},
  '/actions/secrets?per_page=100':{total_count:0,secrets:[]},
  '/git/ref/heads/main':{object:{sha:sourceCommit,type:'commit'}},
  '/rulesets/25352225':{id:25352225,name:'protect-main',target:'branch',source:'vivek2310sharma/FairSwap-Backend',source_type:'Repository',enforcement:'active',updated_at:stamp(-120000),conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'pull_request'},{type:'required_status_checks'}]},
  '/rulesets/25821687':{id:25821687,name:'main-owner-only-updates',target:'branch',source:'vivek2310sharma/FairSwap-Backend',source_type:'Repository',enforcement:'active',updated_at:stamp(-120000),conditions:{ref_name:{include:['refs/heads/main'],exclude:[]}},rules:[{type:'deletion'},{type:'non_fast_forward'},{type:'update'}]},
  '/collaborators/vivek2310sharma/permission':{permission:'admin'},
  '/collaborators?affiliation=all&per_page=100':[{id:11,login:'vivek2310sharma',type:'User',role_name:'admin',permissions:{admin:true,maintain:true,push:true,pull:true,triage:true}},{id:33,login:'contributor',type:'User',role_name:'write',permissions:{admin:false,maintain:false,push:true,pull:true,triage:true}}],
 };
 responses['/rulesets/25352225'].rules=responses['/rules/branches/main?per_page=100'].map(({ruleset_id,...rule})=>structuredClone(rule));
 responses['/rules/branches/main?per_page=100'].push(...responses['/rulesets/25821687'].rules.map(rule=>({...rule,ruleset_id:25821687})));
 for(const [id,stamp]of Object.entries(updatedAt))responses['/rulesets/'+id].updated_at=stamp;
 const inspection=await inspectProtection(environment,'fixture-token',sourceCommit,fixtureApi(responses));
 const ledgerJson=JSON.stringify({ledger:[{version:'20000101000000',name:'fixture',statementsSha256:'c'.repeat(64)}]}),ledgerSha256=createHash('sha256').update(ledgerJson).digest('hex');
 const payload={schema:2,repository:'vivek2310sharma/FairSwap-Backend',environment,sourceCommit,bundleSha256,ledgerSha256,snapshotSha256:inspection.snapshotSha256,observedAt:stamp(-60000),expiresAt:stamp(3600000),owner:{login:'vivek2310sharma',id:11},reviewIssue:60,rulesets:inspection.rulesets.map(r=>({...r,bypassActors:r.id===25821687?[{actor_id:5,actor_type:'RepositoryRole',bypass_mode:'always'}]:[]}))};
 const attestation={payload,attestationCommentId:101};
 responses['/issues/comments/101']={user:{...payload.owner,type:'User'},issue_url:apiBase+'/issues/60',body:'CHAT_RELEASE_OWNER_ATTESTATION_V2\n'+canonicalJson(payload),created_at:stamp(-30000),updated_at:stamp(-30000)};
 return {responses,attestation,inspection,ledgerJson,evidence:{sourceCommit,bundleSha256,ledgerSha256,actor:'vivek2310sharma',triggeringActor:'vivek2310sharma',attestationJson:JSON.stringify(attestation)}};
}
