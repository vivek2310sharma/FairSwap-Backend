import test from 'node:test';
import assert from 'node:assert/strict';
import {readIdvProdState,runIdvProdPreflight,runIdvProdPostflight,
  verifyIdvProviderSecretNames,verifyIdvDeployedFunctions,verifyIdvProductionWeb}
  from '../../scripts/release/idv-digilocker-production-release.mjs';
const base={gate_on:true,seller_gate_on:true,strict_enforce:true,badge_provenance:true,
  completion_provenance:true,evidence_constraint:true,service_completion_only:true,
  service_gate_only:true,private_tables_rls:true};
test('postflight accepts full secure badge and mandatory write-gate invariants',()=>{
  assert.equal(runIdvProdPostflight(()=>JSON.stringify(base)).status,'PASS');
  for(const key of Object.keys(base))assert.throws(()=>runIdvProdPostflight(
    ()=>JSON.stringify({...base,[key]:false})),/POSTFLIGHT_FAILED/);
});
test('preflight keeps environment-specific original gate states',()=>{
  assert.equal(runIdvProdPreflight(()=>JSON.stringify(base),'FairSwapTest').gate_on,true);
  assert.throws(()=>runIdvProdPreflight(()=>JSON.stringify(base),'FairSwapProd'),/INITIAL_GATE/);
  const prod={...base,gate_on:false,seller_gate_on:false,strict_enforce:false,
    badge_provenance:false,completion_provenance:false,evidence_constraint:false};
  assert.equal(runIdvProdPreflight(()=>JSON.stringify(prod),'FairSwapProd').gate_on,false);
  assert.throws(()=>runIdvProdPreflight(()=>JSON.stringify({...prod,service_gate_only:false}),'FairSwapProd'),/PRIVILEGE_DRIFT/);
});
test('secret names and JWT-protected function releases fail closed',()=>{
 const good=['FAIRSWAP_DIGILOCKER_ENABLED','DIGILOCKER_AUTH_MODE','DIGILOCKER_CLIENT_ID','DIGILOCKER_CLIENT_SECRET',
  'DIGILOCKER_REDIRECT_URI','IDV_DIGILOCKER_STATE_KEY','IDV_DIGILOCKER_FP_KEY_CURRENT','IDV_DIGILOCKER_FP_KEY_V1'].map(name=>({name}));
 assert.equal(verifyIdvProviderSecretNames(good).status,'PASS');
 assert.throws(()=>verifyIdvProviderSecretNames(good.slice(1)),/CONFIG_MISSING/);
 const functions=['idv-digilocker-start','idv-digilocker-complete'].map(slug=>({slug,status:'ACTIVE',verify_jwt:true}));
 assert.equal(verifyIdvDeployedFunctions(functions).status,'PASS');
 assert.throws(()=>verifyIdvDeployedFunctions([{...functions[0],verify_jwt:false},functions[1]]),/EDGE_UNVERIFIED/);
});
test('Web source and current deployment must match before gate ON',async()=>{
 const sha='a'.repeat(40),env={WEB_PRODUCTION_SHA:sha,WEB_EVIDENCE_TOKEN:'mock'};
 const mock=async(url,opts)=>({ok:true,status: url==='https://fairswap.in/api/idv/digilocker/start'?401:200,
  json:async()=>url.endsWith('/branches/main')?{commit:{sha}}:
    url.includes('statuses?')?[{state:'success'}]:
    [{sha,environment:'Production',id:4}]});
 assert.equal((await verifyIdvProductionWeb(env,mock)).status,'PASS');
 await assert.rejects(()=>verifyIdvProductionWeb({...env,WEB_PRODUCTION_SHA:'bad'},mock),/EVIDENCE_MISSING/);
 const wrong=async(url,opts)=>url.includes('/branches/main')?{ok:true,json:async()=>({commit:{sha:'b'.repeat(40)}})}:mock(url,opts);
 await assert.rejects(()=>verifyIdvProductionWeb(env,wrong),/SHA_NOT_MAIN/);
});
