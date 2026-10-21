import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readVerifiedSealedMedia} from '../../src/lib/moderation/v2/verified-media.ts';

function fixture() {
 const bytes=Uint8Array.of(82,73,70,70,8,0,0,0,87,69,66,80,0,1,2);
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const listingId=randomUUID(),mediaId=randomUUID(),assetVersion=randomUUID();
 const evidence={listingId,mediaId,assetVersion,sha256,byteLength:bytes.length,variant:'thumb',bucket:'listing-derivatives',mimeType:'image/webp',key:`${listingId}/${mediaId}/v2/${assetVersion}/${sha256}/thumb.webp`};
 return {bytes,evidence};
}

test('same-project delivery verifies exact bytes and disables caching',async()=>{
 const {bytes,evidence}=fixture();
 const output=await readVerifiedSealedMedia(evidence,{download:async(bucket,key)=>{
   assert.equal(bucket,evidence.bucket);assert.equal(key,evidence.key);return bytes;
 }});
 assert.equal(output.ok,true);
 assert.equal(output.cacheControl,'private, no-store');
 assert.deepEqual(output.bytes,bytes);
});
test('tampered byte rejects instead of issuing signed URL',async()=>{
 const {bytes,evidence}=fixture();
 const output=await readVerifiedSealedMedia(evidence,{download:async()=>{
   const tampered=Uint8Array.from(bytes);tampered[tampered.length-1]^=1;return tampered;
 }});
 assert.deepEqual(output,{ok:false,reason:'TAMPERED'});
});
test('forged listing key never triggers Storage read',async()=>{
 const {evidence}=fixture();let count=0;
 const output=await readVerifiedSealedMedia({...evidence,key:'other/path'}, {download:async()=>{count++;return Uint8Array.of(1);}});
 assert.deepEqual(output,{ok:false,reason:'BAD_EVIDENCE'});assert.equal(count,0);
});
