// Explicit synthetic-fixture acceptance only. No global jobs, Auth admin API,
// environment files, feature activation, or Production target are supported.
import assert from 'node:assert/strict';
const url='https://wpppxlnbzqynvhpeuavd.supabase.co';
export async function runHostedProcessing(env=process.env,transport=fetch) {
 if(env.RATINGS_ACCEPTANCE_TARGET!=='FairSwapTest' || env.RATINGS_ACCEPTANCE_URL!==url
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(env.RATINGS_ACCEPTANCE_TRADE_ID??'')
  || !env.RATINGS_ACCEPTANCE_SERVICE_KEY)throw new Error('RATINGS_ACCEPTANCE_INPUTS_REQUIRED');
 const invoke=async()=> {
  const response=await transport(url+'/rest/v1/rpc/ratings_process_fixture',{
   method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
   headers:{apikey:env.RATINGS_ACCEPTANCE_SERVICE_KEY,
    ...(env.RATINGS_ACCEPTANCE_SERVICE_KEY.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${env.RATINGS_ACCEPTANCE_SERVICE_KEY}`}),
    'Content-Type':'application/json'},
   body:JSON.stringify({trade_id:env.RATINGS_ACCEPTANCE_TRADE_ID})
  });
  if(!response.ok)throw new Error('RATINGS_ACCEPTANCE_DENIED');
  const value=await response.json();assert(value===0||value===1);return value;
 };
 await invoke();assert.equal(await invoke(),0);
 return 'PASS scoped processing replay; notification persistence and RLS require SQL-suite evidence';
}
if(import.meta.url===new URL(process.argv[1]??'', 'file:///').href || process.argv[1]?.replaceAll('\\','/').endsWith('/hosted-processing.mjs')) {
 try{console.log(await runHostedProcessing());}catch{console.error('FAIL Ratings synthetic processing acceptance; inspect secure inputs and owner fixture registration');process.exitCode=1;}
}
