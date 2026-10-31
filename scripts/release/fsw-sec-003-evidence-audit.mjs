// Read-only metadata audit. No SQL/CLI, database credentials, restoration or release imports.
import {createHash} from 'node:crypto';
import {readFileSync, mkdirSync, writeFileSync, appendFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
import {auditProtection, requireOwnerActors, canonicalJson} from './inbox-protection.mjs';

export const repository = 'vivek2310sharma/FairSwap-Backend';
export const workflow = '.github/workflows/fsw-sec-003-evidence-audit.yml';
export const refs = Object.freeze({FairSwapTest:'wpppxlnbzqynvhpeuavd', FairSwapProd:'kriuhwppxgxsyyrbjsau'});
const root = fileURLToPath(new URL('../../', import.meta.url));
const day = 86400000;
export function backupDecision(environment) {
 need(Object.hasOwn(refs,environment)&&refs[environment]===({FairSwapTest:'wpppxlnbzqynvhpeuavd',FairSwapProd:'kriuhwppxgxsyyrbjsau'})[environment],'WRONG_PROJECT');
 return {status:'WAIVED_BY_OWNER',environment,projectRef:refs[environment],
 sha256:'b9746cdf49299af84bbbfc5f79b51dd7d67a737202a2d54c55f8743fc15770bd',
 version:'20261031110408',file:'20261031110408_fsw_sec_003_public_search_hardening.sql',
 authorization:'https://github.com/vivek2310sharma/FairSwap-Backend/pull/75',
 scope:['provider-managed-backup','backup-dependent-restore']};
}
const passed = checks => ['target','exposure','protections'].every(key=>checks[key]?.status==='PASS');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, code) => { if (!condition) throw Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function sourceHash() {
  return hash([workflow, 'scripts/release/fsw-sec-003-evidence-audit.mjs', 'scripts/release/inbox-protection.mjs',
    'tests/fsw-sec-003/evidence-audit.test.mjs'].map(path => hash(readFileSync(join(root,path)))+'  '+path).join('\n'));
}
function binding(environment, c) {
  return {repository, workflow, environment, projectRef:refs[environment], sourceCommit:c.GITHUB_SHA,
    sourceSha256:sourceHash(), runId:c.GITHUB_RUN_ID, runAttempt:c.GITHUB_RUN_ATTEMPT};
}
export function authorize(environment, c) {
  requireOwnerActors(c);
  need(Object.hasOwn(refs,environment) && c.FSW_ENVIRONMENT === environment, 'TARGET_REQUIRED');
  need(c.GITHUB_REPOSITORY === repository && c.GITHUB_REF === 'refs/heads/main', 'OWNER_MAIN_REQUIRED');
  need(c.GITHUB_WORKFLOW_REF === `${repository}/${workflow}@refs/heads/main`, 'PRODUCER_REQUIRED');
  need(/^[a-f0-9]{40}$/.test(c.GITHUB_SHA ?? '') && c.APPROVED_SHA === c.GITHUB_SHA, 'REVIEWED_SOURCE_REQUIRED');
  need(/^[1-9][0-9]*$/.test(c.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/.test(c.GITHUB_RUN_ATTEMPT ?? ''), 'RUN_REQUIRED');
}
function timestamp(value) {
  need(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value), 'UNEXPECTED_RESPONSE');
  const time = Date.parse(value);
  const [whole, fraction = ''] = value.slice(0,-1).split('.');
  need(Number.isFinite(time) && new Date(time).toISOString() === whole+'.'+fraction.padEnd(3,'0')+'Z', 'UNEXPECTED_RESPONSE');
  return time;
}
// Only three exact metadata routes plus the opposite project's identity are reachable.
function provider(token, environment, fetcher) {
  const own = `https://api.supabase.com/v1/projects/${refs[environment]}`;
  const other = `https://api.supabase.com/v1/projects/${Object.values(refs).find(ref => ref !== refs[environment])}`;
  const allowed = new Set([own, other, own+'/database/backups', own+'/postgrest']);
  return async (url, denialOnly = false) => {
    need(allowed.has(url), 'ENDPOINT_FORBIDDEN');
    need(typeof token === 'string' && token.length > 0, 'CREDENTIAL_UNAVAILABLE');
    let response;
    try {
      response = await fetcher(url, {method:'GET', headers:{Authorization:`Bearer ${token}`, Accept:'application/json'},
        redirect:'error', cache:'no-store', signal:AbortSignal.timeout(15000)});
    } catch { throw Error('PROVIDER_UNAVAILABLE'); }
    if (denialOnly) {
      need(response.status === 403 || response.status === 404, 'SCOPED_ISOLATION_UNVERIFIED');
      return true; // Never read the opposite project's body.
    }
    need(![401,403,404].includes(response.status), 'READ_PERMISSION_UNAVAILABLE');
    need(response.status === 200 && response.ok === true && response.redirected !== true, 'UNEXPECTED_RESPONSE');
    need(response.headers && /application\/json/i.test(response.headers.get('content-type') ?? ''), 'UNEXPECTED_RESPONSE');
    need(!response.headers.get('link') && !response.headers.get('content-range'), 'INCOMPLETE_INVENTORY');
    let data;
    try { data = await response.json(); } catch { throw Error('UNEXPECTED_RESPONSE'); }
    need(object(data), 'UNEXPECTED_RESPONSE');
    // These routes have no pagination contract. Reject possible truncation rather than infer completeness.
    for (const key of ['next','next_page','cursor','has_more','total_count','pagination','links'])
      need(!Object.hasOwn(data,key), 'INCOMPLETE_INVENTORY');
    return data;
  };
}
export function backupMetadata(data, now) {
  need(object(data) && Array.isArray(data.backups) && typeof data.pitr_enabled === 'boolean' && typeof data.walg_enabled === 'boolean', 'UNEXPECTED_RESPONSE');
  need(data.backups.length < 10000, 'INCOMPLETE_INVENTORY');
  const seen = new Set();
  const backups = data.backups.map(row => {
    need(object(row) && positive(row.id) && !seen.has(row.id) && typeof row.is_physical_backup === 'boolean' &&
      ['COMPLETED','FAILED','PENDING','IN_PROGRESS'].includes(row.status), 'UNEXPECTED_RESPONSE');
    seen.add(row.id);
    need(timestamp(row.inserted_at) <= now, 'UNEXPECTED_RESPONSE');
    return {id:row.id, status:row.status, createdAt:row.inserted_at, type:row.is_physical_backup ? 'physical':'logical'};
  }).sort((a,b) => a.id-b.id);
  let physicalCoverage = null;
  if (data.physical_backup_data != null) {
    const p = data.physical_backup_data;
    need(object(p) && positive(p.earliest_physical_backup_date_unix) && positive(p.latest_physical_backup_date_unix) &&
      p.earliest_physical_backup_date_unix <= p.latest_physical_backup_date_unix && p.latest_physical_backup_date_unix*1000 <= now, 'UNEXPECTED_RESPONSE');
    physicalCoverage = {earliestUnix:p.earliest_physical_backup_date_unix, latestUnix:p.latest_physical_backup_date_unix};
  }
  const fresh = backups.some(row => row.status === 'COMPLETED' && now-timestamp(row.createdAt) <= day);
  return {status:fresh ? 'PASS':'UNVERIFIED', reason:fresh ? 'FRESH_COMPLETED_BACKUP_METADATA':'NO_FRESH_COMPLETED_BACKUP',
    backups, pitrEnabled:data.pitr_enabled, walgEnabled:data.walg_enabled, physicalCoverage,
    retention:{status:'UNVERIFIED', reason:'RETENTION_POLICY_NOT_PROVEN_BY_BACKUP_LIST'}, storageObjects:'UNVERIFIED', restore:'UNVERIFIED'};
}
export function exposureMetadata(data) {
  need(typeof data?.db_schema === 'string' && data.db_schema.length <= 4096, 'UNEXPECTED_RESPONSE');
  const schemas = data.db_schema.split(',').map(value => value.trim()).sort();
  need(schemas.length > 0 && schemas.every(value => /^[a-z_][a-z0-9_]{0,62}$/.test(value)) && new Set(schemas).size === schemas.length, 'UNEXPECTED_RESPONSE');
  const publicOnly = schemas.length === 1 && schemas[0] === 'public';
  return {status:publicOnly ? 'PASS':'FAIL', reason:publicOnly ? 'PUBLIC_ONLY_PROVIDER_CONFIG':'UNEXPECTED_EXPOSED_SCHEMA', schemas};
}
const reasons = new Set(['CREDENTIAL_UNAVAILABLE','PROVIDER_UNAVAILABLE','READ_PERMISSION_UNAVAILABLE','UNEXPECTED_RESPONSE',
  'INCOMPLETE_INVENTORY','SCOPED_ISOLATION_UNVERIFIED','WRONG_PROJECT','PROTECTION_UNVERIFIED']);
async function check(action) {
  try { return await action(); }
  catch (error) { return {status:'UNVERIFIED', reason:reasons.has(error?.message) ? error.message:'PROTECTION_UNVERIFIED'}; }
}
export async function collect(environment, {context:c = process.env, fetcher = fetch, now = Date.now()} = {}) {
  authorize(environment,c); // Invalid invocations make zero API calls and produce no trusted receipt.
  const get = provider(c.SUPABASE_ACCESS_TOKEN,environment,fetcher);
  const base = `https://api.supabase.com/v1/projects/${refs[environment]}`;
  const target = await check(async () => {
    const data = await get(base);
    need(data.id === refs[environment] && data.name === environment, 'WRONG_PROJECT');
    await get(`https://api.supabase.com/v1/projects/${Object.values(refs).find(ref => ref !== refs[environment])}`,true);
    return {status:'PASS', reason:'PROJECT_IDENTITY_AND_SCOPED_ISOLATION'};
  });
  const backups = target.status === 'PASS' ? await check(async () => backupMetadata(await get(base+'/database/backups'),now)) : {status:'UNVERIFIED',reason:'TARGET_UNVERIFIED'};
  const exposure = target.status === 'PASS' ? await check(async () => exposureMetadata(await get(base+'/postgrest'))) : {status:'UNVERIFIED',reason:'TARGET_UNVERIFIED'};
  const protections = await check(async () => {
    need(typeof c.CHAT_RELEASE_AUDIT_TOKEN === 'string' && c.CHAT_RELEASE_AUDIT_TOKEN.length > 0, 'CREDENTIAL_UNAVAILABLE');
    // Reuse the existing two-snapshot protection policy, including bypass and complete inventories.
    const result = await auditProtection(environment,c.CHAT_RELEASE_AUDIT_TOKEN,fetcher,{
      sourceCommit:c.GITHUB_SHA,bundleSha256:sourceHash(),actor:c.GITHUB_ACTOR,triggeringActor:c.GITHUB_TRIGGERING_ACTOR});
    need(result.environment === environment && result.sourceCommit === c.GITHUB_SHA && result.protected === true && hex(result.snapshotSha256), 'PROTECTION_UNVERIFIED');
    return {status:'PASS',reason:'EXISTING_PROTECTION_POLICY_VERIFIED',snapshotSha256:result.snapshotSha256};
  });
  const checks = {target,backups,exposure,protections};
  return {schema:1, kind:'fsw-sec-003-read-only-metadata', ...binding(environment,c), observedAt:new Date(now).toISOString(),
    status:passed(checks) ? 'PASS':'UNVERIFIED', checks, backupRecovery:backupDecision(environment),
    releaseEligible:false, recovery:'UNVERIFIED', privilegedWriterInventory:'UNVERIFIED', retiredWriters:'UNVERIFIED'};
}
export function writeReceipt(receipt, directory) {
  mkdirSync(directory,{recursive:false, mode:0o700});
  const bytes = canonicalJson(receipt)+'\n';
  writeFileSync(join(directory,'receipt.json'),bytes,{flag:'wx',mode:0o600});
  writeFileSync(join(directory,'SHA256SUMS'),hash(bytes)+'  receipt.json\n',{flag:'wx',mode:0o600});
  return hash(bytes);
}
// expectedHash MUST come from the producing job's trusted output, never from the artifact itself.
// Workflow downloads by immutable artifact ID from that job; this function alone is not authentication.
export function verifyReceipt(bytes, expectedHash, environment, c, now = Date.now()) {
  authorize(environment,c);
  need(hex(expectedHash) && hash(bytes) === expectedHash, 'TRUSTED_CHECKSUM_REQUIRED');
  const receipt = JSON.parse(bytes);
  for (const [key,value] of Object.entries(binding(environment,c))) need(receipt[key] === value, 'RUN_SOURCE_TARGET_REQUIRED');
  need(receipt.schema === 1 && receipt.kind === 'fsw-sec-003-read-only-metadata' &&
    receipt.releaseEligible === false && receipt.recovery === 'UNVERIFIED' && receipt.privilegedWriterInventory === 'UNVERIFIED' && receipt.retiredWriters === 'UNVERIFIED', 'METADATA_ONLY_REQUIRED');
  const age = now-timestamp(receipt.observedAt);
  need(age >= 0 && age <= day, 'FRESH_EVIDENCE_REQUIRED');
  need(object(receipt.checks) && Object.keys(receipt.checks).sort().join(',') === 'backups,exposure,protections,target' &&
    Object.values(receipt.checks).every(value => ['PASS','FAIL','UNVERIFIED'].includes(value?.status)), 'COMPLETE_CHECKS_REQUIRED');
  // Legacy receipts retain their original all-checks requirement.
  if(receipt.backupRecovery!==undefined)need(canonicalJson(receipt.backupRecovery)===canonicalJson(backupDecision(environment)),'BACKUP_WAIVER_SCOPE_REQUIRED');
  const expected = (receipt.backupRecovery ? passed(receipt.checks) : Object.values(receipt.checks).every(value => value.status === 'PASS')) ? 'PASS':'UNVERIFIED';
  need(receipt.status === expected, 'FALSE_PASS_FORBIDDEN');
  return receipt;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const receipt = await collect(process.argv[2]);
    const sha = writeReceipt(receipt,resolve('fsw-audit-receipt'));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT,`sha256=${sha}\nstatus=${receipt.status}\n`);
    if (receipt.status !== 'PASS') process.exitCode = 1;
  } catch { console.error('FSW_EVIDENCE_AUDIT_UNVERIFIED'); process.exitCode = 1; }
}
