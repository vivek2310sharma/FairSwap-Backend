import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function canonicalDispatchFunctions(root){
  const result=[];
  for(const [file,names] of [
    ['20260926000023_email_outbox_dispatch_runtime.sql',['app_security.trg_fn_notify_email_outbox_worker','app_security.invoke_email_outbox_retry_batch']],
    ['20261011000039_moderation_dispatch_and_killswitch.sql',['app_security.trg_fn_notify_moderation_worker','app_security.invoke_moderation_retry_batch']],
  ]){
    const source=readFileSync(resolve(root,'supabase/migrations',file),'utf8');
    for(const name of names){
      const start=source.toLowerCase().indexOf(`create or replace function ${name.toLowerCase()}(`);
      if(start<0)throw Error('Canonical dispatch fixture missing');
      const part=source.slice(start),first=part.indexOf('$$'),end=part.indexOf('$$',first+2);
      if(first<0||end<0)throw Error('Canonical dispatch fixture malformed');
      result.push(part.slice(0,end+2)+';');
    }
  }
  return result.join('\n');
}
