import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export const root=fileURLToPath(new URL('../../',import.meta.url));
const read=p=>readFileSync(resolve(root,p),'utf8');
export function canonicalMessaging(){
 const baseline=read('supabase/migrations/20260914000011_create_communication.sql').replace('ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;','');
 const policy=read('supabase/migrations/20260918000021_policy_reacceptance_records.sql');
 const latest=['app_security.impl_send_message','app_security.impl_mark_conversation_read'].map(name=>{
  const start=policy.indexOf('CREATE OR REPLACE FUNCTION '+name+'(');if(start<0)throw Error('Canonical function absent');
  const part=policy.slice(start),first=part.indexOf('$$'),last=part.indexOf('$$',first+2);if(first<0||last<0)throw Error('Canonical function malformed');
  return part.slice(0,last+2)+';';
 });
 return baseline+'\n'+latest.join('\n');
}
