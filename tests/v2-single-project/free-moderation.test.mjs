import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {moderateText, moderateCanonicalWebp, OPENAI_MODERATION_MODEL} from '../../src/lib/moderation/v2/free-moderation.ts';

const all = [
  'harassment', 'harassment/threatening', 'hate', 'hate/threatening',
  'illicit', 'illicit/violent', 'sexual/minors', 'sexual', 'self-harm',
  'self-harm/intent', 'self-harm/instructions', 'violence', 'violence/graphic',
];
function reply({bad=false,malformed=false}={}) {
 const categories=Object.fromEntries(all.map(k=>[k,false]));
 const scores=Object.fromEntries(all.map(k=>[k,0.01]));
 if(bad) categories.violence=true;
 if(malformed) delete scores.violence;
 return {model:OPENAI_MODERATION_MODEL,results:[{flagged:bad,categories,category_scores:scores}]};
}
const fake = (value, status=200) => async (url, options) => {
  assert.equal(url,'https://api.openai.com/v1/moderations');
  assert.equal(options.method,'POST');
  assert.match(options.headers.authorization,/^Bearer test_/);
  return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
};
const apiKey='test_fake_key_not_real_123';

test('free endpoint request is bounded, pinned, and text-only',async()=>{
  let body;
  const fetcher=async (url, options)=>{
    body=JSON.parse(options.body);
    return new Response(JSON.stringify(reply()),{status:200});
  };
  const out=await moderateText('Selling a used iPhone', {apiKey,fetcher});
  assert.equal(out.state,'clear');
  assert.equal(body.model,OPENAI_MODERATION_MODEL);
  assert.deepEqual(body.input,[{type:'text',text:'Selling a used iPhone'}]);
});

test('flagged harm is routed, not approved',async()=>{
 const out=await moderateText('violent statement',{apiKey,fetcher:fake(reply({bad:true}))});
 assert.equal(out.state,'flagged');
 assert.equal(out.categoryFlags.violence,true);
});

test('missing provider scores fail closed',async()=>{
 const out=await moderateText('something',{apiKey,fetcher:fake(reply({malformed:true}))});
 assert.deepEqual(out,{state:'failed',reason:'PROVIDER_SCHEMA'});
});

test('401/429 and network failure never become pass',async()=>{
 assert.deepEqual(await moderateText('seller',{apiKey,fetcher:fake({error:'bad token'},401)}),{state:'failed',reason:'PROVIDER_AUTH'});
 assert.deepEqual(await moderateText('seller',{apiKey,fetcher:fake({error:'rate limit'},429)}),{state:'failed',reason:'PROVIDER_LIMIT'});
 assert.deepEqual(await moderateText('seller',{apiKey,fetcher:async()=>{throw Error('secret and PII');}}),{state:'failed',reason:'PROVIDER_UNAVAILABLE'});
});

test('canonical image is sent inline after SHA256 verified, never a mutable URL',async()=>{
 const bytes=Uint8Array.from([82,73,70,70,12,0,0,0,87,69,66,80,0,0,0,0]);
 const digest=createHash('sha256').update(bytes).digest('hex');
 let body;
 const fetcher=async (_,req)=>{
   body=JSON.parse(req.body);
   return new Response(JSON.stringify(reply()),{status:200});
 };
 const out=await moderateCanonicalWebp(bytes,digest,{apiKey,fetcher});
 assert.equal(out.state,'clear');
 assert.equal(body.input[0].type,'image_url');
 assert.equal(body.input[0].image_url.url,'data:image/webp;base64,'+Buffer.from(bytes).toString('base64'));
 const blocked=await moderateCanonicalWebp(bytes,'0'.repeat(64),{apiKey,fetcher:async()=>{throw Error('should not call')}});
 assert.deepEqual(blocked,{state:'failed',reason:'PROVIDER_INPUT'});
});
