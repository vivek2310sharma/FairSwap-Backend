// Offline only. No database URLs, credentials, CLI deployment or hosted writes.
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
const dir = fileURLToPath(new URL('./', import.meta.url));
const root = resolve(dir, '../../..');
const text = p => readFileSync(join(dir,p),'utf8').replaceAll('\r\n','\n');
const hash = s => createHash('sha256').update(s).digest('hex');
const manifest = JSON.parse(text('manifest.json'));
const ledger = JSON.parse(text('production-ledger-20261023.json'));
const migrationDir = join(dir,'supabase/migrations');
assert.equal(manifest.projectRef,'kriuhwppxgxsyyrbjsau');
assert.equal(ledger.count,57);
assert.equal(ledger.entries.length,57);
assert.equal(new Set(ledger.entries.map(x=>x.version)).size,57);
assert.equal(ledger.entries.at(-1).version,'20261022110410');
const priorReceipt = JSON.parse(readFileSync(join(root,'releases/production/category-foundation-v1/production-deployment-20261018.json'),'utf8'));
assert.deepEqual(ledger.entries.slice(0,52).map(x=>x.version),priorReceipt.migrations.fullProductionLedger);
assert.equal(hash(JSON.stringify(ledger.entries)),manifest.ledgerEntriesSha256);
assert.deepEqual(readdirSync(migrationDir),[manifest.migration.file]);
assert.ok(lstatSync(join(migrationDir,manifest.migration.file)).isFile());
for (const [file,digest] of Object.entries(manifest.files)) assert.equal(hash(text(file)),digest,file+' hash drift');
const migration = text('supabase/migrations/'+manifest.migration.file);
const preflight = text('preflight.readonly.sql');
const guard = preflight.slice(preflight.indexOf('-- Exact'),preflight.lastIndexOf('commit;'));
assert.ok(migration.includes(guard),'forward migration must embed the full preflight');
assert.ok(guard.includes(JSON.stringify(ledger.entries)),'preflight must pin exact ledger');
const candidate = readFileSync(join(root,manifest.source),'utf8').replaceAll('\r\n','\n');
assert.equal(hash(candidate),manifest.sourceSha256,'reviewed candidate drift');
// Only header and the fail-closed Production preflight may differ from PR #48.
const expected = candidate.replace('-- HDR-03 candidate only. Never apply from the immutable 58-file baseline.',
 '-- HDR-03 Production-only forward release; approved operator installation required.')
 .replace("set local statement_timeout = '30s';","set local statement_timeout = '30s';\n\n"+guard);
assert.equal(migration,expected,'unreviewed SQL differences from candidate');
console.log('PASS: one forward-only migration, candidate parity, ledger and package hashes');
if (process.argv.length === 2) process.exit(0);
assert.equal(process.argv.length,4);
assert.equal(process.argv[2],'--pglite-module');
const { PGlite } = await import(pathToFileURL(resolve(process.argv[3])).href);
const db = new PGlite(); // in-memory only; no connection option accepted
try {
 const read = p => readFileSync(join(root,p),'utf8');
 await db.exec(read('tests/hdr-03/fixture.sql'));
 await db.exec(read('supabase/migrations/20260914000010_create_notifications.sql'));
 await db.exec(read('supabase/migrations/20260914000011_create_communication.sql'));
 await db.exec('create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key,name text);');
 for (const x of ledger.entries) await db.query('insert into supabase_migrations.schema_migrations values ($1,$2)',[x.version,x.name]);
 await db.exec(preflight);
 await db.exec("update supabase_migrations.schema_migrations set name='wrong' where version='20261022110410'");
 await assert.rejects(db.exec(migration),/57-version ledger differs/);
 await db.exec('rollback');
 assert.equal((await db.query("select to_regclass('public.unread_count_signals') as signal")).rows[0].signal,null);
 await db.exec("update supabase_migrations.schema_migrations set name='production_family_submission_and_human_review_default_off_v1' where version='20261022110410'");
 await db.exec(migration);
 // Immutable source migrations publish the baseline messages/notifications.
 await db.exec(text('postflight.readonly.sql'));
 await assert.rejects(db.exec(migration),/already present or partial/);
 await db.exec('rollback');
 await db.exec(read('tests/hdr-03/assertions.sql'));
 console.log('PASS: disposable PostgreSQL forward install, wrong-ledger atomic refusal, repeat refusal, postflight and existing HDR-03 security/count assertions');
} catch (error) { console.error('FAIL:', error.message); process.exitCode = 1; }
finally { await db.close(); }
