// Secret-free configuration. Only these exact HTTPS destinations can receive a credential.
export const TARGETS=Object.freeze({
  test:Object.freeze({project:'wpppxlnbzqynvhpeuavd',url:'https://wpppxlnbzqynvhpeuavd.supabase.co/functions/v1/process-chat-safety'}),
  prod:Object.freeze({project:'kriuhwppxgxsyyrbjsau',url:'https://kriuhwppxgxsyyrbjsau.supabase.co/functions/v1/process-chat-safety'}),
});
const fail=code=>Object.assign(new Error(code),{code});
async function boundedJson(response){
  const reader=response.body?.getReader();if(!reader)throw fail('INVALID_RESPONSE');
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2048)throw fail('INVALID_RESPONSE');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const raw=new Uint8Array(size);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.byteLength;}
  let data;try{data=JSON.parse(new TextDecoder().decode(raw));}catch{throw fail('INVALID_RESPONSE');}
  if(!data||!['completed','disabled'].includes(data.state)||Object.keys(data).some(k=>!['state','claimed','completed','failed'].includes(k)))throw fail('INVALID_RESPONSE');
  for(const key of ['claimed','completed','failed'])if(!Number.isInteger(data[key])||data[key]<0||data[key]>20)throw fail('INVALID_RESPONSE');
  if(data.failed!==0||data.completed!==data.claimed||(data.state==='disabled'&&data.claimed!==0))throw fail('INVALID_RESPONSE');
  return data;
}

/** Injectable transport; no CLI/env access, raw response logging, provider SDK or DB credential. */
export async function dispatchChatSafety(config,{fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  if(!config||!Object.hasOwn(TARGETS,config.target)||!['true','false'].includes(config.enabled))throw fail('INVALID_CONFIGURATION');
  if(config.enabled==='false')return{state:'disabled',attempts:0,claimed:0,completed:0,failed:0};
  if(typeof config.secret!=='string'||config.secret.length!==64||!/^[a-f0-9]{64}$/.test(config.secret)||!/^\d{1,20}$/.test(config.runId)||config.runId.startsWith('0'))throw fail('INVALID_CONFIGURATION');
  const invocation=`gha:${config.runId}:${config.target}`;
  for(let attempt=1;attempt<=3;attempt++){
    let retry=true;
    try{
      const response=await fetch(TARGETS[config.target].url,{
        method:'POST',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',
        signal:AbortSignal.timeout(15000),
        headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.secret}`,
          'x-chat-safety-invocation-id':invocation,'x-chat-safety-target':config.target},body:'{}',
      });
      if(response.status===200)return{...await boundedJson(response),attempts:attempt};
      await response.body?.cancel().catch(()=>{});
      retry=[409,429,500,502,503,504].includes(response.status);
    }catch(error){
      if(error?.code==='INVALID_RESPONSE')throw fail('INVALID_RESPONSE');
      // Errors may contain URLs, headers or upstream bodies. Never propagate them.
    }
    if(!retry)throw fail('AUTH_OR_CONFIGURATION_REJECTED');
    if(attempt<3)await wait(attempt===1?1000:3000);
  }
  throw fail('DELIVERY_RETRY_EXHAUSTED');
}
