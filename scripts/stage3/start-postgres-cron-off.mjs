// Task-owned CLI launch adapter. No Docker/registry calls occur on import.
import assert from 'node:assert/strict';
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const pins=JSON.parse(readFileSync(new URL('./toolchain.json',import.meta.url))).database;
const tag=pins.images.postgres.tag;
const repository=tag.slice(0,tag.lastIndexOf(':'));
const allowedImages=[tag,repository+'@'+pins.images.postgres.digest,repository+'@'+pins.postgresChildDigest];
export function rewriteDatabaseCreate(args,database){
  assert.match(database,/^supabase_db_fairswap-ci-[a-f0-9]{20}$/);
  const result=[...args];
  const targetNamed=args.some((a,i)=>(a==='--name'&&args[i+1]===database)||a==='--name='+database);
  if(args[0]!=='create'){
    // Never permit an unrecognized Docker verb to launch the owned database.
    assert.ok(!targetNamed);
    return {args:result,changed:false};
  }
  // Bootstrap jobs may legitimately reference the DB hostname in other arguments.
  if(!targetNamed)return {args:result,changed:false};
  const name=args.indexOf('--name');
  assert.ok(name>0&&args[name+1]===database);
  const options=args.slice(1,-3);
  assert.equal(options.filter(a=>a==='--name').length,1);
  assert.equal(options.filter(a=>a==='--entrypoint').length,1);
  assert.ok(!options.some(a=>a.startsWith('--name=')||a.startsWith('--entrypoint=')||a.startsWith('--label-file')||a.startsWith('-l')));
  assert.equal(options[options.indexOf('--entrypoint')+1],'sh');
  const project=database.slice('supabase_db_'.length);
  const labels=[];
  for(let i=0;i<options.length;i++){
    if(options[i]==='--label'){assert.ok(options[i+1]);labels.push(options[++i])}
    else if(options[i].startsWith('--label='))labels.push(options[i].slice(8));
  }
  for(const key of ['com.supabase.cli.project','com.docker.compose.project']){
    const values=labels.filter(l=>l.startsWith(key+'='));
    assert.deepEqual(values,[key+'='+project]);
  }
  assert.ok(allowedImages.includes(args.at(-3)));
  assert.equal(args.at(-2),'-c');
  const script=args.at(-1);
  const line='exec docker-entrypoint.sh postgres -D /etc/postgresql \n';
  assert.equal(script.split(line).length,2);
  assert.ok(script.includes("cat <<'EOF' > /etc/postgresql.schema.sql"));
  assert.ok(script.includes("cat <<'EOF' >> /etc/postgresql/postgresql.conf"));
  assert.ok(!script.includes('/etc/backup.sql'));
  assert.equal((script.match(/^exec docker-entrypoint\.sh /gm)||[]).length,1);
  result[result.length-1]=script.replace(line,line.replace(' \n',' -c cron.launch_active_jobs=off\n'));
  return {args:result,changed:true};
}
function taskContext(realDocker,marker,env){
  assert.ok(path.isAbsolute(realDocker)&&path.isAbsolute(marker));
  assert.equal(path.basename(marker),'startup-override.json');
  const raw=path.dirname(marker),task=path.dirname(raw);
  assert.equal(path.basename(raw),'raw');
  assert.match(path.basename(task),/^fairswap-stage3-ci\.[A-Za-z0-9]{6,16}$/);
  assert.equal(realpathSync(task),task);
  assert.equal(realpathSync(raw),raw);
  assert.ok(lstatSync(raw).isDirectory()&&!lstatSync(raw).isSymbolicLink());
  assert.equal(env.FAIRSWAP_DB_CLEAN_ENV,'1');
  assert.equal(realpathSync(env.FAIRSWAP_DB_TASK),task);
  assert.match(env.FAIRSWAP_DB_OWNER,/^[a-f0-9-]{36}$/);
  assert.equal(readFileSync(path.join(task,'owner'),'utf8').trim(),env.FAIRSWAP_DB_OWNER);
  assert.ok(!realDocker.startsWith(task+path.sep));
  return raw;
}
export function runDocker(realDocker,database,marker,args,{run=spawnSync,env=process.env}={}){
  const raw=taskContext(realDocker,marker,env);
  const transformed=rewriteDatabaseCreate(args,database);
  if(transformed.changed){
    assert.ok(!existsSync(marker));
    const image=JSON.parse(readFileSync(path.join(raw,'images.json'))).postgres;
    assert.equal(image.tag,tag);assert.equal(image.digest,pins.images.postgres.digest);
    assert.equal(image.platform,'linux/amd64');assert.match(image.imageId,/^sha256:[a-f0-9]{64}$/);
    const inspect=run(realDocker,['image','inspect','-f','{{.Id}}',args.at(-3)],{encoding:'utf8',stdio:['inherit','pipe','pipe']});
    assert.ok(!inspect.error&&!inspect.signal&&inspect.status===0);
    assert.equal(inspect.stdout.trim(),image.imageId);
  }
  const r=run(realDocker,transformed.args,{stdio:'inherit'});
  if(r.error||r.signal||!Number.isInteger(r.status)||r.status!==0)return r.status>0?r.status:1;
  if(transformed.changed)writeFileSync(marker,'{"serverCronOff":true}\n',{flag:'wx',mode:0o600});
  return 0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const [realDocker,database,marker,...args]=process.argv.slice(2);process.exitCode=runDocker(realDocker,database,marker,args)}
  catch{console.error('FAIL: task PostgreSQL startup adapter rejected; raw output withheld');process.exitCode=1}
}
