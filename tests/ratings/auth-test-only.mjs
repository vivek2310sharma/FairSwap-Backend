import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const testUrl='https://wpppxlnbzqynvhpeuavd.supabase.co';
// Untrusted claims are only a preflight filter. Auth and PostgREST must both
// accept the unchanged bearer; decoding never establishes authorization.
function claims(token) {
 try {
  assert(typeof token==='string'&&token.length<16384&&/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token));
  const c=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
  const now=Math.floor(Date.now()/1000);
  assert(c.iss===testUrl+'/auth/v1'&&c.aud==='authenticated'&&c.role==='authenticated');
  assert(uuid.test(c.sub)&&uuid.test(c.session_id)&&c.is_anonymous!==true);
  assert(Number.isInteger(c.exp)&&c.exp>now+60&&Number.isInteger(c.iat)&&c.iat<=now&&c.exp>c.iat);
  assert(c.nbf===undefined||(Number.isInteger(c.nbf)&&c.nbf<=now));
  assert(['aal1','aal2'].includes(c.aal));
  return c;
 } catch {throw new Error('Invalid Test access-token input');}
}

// Read-only opt-in hosted smoke check. No login, fixture creation or database write.
// It intentionally cannot accept a Production URL. Supply only a publishable/anon
// API key and existing user access tokens; no privileged key is needed.
export function configuration(env) {
 assert.equal(env.RATINGS_AUTH_TARGET,'FairSwapTest','Explicit Test target required');
 assert.equal(env.RATINGS_AUTH_URL,'https://wpppxlnbzqynvhpeuavd.supabase.co','Only FairSwapTest is allowed');
 const names=['RATINGS_AUTH_PUBLISHABLE_KEY','RATINGS_AUTH_SELLER_TOKEN','RATINGS_AUTH_BUYER_TOKEN','RATINGS_AUTH_OUTSIDER_TOKEN','RATINGS_AUTH_STAFF_AAL1_TOKEN','RATINGS_AUTH_STAFF_AAL2_TOKEN'];
 for(const name of names)assert(typeof env[name]==='string'&&env[name].trim()===env[name]&&env[name],`Missing or invalid ${name}`);
 const key=env[names[0]];
 if(!/^sb_publishable_[\w-]+$/.test(key)) {
  // Legacy anon JWT keys are supported; privileged keys are never accepted.
  try {const c=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8'));assert(c.role==='anon'&&c.ref==='wpppxlnbzqynvhpeuavd');}
  catch {throw new Error('Test publishable/anon key required');}
 }
 const tokens=names.slice(1).map(n=>env[n]);
 const decoded=tokens.map(claims);
 assert(new Set(tokens).size===5,'Five distinct access tokens required');
 assert(new Set(decoded.slice(0,4).map(c=>c.sub)).size===4,'Distinct participant and staff identities required');
 assert(decoded[3].sub===decoded[4].sub&&decoded[3].aal==='aal1'&&decoded[4].aal==='aal2','Staff AAL1/AAL2 pair required');
 return {url:env.RATINGS_AUTH_URL,key:env[names[0]],tokens:names.slice(1).map(n=>env[n])};
}
async function run(env,transport) {
 const {url,key,tokens}=configuration(env);
 const request=async(path,token,body)=>{
  const r=await transport(url+path,{method:body===undefined?'GET':'POST',redirect:'error',
   headers:{apikey:key,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  // Never print responses, identities or tokens, including on failures.
  const data=await r.json();
  assert(data&&typeof data==='object'&&!Array.isArray(data),'Unexpected API response');
  return {status:r.status,data};
 };
 const identities=[];
 for(const token of tokens){const r=await request('/auth/v1/user',token);assert.equal(r.status,200,'Auth rejected a supplied user token');assert(r.data.id===claims(token).sub&&r.data.is_anonymous!==true,'Auth identity mismatch');identities.push(r.data.id);}
 assert.equal(new Set(identities.slice(0,4)).size,4,'Seller, buyer, outsider and staff must differ');
 assert.equal(identities[3],identities[4],'AAL tokens must belong to the same staff identity');
 assert.equal((await request('/auth/v1/user','invalid-token')).status,401,'Invalid token accepted');
 assert.equal((await request('/rest/v1/rpc/ratings_pending','invalid-token',{})).status,401,'PostgREST accepted invalid token');
 for(let i=0;i<tokens.length;i++){
  const r=await request('/rest/v1/rpc/ratings_pending',tokens[i],{});
  assert.equal(r.status,500,'Disabled RPC HTTP status mismatch');assert.equal(r.data.code,'55000','Ratings must remain disabled');assert.equal(r.data.message,'RATINGS_DISABLED');
  for(const table of ['rating_trades','rating_reviews','rating_replies','profile_rating_stats','trade_system_events']){
   const denied=await request(`/rest/v1/${table}?select=*&limit=1`,tokens[i]);
   assert([401,403].includes(denied.status),'Direct Ratings table read was not denied');assert.equal(denied.data.code,'42501');
  }
 }
 // Guard ordering checks both actual role membership and JWT assurance level.
 for(const [i,message] of [[0,'RATINGS_ACCESS_DENIED'],[1,'RATINGS_ACCESS_DENIED'],[2,'RATINGS_ACCESS_DENIED'],[3,'RATINGS_ACCESS_DENIED'],[4,'RATINGS_STAFF_DISABLED']]){
  const r=await request('/rest/v1/rpc/admin_ratings_cases',tokens[i],{kind:'dispute'});
  assert.equal(r.data.message,message,'Staff assurance/role/disabled-state boundary mismatch');
  assert.equal(r.status,i===4?500:403,'Staff HTTP boundary mismatch');
  assert.equal(r.data.code,i===4?'55000':'42501','Staff SQLSTATE mismatch');
 }
 return {identities:4,tokens:5,directReadDenials:25};
}
export async function verifyAuth(env,transport=globalThis.fetch) {
 try {return await run(env,transport);}
 catch {throw new Error('Test-only Auth acceptance failed (details suppressed)');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=await verifyAuth(process.env);console.log('PASS Test-only Auth disabled-state checks',result);}
 catch{console.error('FAIL Test-only Auth checks; verify required inputs and disabled-state authorization (details suppressed)');process.exitCode=1;}
}
