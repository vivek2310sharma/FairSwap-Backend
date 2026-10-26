// Read-only policy audit. A missing/forbidden API is a release blocker, never a bypass.
export async function auditProtection(environment,token,fetcher=fetch){
 if(!['FairSwapTest','FairSwapProd'].includes(environment)||!token)throw Error('CHAT_PROTECTION_INPUT_REQUIRED');
 const base='https://api.github.com/repos/vivek2310sharma/FairSwap-Backend';
 const get=async path=>{const response=await fetcher(base+path,{headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'},redirect:'error'});if(!response.ok)throw Error('CHAT_ADMIN_PROTECTION_UNVERIFIABLE');return response.json();};
 const [repo,env,rules,branches,scoped,global]=await Promise.all([get(''),get(`/environments/${environment}`),get('/rules/branches/main'),get(`/environments/${environment}/deployment-branch-policies?per_page=100`),get(`/environments/${environment}/secrets?per_page=100`),get('/actions/secrets?per_page=100')]);
 if(scoped.total_count!==scoped.secrets?.length||global.total_count!==global.secrets?.length||branches.total_count!==branches.branch_policies?.length)throw Error('CHAT_ADMIN_PAGINATION_INCOMPLETE');
 const reviewers=env.protection_rules?.find(rule=>rule.type==='required_reviewers');
 if(repo.visibility!=='public'||env.can_admins_bypass!==false||reviewers?.prevent_self_review!==true||!reviewers.reviewers?.length||!env.deployment_branch_policy?.custom_branch_policies)throw Error('CHAT_PROTECTED_APPROVAL_REQUIRED');
 if(branches.branch_policies?.length!==1||branches.branch_policies[0].name!=='main'||branches.branch_policies[0].type!=='branch')throw Error('CHAT_MAIN_ONLY_ENVIRONMENT_REQUIRED');
 const pr=rules.find(rule=>rule.type==='pull_request');
 const checks=rules.find(rule=>rule.type==='required_status_checks')?.parameters?.required_status_checks?.map(check=>check.context)??[];
 if(!pr||pr.parameters.required_approving_review_count<1||!pr.parameters.dismiss_stale_reviews_on_push||!checks.includes('backend-ci-success')||!checks.includes('chat-inbox-native-pg17'))throw Error('CHAT_BRANCH_APPROVAL_AND_CHECKS_REQUIRED');
 for(const rule of rules.filter(rule=>['pull_request','required_status_checks'].includes(rule.type))){
  if(!Number.isInteger(rule.ruleset_id))throw Error('CHAT_RULESET_METADATA_REQUIRED');
  const policy=await get(`/rulesets/${rule.ruleset_id}`);if(policy.enforcement!=='active'||policy.bypass_actors?.length!==0)throw Error('CHAT_RULESET_BYPASS_FORBIDDEN');
 }
 for(const name of ['CHAT_DATABASE_PASSWORD','CHAT_RELEASE_AUDIT_TOKEN'])if(!scoped.secrets?.some(s=>s.name===name)||global.secrets?.some(s=>s.name===name))throw Error('CHAT_ENVIRONMENT_ONLY_SECRET_REQUIRED');
 return {environment,public:true,protected:true};
}
