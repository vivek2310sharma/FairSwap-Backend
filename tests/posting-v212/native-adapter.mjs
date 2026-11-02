// Independent psql backends, no JS driver/dependency or externally supplied connection URL.
import {spawn} from 'node:child_process';
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
import assert from 'node:assert/strict';
export const literal=value=>value===null?'null':typeof value==='number'?String(value):`'${String(value).replaceAll("'","''")}'`;
export class NativeFixture {
 constructor(bin,socket){
  assert(isAbsolute(bin)&&isAbsolute(socket));this.bin=realpathSync(bin);this.socket=realpathSync(socket);this.children=new Set();this.observations=[];
  assert.match(this.socket,/^\/private\/tmp\/fairswap-posting-native-|^\/tmp\/fairswap-posting-native-/);
  assert.equal(statSync(this.socket).mode&0o777,0o700);
  assert.equal(readFileSync(join(this.socket,'fixture-kind'),'utf8').trim(),'fairswap-posting-native-v1');
  assert.equal(readFileSync(join(this.socket,'data/PG_VERSION'),'utf8').trim(),'17');
 }
 start(sql,{owner='',role='posting_fixture_admin',name='posting_control',jwt='{}'}={},hold=false){
  assert(['posting_fixture_admin','authenticated','anon','service_role'].includes(role));assert.match(name,/^[a-zA-Z0-9_-]{1,60}$/);
  const child=spawn(join(this.bin,'psql'),['-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-h',this.socket,'-p','5432','-U','posting_fixture_admin','-d','postgres','-f','-'],{
   env:{PATH:process.env.PATH,LC_ALL:'C',PGAPPNAME:name,PGCONNECT_TIMEOUT:'5',PGPASSFILE:join(this.socket,'no-passwords'),PGSERVICEFILE:join(this.socket,'no-services')},stdio:['pipe','pipe','pipe']});
  this.children.add(child);let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
  const context=`begin; set local role ${role}; set local "request.user"=${literal(owner)}; set local "request.jwt"=${literal(jwt)}; set local "request.policy"='true'; set local statement_timeout='10s';\n`;
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',status=>{this.children.delete(child);if(status===0)resolve(out.trim());else{const e=new Error(err.trim());e.code=err.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]??'PSQL_ERROR';reject(e);}});});
  // Holding the stdin pipe open leaves a real transaction idle until the test releases it.
  const handle={name,done,error:null,finish:(commit=true)=>{child.stdin.end(commit?'commit;\n':'rollback;\n');return done;}};
  void done.catch(error=>{handle.error=error;});
  child.stdin.write(context+sql+';\n');if(!hold)child.stdin.end('commit;\n');return handle;
 }
 async exec(sql){return this.start(sql).done;}
 async query(sql,args=[],context={}){
  const bound=sql.replace(/\$(\d+)\b/g,(_,n)=>literal(args[+n-1]));
  const out=await this.start(`select coalesce(json_agg(row_to_json(q)),'[]'::json) from (${bound}) q`,context).done;
  return {rows:JSON.parse(out)};
 }
 async verify(){
  const {rows:[r]}=await this.query(`select current_setting('server_version_num')::int as version,current_setting('data_directory') as data,current_setting('listen_addresses') as listeners,current_user as actor`);
  assert(r.version>=170000&&r.version<180000);assert.equal(realpathSync(r.data),join(this.socket,'data'));assert.equal(r.listeners,'');assert.equal(r.actor,'posting_fixture_admin');return r.version;
 }
 async activity(name){return (await this.query('select pid,state,wait_event_type,wait_event from pg_stat_activity where application_name=$1',[name])).rows[0];}
 async wait(handle,predicate){
  const deadline=Date.now()+5000;
  while(Date.now()<deadline){if(handle.error)throw handle.error;const row=await this.activity(handle.name);if(row&&predicate(row))return row;await new Promise(r=>setTimeout(r,15));}
  throw new Error(`Native transaction barrier not reached: ${handle.name}`);
 }
 async blocked(handle,holder){
  const h=await this.wait(holder,r=>r.state==='idle in transaction');const w=await this.wait(handle,r=>r.wait_event_type==='Lock');
  assert.notEqual(h.pid,w.pid);this.observations.push({holder:holder.name,holder_pid:h.pid,waiter:handle.name,waiter_pid:w.pid,wait_event:w.wait_event});return w;
 }
 close(){for(const child of this.children)child.kill('SIGTERM');}
}
