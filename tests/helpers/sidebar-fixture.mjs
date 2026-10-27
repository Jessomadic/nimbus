import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';

export const repository=path.resolve(fileURLToPath(new URL('../../',import.meta.url)));
export async function sidebarFixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-sidebar-')),data=path.join(directory,'data'),config=path.join(directory,'config.json');
  fs.writeFileSync(config,JSON.stringify({cloud:{enabled:false},local:{enabled:false,managed:{enabled:false}},browser:{enabled:false},mcpServers:{}}));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const env={...process.env};for(const key of Object.keys(env))if(/^NIMBUS_/i.test(key)||/^(HOST|PORT|NODE_TEST_CONTEXT)$/i.test(key))delete env[key];
  Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),NIMBUS_HTTPS_PORT:'0',NIMBUS_DATA:data,NIMBUS_CONFIG:config,NIMBUS_PASSWORD:randomBytes(32).toString('hex'),NIMBUS_USERNAME:'',NIMBUS_ALLOWED_EMAILS:''});
  const child=spawn(process.execPath,['--no-warnings','server.js'],{cwd:repository,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',exited=false;child.stdout.on('data',b=>{output=(output+b).slice(-10000);});child.stderr.on('data',b=>{output=(output+b).slice(-10000);});const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  t.after(async()=>{if(!exited)child.kill('SIGTERM');await exit;assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^nimbus-sidebar-/);fs.rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;let ready=false;
  for(let attempt=0;attempt<200;attempt++){if(exited)assert.fail(output);try{ready=(await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,output);
  const headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return{status:response.status,value:await response.json()};};
  const add=async(name,template,group,parent)=>{const r=await api('/api/bots','POST',{name,template,display_group:group,parent_bot_id:parent??null,tools:['read_file'],instructions:'Preserve this exact private instruction.',approval_rules:['fixture-review'],allow_rules:['fixture-allow']});assert.equal(r.status,200,JSON.stringify(r.value));return r.value;};
  const root=await add('Orchestrator','orchestrator',''),builder=await add('Builder','builder','engineering',root.id),architect=await add('Architect','architect','engineering',root.id),qa=await add('QA Engineer','qa-engineer','quality',root.id),researcher=await add('Researcher','researcher','research',root.id),operator=await add('Windows Operator','windows-operator','operations',root.id),github=await add('GitHub','github-coordinator','github',root.id),sync=await add('GitHub Sync','github-sync','github',github.id);
  const database=fn=>{const db=new DatabaseSync(path.join(data,'nimbus.db'));try{db.exec('PRAGMA busy_timeout=5000');return fn(db);}finally{db.close();}};
  const snapshot=()=>database(db=>({bots:db.prepare('SELECT * FROM bots ORDER BY id').all().map(({display_group,...row})=>row),runs:db.prepare('SELECT * FROM runs ORDER BY id').all(),history:db.prepare('SELECT * FROM worker_history ORDER BY bot_id,thread').all(),events:db.prepare('SELECT * FROM task_events ORDER BY id').all(),members:db.prepare('SELECT * FROM room_members ORDER BY room_id,bot_id').all(),briefs:Object.fromEntries([root,builder,architect,qa,researcher,operator,github,sync].map(bot=>[bot.id,fs.readFileSync(path.join(data,'bots',String(bot.id),'AGENTS.md'),'utf8')]))}));
  return{base,data,api,add,database,snapshot,bots:{root,builder,architect,qa,researcher,operator,github,sync}};
}
