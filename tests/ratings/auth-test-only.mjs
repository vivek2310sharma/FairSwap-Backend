import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

// Read-only opt-in hosted smoke check. No login, fixture creation or database write.
// It intentionally cannot accept a Production URL. Supply only a publishable/anon
// API key and existing user access tokens; no privileged key is needed.
export function configuration(env) {
 assert.equal(env.RATINGS_AUTH_TARGET,'FairSwapTest','Explicit Test target required');
 assert.equal(env.RATINGS_AUTH_URL,'https://wpppxlnbzqynvhpeuavd.supabase.co','Only FairSwapTest is allowed');
 const names=['RATINGS_AUTH_PUBLISHABLE_KEY','RATINGS_AUTH_SELLER_TOKEN','RATINGS_AUTH_BUYER_TOKEN','RATINGS_AUTH_OUTSIDER_TOKEN','RATINGS_AUTH_STAFF_AAL1_TOKEN','RATINGS_AUTH_STAFF_AAL2_TOKEN'];
 for(const name of names)assert(env[name],`Missing ${name}`);
 return {url:env.RATINGS_AUTH_URL,key:env[names[0]],tokens:names.slice(1).map(n=>env[n])};
}
export async function verifyAuth(env,transport=fetch) {
 const {url,key,tokens}=configuration(env);
 const request=async(path,token,body)=>{
  const r=await transport(url+path,{method:body===undefined?'GET':'POST',redirect:'error',
   headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  // Never print responses, identities or tokens, including on failures.
  return {status:r.status,data:await r.json()};
 };
 const identities=[];
 for(const token of tokens){const r=await request('/auth/v1/user',token);assert.equal(r.status,200,'Auth rejected a supplied user token');assert(r.data.id,'Auth returned no identity');identities.push(r.data.id);}
 assert.equal(new Set(identities.slice(0,4)).size,4,'Seller, buyer, outsider and staff must differ');
 assert.equal(identities[3],identities[4],'AAL tokens must belong to the same staff identity');
 assert.equal((await request('/auth/v1/user','invalid-token')).status,401,'Invalid token accepted');
 for(let i=0;i<tokens.length;i++){
  const r=await request('/rest/v1/rpc/ratings_pending',tokens[i],{});
  assert.equal(r.data.code,'55000','Ratings must remain disabled');assert.equal(r.data.message,'RATINGS_DISABLED');
  for(const table of ['rating_trades','rating_reviews','rating_replies','profile_rating_stats','trade_system_events']){
   const denied=await request(`/rest/v1/${table}?select=*&limit=1`,tokens[i]);
   assert([401,403].includes(denied.status),'Direct Ratings table read was not denied');assert.equal(denied.data.code,'42501');
  }
 }
 // Guard ordering checks both actual role membership and JWT assurance level.
 for(const [i,message] of [[2,'RATINGS_ACCESS_DENIED'],[3,'RATINGS_ACCESS_DENIED'],[4,'RATINGS_STAFF_DISABLED']]){
  const r=await request('/rest/v1/rpc/admin_ratings_cases',tokens[i],{kind:'dispute'});
  assert.equal(r.data.message,message,'Staff assurance/role/disabled-state boundary mismatch');
 }
 return {identities:4,tokens:5,directReadDenials:25};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=await verifyAuth(process.env);console.log('PASS Test-only Auth disabled-state checks',result);}
 catch{console.error('FAIL Test-only Auth checks; verify required inputs and disabled-state authorization (details suppressed)');process.exitCode=1;}
}
