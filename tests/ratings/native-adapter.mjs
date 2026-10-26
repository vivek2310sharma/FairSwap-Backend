// Fixed-loopback psql adapter for automated fixtures; never accepts a DB URL.
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const psql='C:/Program Files/PostgreSQL/17/bin/psql.exe';
export class NativeDatabase {
 constructor(port){if(!/^\d{5}$/.test(port)||+port<49152||+port>65535)throw new Error('Disposable port required');this.port=port;this.role='ratings_fixture_admin';this.user='';this.aal='aal1';this.policy='true';}
 literal(x){if(x===null)return 'null';if(typeof x==='number')return String(x);if(Array.isArray(x))return `array[${x.map(y=>this.literal(y)).join(',')}]::text[]`;return `E'${String(x).replaceAll('\\','\\\\').replaceAll("'","''")}'`;}
 prefix(){return `set role ${this.role};select set_config('request.user',${this.literal(this.user)},false),set_config('request.aal',${this.literal(this.aal)},false),set_config('test.policy',${this.literal(this.policy)},false);`;}
 args(file){return ['-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',this.port,'-U','ratings_fixture_admin','-d','postgres','-f',file];}
 process(sql,async=false){
  const dir=mkdtempSync(join(tmpdir(),'ratings-sql-'));const file=join(dir,'fixture.sql');
  // Prefix's set_config result must not enter the JSON result stream.
  writeFileSync(file,`\\o NUL\n${this.prefix()}\n\\o\n${sql}`);
  const cleanup=()=>rmSync(dir,{recursive:true,force:true});
  const result=(status,stdout,stderr)=>{if(status!==0){const e=new Error(stderr.trim());e.code='PSQL_ERROR';throw e;}return stdout.trim();};
  const env={SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,PGCONNECT_TIMEOUT:'5',PGCLIENTENCODING:'UTF8'};
  if(async)return new Promise((resolve,reject)=>{const child=spawn(psql,this.args(file),{env,windowsHide:true});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.on('error',e=>{cleanup();reject(e);});child.on('close',status=>{cleanup();try{resolve(result(status,out,err));}catch(e){reject(e);}});});
  try{const r=spawnSync(psql,this.args(file),{env,windowsHide:true,encoding:'utf8',maxBuffer:8*1024*1024});if(r.error)throw r.error;return result(r.status,r.stdout,r.stderr);}finally{cleanup();}
 }
 async exec(sql){
  this.process(sql);
  for(const m of sql.matchAll(/(?:set role (\w+)|reset role)/gi))this.role=m[1]??'ratings_fixture_admin';
  const policy=sql.match(/set_config\('test.policy','(true|false)'/);if(policy)this.policy=policy[1];
 }
 async query(sql,args=[],async=false){
  if(sql.startsWith("select set_config('request.user'")){this.user=args[0];this.aal=args[1]??'aal1';return {rows:[]};}
  const bound=sql.replace(/\$(\d+)\b/g,(_,n)=>this.literal(args[+n-1]));
  let statement;
  if(/^\s*select/i.test(bound))statement=`select coalesce(json_agg(row_to_json(x)),'[]'::json) from (${bound}) x;`;
  else if(/returning/i.test(bound))statement=`with x as (${bound}) select coalesce(json_agg(row_to_json(x)),'[]'::json) from x;`;
  else {this.process(bound);return {rows:[]};}
  const out=await this.process(statement,async);return {rows:JSON.parse(out)};
 }
 async close(){}
}
