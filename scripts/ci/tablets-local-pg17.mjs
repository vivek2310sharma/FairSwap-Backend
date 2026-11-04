// Native counterpart to the in-memory tablet fixture. The socket and data
// directory are always created here, and the server never listens on TCP.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdtempSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';

export async function openTabletPg17(bin, {Client}) {
 const command = (name, args) => execFileSync(resolve(bin, name), args, {encoding:'utf8'});
 const version = command('postgres', ['--version']).trim();
 assert.match(version, /PostgreSQL\) 17\./);
 const dir = mkdtempSync('/tmp/fairswap-pg17-');
 chmodSync(dir, 0o700);
 const data = join(dir, 'data');
 const config = {host:dir, port:5432, database:'postgres', user:'tablet_fixture', ssl:false};
 let started = false;
 let client;
 try {
  command('initdb', ['-D',data,'-U',config.user,'--encoding=UTF8','--no-locale','--auth-local=trust','--auth-host=reject']);
  command('pg_ctl', ['-D',data,'-l',join(dir,'postgres.log'),'-w','start','-o',`-c listen_addresses='' -c unix_socket_directories=${dir} -c unix_socket_permissions=0700`]);
  started = true;
  client = new Client(config);
  await client.connect();
  return {
   version,
   exec: sql => client.query(sql),
   query: (sql, args) => client.query(sql, args),
   async newConnection() {
    const peer = new Client(config);
    await peer.connect();
    return peer;
   },
   async close() {
    try { await client.end(); }
    finally { stop(); }
   },
  };
 } catch (error) {
  try { await client?.end(); }
  finally { stop(); }
  throw error;
 }
 function stop() {
  if (started) command('pg_ctl', ['-D',data,'-w','stop','-m','fast']);
  rmSync(dir,{recursive:true,force:true});
 }
}
