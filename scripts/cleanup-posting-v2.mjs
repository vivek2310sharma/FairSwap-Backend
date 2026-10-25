// Operator-only, low-frequency cleanup. No env files are loaded. No schedule is installed.
// POSTING_CLEANUP_SUPABASE_URL / POSTING_CLEANUP_SERVICE_ROLE_KEY supplied privately
// by the scheduler. Run: node scripts/cleanup-posting-v2.mjs --execute --project-ref=<ref>
import { createClient } from '@supabase/supabase-js';
const ref=process.argv.find(a=>a.startsWith('--project-ref='))?.slice(14);
const url=process.env.POSTING_CLEANUP_SUPABASE_URL;
const key=process.env.POSTING_CLEANUP_SERVICE_ROLE_KEY;
if(!process.argv.includes('--execute')||!['wpppxlnbzqynvhpeuavd','kriuhwppxgxsyyrbjsau'].includes(ref)||url!==`https://${ref}.supabase.co`||!key)throw new Error('Explicit execution, matching project and private cleanup credentials required.');
const client=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function checked(promise){const r=await promise;if(r.error)throw new Error('Cleanup operation failed; rerun safely.');return r.data;}
async function removeTree(prefix){
 // Collect before deleting, so pagination cannot skip objects as pages shrink.
 const paths=[];
 async function walk(path){for(let offset=0;;offset+=100){const page=await checked(client.storage.from('posting-staged').list(path,{limit:100,offset,sortBy:{column:'name',order:'asc'}}));for(const item of page){if(!/^[a-z0-9.-]+$/i.test(item.name))throw new Error('Unexpected staged key');const next=`${path}/${item.name}`;if(item.id)paths.push(next);else await walk(next);}if(page.length<100)break;}}
 await walk(prefix);for(let i=0;i<paths.length;i+=100)await checked(client.storage.from('posting-staged').remove(paths.slice(i,i+100)));
}
let cleaned=0;
for(let batch=0;batch<20;batch++){
 const sessions=await checked(client.rpc('posting_v2_cleanup',{operation:'claim',session_id:null}));
 if(!Array.isArray(sessions))throw new Error('Invalid cleanup response');if(!sessions.length)break;
 for(const s of sessions){
  if(!uuid.test(s.id)||!uuid.test(s.owner_id)||!uuid.test(s.listing_id)||typeof s.submitted!=='boolean'||!Array.isArray(s.media)||!Array.isArray(s.attached)||!s.attached.every(id=>uuid.test(id)))throw new Error('Invalid cleanup scope');
  await removeTree(`${s.owner_id}/${s.id}`);
  for(const m of s.media){if(!uuid.test(m.id))throw new Error('Invalid media identifier');if(s.submitted&&s.attached.includes(m.id))continue;const base=`${s.listing_id}/${m.id}`;await checked(client.storage.from('listing-originals').remove([`${base}/original.webp`]));await checked(client.storage.from('listing-derivatives').remove(['thumb','medium','large'].map(n=>`${base}/${n}.webp`)));}
  await checked(client.rpc('posting_v2_cleanup',{operation:'ack',session_id:s.id}));cleaned++;
 }
}
console.log(JSON.stringify({cleaned_sessions:cleaned}));
