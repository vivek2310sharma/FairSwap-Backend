import {dispatchChatSafety} from './scheduler.mjs';
// Invoked only by the protected default-branch workflow. Do not print env/headers/errors.
try{
  if(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY||process.env.NODE_DEBUG)throw Error();
  const result=await dispatchChatSafety({target:process.env.CHAT_SAFETY_TARGET,
    enabled:process.env.CHAT_SAFETY_SCHEDULER_ENABLED??'false',
    secret:process.env.CHAT_SAFETY_WORKER_SECRET,runId:process.env.GITHUB_RUN_ID},{fetch:globalThis.fetch});
  console.log(JSON.stringify({event:'chat_safety_scheduler',target:process.env.CHAT_SAFETY_TARGET,...result}));
}catch(error){
  const code=['INVALID_CONFIGURATION','INVALID_RESPONSE','AUTH_OR_CONFIGURATION_REJECTED','DELIVERY_RETRY_EXHAUSTED'].includes(error?.code)?error.code:'UNAVAILABLE';
  console.error('CHAT_SAFETY_SCHEDULER_FAILED:'+code);process.exitCode=1;
}
