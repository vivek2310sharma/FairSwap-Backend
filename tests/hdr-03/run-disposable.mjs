import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = [
  'tests/hdr-03/fixture.sql',
  'supabase/migrations/20260914000010_create_notifications.sql',
  'supabase/migrations/20260914000011_create_communication.sql',
  'releases/candidates/hdr-03/supabase/migrations/20261023105600_hdr03_unread_counts.sql',
  'tests/hdr-03/assertions.sql',
];
const sql = sources.map(p => readFileSync(path.join(root,p),'utf8')).join('\n');
if (process.argv[2] === '--emit-sql' && process.argv.length === 3) {
  process.stdout.write(sql);
} else if (process.argv[2] === '--pglite-module' && process.argv.length === 4) {
  // In-memory PostgreSQL only: this mode accepts no URL, host or credentials.
  const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[3])).href);
  const db = new PGlite();
  try { await db.exec(sql); console.log('PASS: HDR-03 disposable PostgreSQL assertions (see assertions.sql)'); }
  catch (error) { console.error('FAIL:', error.message, 'code:', error.code, 'position:', error.position, 'context:', error.where); process.exitCode = 1; }
  finally { await db.close(); }
} else { throw new Error('Use --emit-sql for a fresh CI-only database, or --pglite-module <local module entry> for in-memory PostgreSQL'); }
