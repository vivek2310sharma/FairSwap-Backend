// Invoke from a trusted external five-minute scheduler. This does not process
// ratings or call global workers. The scheduler owns missing-heartbeat alarms.
export async function invokeRatingsMonitor(env=process.env,transport=fetch) {
 const origin=env.RATINGS_OPERATIONS_ENVIRONMENT==='FairSwapTest'
  ?'https://fair-swap-git-staging-fairswap.vercel.app'
  :env.RATINGS_OPERATIONS_ENVIRONMENT==='FairSwapProd'?'https://fairswap.in':null;
 if(!origin || (env.CRON_SECRET?.length??0)<32)throw new Error('RATINGS_MONITOR_CONFIG_REQUIRED');
 const headers={Authorization:`Bearer ${env.CRON_SECRET}`};
 if(env.VERCEL_AUTOMATION_BYPASS_SECRET)headers['x-vercel-protection-bypass']=env.VERCEL_AUTOMATION_BYPASS_SECRET;
 const response=await transport(origin+'/api/internal/ratings-monitor',{
  headers,redirect:'error',signal:AbortSignal.timeout(60000),cache:'no-store'
 });
 if(!response.ok)throw new Error('RATINGS_MONITOR_FAILED');
 const result=await response.json();
 if(result?.ok!==true || !Number.isInteger(result.alerts) || result.alerts<0 || result.alerts>10)throw new Error('RATINGS_MONITOR_INVALID_RESPONSE');
 return result.alerts;
}
if(process.argv[1]?.replaceAll('\\','/').endsWith('/monitor-scheduler.mjs')) {
 try{const alerts=await invokeRatingsMonitor();console.log(`PASS Ratings monitor heartbeat; alerts=${alerts}`);}
 catch{console.error('FAIL Ratings monitor heartbeat; scheduler must notify the responsible operator');process.exitCode=1;}
}
