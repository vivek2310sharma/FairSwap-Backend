// Windows checkout verification without rewriting any protected file/checksum.
// The strict existing verifier runs on exact Git bytes in an isolated directory.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyBaseline, manifestSha256 } from './verify-baseline.mjs';
export function matchesCheckout(blob, working) {
  if (blob.equals(working)) return true;
  const text = blob.toString('utf8');
  return !text.includes('\r') && Buffer.from(text, 'utf8').equals(blob)
    && Buffer.from(text.replaceAll('\n', '\r\n'), 'utf8').equals(working);
}
export function verifyCanonicalCheckout(root) {
  const git = (...args) => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\','/')}`, '-C', root, ...args], {maxBuffer:16*1024*1024});
  const head=git('rev-parse','HEAD').toString().trim();
  const manifestPath='docs/extraction/MIGRATION_MANIFEST.sha256';
  const manifest=git('show',`${head}:${manifestPath}`);
  const sha=b=>createHash('sha256').update(b).digest('hex');
  if(sha(manifest)!==manifestSha256)throw new Error('Canonical manifest digest differs from approved digest');
  const entries=manifest.toString('utf8').trimEnd().split('\n').map(line=>{
    const match=/^([a-f0-9]{64})  (supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql)$/.exec(line);
    if(!match)throw new Error('Canonical manifest format invalid');return {path:match[2],expected:match[1]};
  });
  const fixture=mkdtempSync(join(tmpdir(),'fairswap-canonical-checkout-'));
  const files=[];
  for(const entry of [{path:manifestPath,expected:manifestSha256},...entries]){
    const blob=entry.path===manifestPath?manifest:git('show',`${head}:${entry.path}`);
    const working=readFileSync(resolve(root,entry.path));
    if(sha(blob)!==entry.expected||!matchesCheckout(blob,working))throw new Error(`Protected content differs from approved Git bytes: ${entry.path}`);
    const dest=resolve(fixture,entry.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,blob);
    files.push({...entry,canonical_sha256:sha(blob),working_sha256:sha(working),checkout_conversion:!blob.equals(working)});
  }
  // The original strict verifier also checks the complete 58-path inventory.
  const inventory=readdirSync(resolve(root,'supabase/migrations'),{withFileTypes:true}).filter(e=>e.name.endsWith('.sql')).map(e=>{
    if(!e.isFile())throw new Error(`Migration must be a regular file: ${e.name}`);
    return `supabase/migrations/${e.name}`;
  }).sort();
  if(JSON.stringify(inventory)!==JSON.stringify(entries.map(e=>e.path).sort()))throw new Error('Working migration inventory differs from approved manifest');
  const count=verifyBaseline(fixture);
  return {status:'PASS',head,canonical_migrations:count,approved_manifest_sha256:manifestSha256,isolated_directory:fixture,files};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=resolve(import.meta.dirname,'../..');
  const result=verifyCanonicalCheckout(root);
  if(process.argv[2])writeFileSync(resolve(process.argv[2]),JSON.stringify(result,null,2)+'\n');
  console.log(`PASS: ${result.canonical_migrations} exact canonical migration hashes and approved manifest digest; every working file is identical or solely a CRLF checkout conversion. Protected bytes/checksums unchanged.`);
}
