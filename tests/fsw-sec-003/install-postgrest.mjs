// Pinned test binary, never a runtime application dependency.
import { readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const pin=JSON.parse(readFileSync(new URL('./postgrest-pin.json',import.meta.url)));
const artifact=pin[`${process.platform}-${process.arch}`];
if(!artifact) throw Error('Unsupported PostgREST fixture platform');
const dest=fileURLToPath(new URL('../../artifacts/fsw-sec-003/postgrest/',import.meta.url));
mkdirSync(dest,{recursive:true});
const archive=path.join(dest,'postgrest.tar.xz');
execFileSync('curl',['--fail','--silent','--show-error','--location','--proto','=https','--tlsv1.2',artifact.url,'-o',archive],{stdio:'inherit'});
if(createHash('sha256').update(readFileSync(archive)).digest('hex')!==artifact.sha256) throw Error('PostgREST archive checksum mismatch');
execFileSync('tar',['-xJf',archive,'-C',dest]);
const version=execFileSync(path.join(dest,'postgrest'),['--version'],{encoding:'utf8'});
if(!version.includes(pin.version)) throw Error('PostgREST version mismatch');
console.log(`PASS pinned PostgREST ${pin.version}`);
