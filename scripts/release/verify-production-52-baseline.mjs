#!/usr/bin/env node
// Read-only pre-release guard: never run a hosted Supabase command from this file.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fail = why => { throw Error('STOP - Production 52-baseline guard: ' + why); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = (dir,relative) => {
  const p=join(dir,relative);
  if(!existsSync(p)||!lstatSync(p).isFile())fail('missing/nonregular '+relative);
  return readFileSync(p);
};
function main() {
  if(process.argv.length!==3)fail('usage: node scripts/release/verify-production-52-baseline.mjs /ABSOLUTE/isolated/workspace');
  const workspace=resolve(process.argv[2]);
  if(!existsSync(workspace)||!lstatSync(workspace).isDirectory())fail('workspace not found');
  if(realpathSync(workspace)===realpathSync(root))fail('Backend raw source directory is NOT a Production deploy workspace');
  const manifest=read(root,'docs/extraction/MIGRATION_MANIFEST.sha256');
  if(hash(manifest)!=='eb2dfee779a15634927cfbf25fcd6ffc59df591a585d1ec8f5f3d40e5caaf1dd')fail('canonical migration manifest drift');
  const lines=manifest.toString('utf8').trimEnd().split(/\r?\n/);
  if(lines.length!==58)fail('expected 58 original source entries');
  const original=new Map();
  for(const line of lines){
    const v=/^([a-f0-9]{64})  (supabase\/migrations\/(\d{14})_[A-Za-z0-9_-]+\.sql)$/.exec(line);
    if(!v)fail('invalid source manifest');
    const bytes=read(root,v[2]);
    if(hash(bytes)!==v[1])fail('canonical source bytes changed '+v[2]);
    if(original.has(v[3]))fail('duplicate canonical source version');
    original.set(v[3],{path:v[2],name:v[2].split('/').at(-1),hash:v[1],bytes});
  }
  const base=JSON.parse(read(root,'releases/production/category-foundation-v1/manifest.json'));
  const receipt=JSON.parse(read(root,'releases/production/category-foundation-v1/production-deployment-20261018.json'));
  const forward=JSON.parse(read(root,'releases/production/category-foundation-v1/forward-migration-plan.json'));
  if(base.targetProjectRef!=='kriuhwppxgxsyyrbjsau'||receipt.project?.ref!==base.targetProjectRef||forward.targetProjectRef!==base.targetProjectRef)fail('wrong project reference');
  if(receipt.status!=='APPLIED_AND_DATABASE_VERIFIED'||receipt.migrations.after!==52||base.productionDeploymentRecord?.verifiedProductionMigrationCount!==52)fail('unreconciled deployed receipt');
  const first=base.productionBaseline.appliedVersions;
  const next=forward.forwardMigrations;
  if(first.length!==45||next.length!==7||receipt.migrations.fullProductionLedger.length!==52)fail('wrong baseline size');
  const expectedVersions=[...first,...next.map(x=>x.version)];
  if(JSON.stringify(expectedVersions)!==JSON.stringify(receipt.migrations.fullProductionLedger))fail('ledger pin mismatch');
  const entries=first.map(version=>{
    const x=original.get(version);
    if(!x)fail('missing original baseline version '+version);
    return {filename:x.name,hash:x.hash,bytes:x.bytes};
  });
  for(const x of next){
    const orig=original.get(x.source.split('/').at(-1).slice(0,14));
    if(!orig||orig.path!==x.source||orig.hash!==x.sha256)fail('unapproved seven-file source mapping');
    entries.push({filename:x.file,hash:x.sha256,bytes:orig.bytes});
  }
  if(new Set(entries.map(x=>x.filename)).size!==52)fail('duplicate pinned filename');
  const migrations=join(workspace,'supabase/migrations');
  if(!existsSync(migrations)||!lstatSync(migrations).isDirectory())fail('missing workspace migrations directory');
  const actual=readdirSync(migrations).filter(x=>x.endsWith('.sql')).sort();
  const expected=entries.map(x=>x.filename).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))fail('workspace has missing, extra or Test-only migration files');
  for(const {filename,hash:sha,bytes} of entries){
    const present=read(workspace,'supabase/migrations/'+filename);
    if(hash(present)!==sha||!present.equals(bytes))fail('workspace SQL byte mismatch '+filename);
  }
  console.log('PASS: exactly 52 reviewed FairSwapProd SQL versions, SHA-256 verified; no Test-only activation or hosted operation');
}
try{main();}catch(e){console.error(e instanceof Error?e.message:String(e));process.exitCode=1;}
