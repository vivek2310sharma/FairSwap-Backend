import test from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
test('V1.1 fixture export matches reviewed Web hashes and preserves separate V1 history',()=>{
 const c=JSON.parse(readFileSync('supabase/forward-migrations/wearables-v11/web-ci-contract.json'));
 for(const[p,h]of Object.entries(c.files))assert.equal(createHash('sha256').update(readFileSync('tests/wearables-v11/web-fixture/'+p)).digest('hex'),h,p);
 const old=JSON.parse(readFileSync('tests/wearables-v1/web-fixture/src/lib/listings/wearables/catalogue.generated.json')),now=JSON.parse(readFileSync('tests/wearables-v11/web-fixture/src/lib/listings/wearables/catalogue.generated.json'));
 assert.equal(old.rows_total,607);assert.equal(old.revision,'8dd5783ac9b7e12e');assert.equal(now.revision,c.revision);assert(now.rows_total>old.rows_total);
 for(const[name,type]of[['Galaxy Watch9','smartwatch'],['Galaxy Watch Ultra2','sports_gps_watch'],['Pixel Watch 5','smartwatch']])assert.equal(now.models.find(m=>m.name===name)?.type,type);
});
test('Existing workflows preserve V1, add update/coexistence checks and gate Web evidence',()=>{
 const ci=readFileSync('.github/workflows/backend-ci.yml','utf8'),release=readFileSync('.github/workflows/reusable-supabase-release.yml','utf8');
 for(const pattern of[/tests\/wearables-v1\/web-fixture/,/tests\/wearables-v11\/web-fixture/,/test-wearables-v1.mjs --catalogue-update/,/test-wearables-tablets-v1.mjs --catalogue-update/])assert.match(ci,pattern);
 assert.match(release,/          - wearables-v11-catalogue\n/);assert.match(release,/inputs.candidate == 'wearables-v11-catalogue'\) && secrets.CHAT_RELEASE_AUDIT_TOKEN/);
});
