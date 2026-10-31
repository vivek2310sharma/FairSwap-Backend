// Narrow psql adapter. A fresh private fixture socket is the only accepted target.
import { spawnSync } from 'node:child_process';
import { realpathSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, basename } from 'node:path';
export class NativeDatabase {
 constructor(bin, socket) {
  if (!isAbsolute(bin) || !isAbsolute(socket)) throw Error('Absolute fixture paths required');
  this.bin = realpathSync(bin); this.socket = realpathSync(socket);
  if (!basename(this.socket).startsWith('fsw-search-native-') || !existsSync(join(this.socket,'data/postmaster.pid'))) throw Error('Fresh fixture socket required');
  const pid = readFileSync(join(this.socket,'data/postmaster.pid'),'utf8').split('\n');
  if (pid[1] !== join(this.socket,'data') || pid[4] !== this.socket) throw Error('Fixture socket/data identity mismatch');
  this.role = 'search_fixture_admin';
 }
 async process(sql) {
  const r = spawnSync(join(this.bin,'psql'), ['-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',this.socket,'-p','5432','-U','search_fixture_admin','-d','postgres'], {
   input:`set role ${this.role};\n${sql}`, encoding:'utf8', maxBuffer:16*1024*1024, timeout:30000,
   env:{PATH:process.env.PATH,PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8'},
  });
  if (r.error) throw r.error;
  if (r.status !== 0) { const e=new Error(r.stderr.trim()); e.code=r.stderr.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]; throw e; }
  return r.stdout.trim();
 }
 async exec(sql) {
  await this.process(sql);
  for(const m of sql.matchAll(/(?:set role (\w+)|reset role)/gi)) this.role=m[1]??'search_fixture_admin';
 }
 async query(sql) {
  if (/^explain /i.test(sql)) return {rows:[{'QUERY PLAN':JSON.parse(await this.process(sql))}]};
  return {rows:JSON.parse(await this.process(`select coalesce(json_agg(row_to_json(x)),'[]'::json) from (${sql}) x;`))};
 }
 async close() {}
}
