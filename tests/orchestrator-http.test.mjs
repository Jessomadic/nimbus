import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';

const repository=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-orchestrator-http-')),data=path.join(directory,'data'),config=path.join(directory,'config.json');
  const forbiddenProvider=path.join(directory,'not-installed-no-provider-process');
  fs.writeFileSync(config,JSON.stringify({cloud:{enabled:false,codexBin:forbiddenProvider},local:{enabled:false,managed:{enabled:false}},browser:{enabled:false},mcpServers:{}}));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  // Do not inherit provider credentials, Codex test context, or any Nimbus .env.
  const env={};for(const key of ['PATH','Path','SYSTEMROOT','SystemRoot','SystemDrive','TEMP','TMP','COMSPEC','APPDATA','LOCALAPPDATA','PROGRAMFILES','USERPROFILE','HOME'])if(process.env[key])env[key]=process.env[key];
  Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),NIMBUS_HTTPS_PORT:'0',NIMBUS_DATA:data,NIMBUS_CONFIG:config,NIMBUS_PASSWORD:randomBytes(32).toString('hex'),NIMBUS_ALLOWED_EMAILS:'',NIMBUS_USERNAME:''});
  const child=spawn(process.execPath,['--no-warnings','server.js'],{cwd:repository,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',exited=false;
  const retain=value=>{output=(output+value.toString()).slice(-12000);};child.stdout.on('data',retain);child.stderr.on('data',retain);
  const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  t.after(async()=>{
    if(!exited){child.kill('SIGTERM');let timeout;await Promise.race([exit,new Promise(resolve=>{timeout=setTimeout(resolve,10000);})]);clearTimeout(timeout);if(!exited)child.kill('SIGKILL');}
    await exit;const absolute=path.resolve(directory);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^nimbus-orchestrator-http-/);fs.rmSync(absolute,{recursive:true,force:true});
  });
  const base='http://127.0.0.1:'+port;let ready=false;
  for(let attempt=0;attempt<200;attempt++){if(exited)assert.fail('Isolated server exited: '+output);try{ready=(await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await sleep(50);}assert.ok(ready,'Isolated server did not become ready: '+output);
  const headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return{status:response.status,ok:response.ok,value:await response.json()};};
  const database=fn=>{const db=new DatabaseSync(path.join(data,'nimbus.db'));try{db.exec('PRAGMA busy_timeout=5000');return fn(db);}finally{db.close();}};
  const cli=async(...args)=>{
    const command=spawn(process.execPath,['--no-warnings',path.join(repository,'bin','setup-orchestrator.mjs'),...args],{cwd:repository,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';command.stdout.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(-200000);});command.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
    const code=await new Promise((resolve,reject)=>{command.once('error',reject);command.once('close',resolve);});let value;try{value=JSON.parse(stdout.trim());}catch{}return{code,value,stdout,stderr};
  };
  return{directory,data,config,env,api,database,cli};
}
async function addRoot(api){const result=await api('/api/templates/orchestrator/add','POST',{});assert.equal(result.status,200,JSON.stringify(result.value));assert.equal(result.value.template,'orchestrator');assert.equal(result.value.parent_bot_id,null);return result.value;}
async function addWorker(api,extra={}){const result=await api('/api/bots','POST',{name:'Synthetic worker '+randomUUID().slice(0,8),tools:['read_file'],approval_rules:[],model:'local',...extra});assert.equal(result.status,200,JSON.stringify(result.value));return result.value;}
function runId(result){assert.equal(result.status,202,JSON.stringify(result.value));assert.ok(Number.isSafeInteger(result.value.runId));return result.value.runId;}
function savedRun(database,id){return database(db=>db.prepare('SELECT id,bot_id,thread,source,prompt,origin_request_id FROM runs WHERE id=?').get(id));}
const preserve=bot=>Object.fromEntries(['id','name','role','instructions','tools','approval_rules','allow_rules','model','default_model','effort','template','color','shape','display_group'].map(key=>[key,bot[key]]));

test('Orchestrator entrypoint reports unconfigured bridge and refuses missing default/canonical dispatch without selecting another worker',async t=>{
  const {api,database}=await fixture(t);await addWorker(api,{name:'Unrelated available worker'});
  const metadata=await api('/api/orchestrator');assert.equal(metadata.status,200);assert.equal(metadata.value.configured,false);assert.equal(metadata.value.orchestrator,null);assert.equal(metadata.value.taskEndpoint,'/api/orchestrator/tasks');assert.equal(metadata.value.bridge.connected,false);assert.equal(metadata.value.bridge.status,'not_configured');
  for(const route of ['/api/tasks','/api/orchestrator/tasks']){const missing=await api(route,'POST',{task:'Synthetic root-routing check',requestId:randomUUID()});assert.equal(missing.status,404);assert.match(missing.value.error,/Orchestrator|coordinator/i);}
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),0);
});

test('default task submission selects the unique Orchestrator while explicit worker selectors retain direct routing',async t=>{
  const {api,database}=await fixture(t),root=await addRoot(api),worker=await addWorker(api,{name:'Explicit routing fixture'});
  const implicit=await api('/api/tasks','POST',{task:'Route to the default coordinator without inference.',requestId:'default-'+randomUUID()});assert.equal(savedRun(database,runId(implicit)).bot_id,root.id);
  const explicit=await api('/api/tasks','POST',{botId:worker.id,worker:worker.name,task:'Direct worker routing remains available.',requestId:'direct-'+randomUUID()});assert.equal(savedRun(database,runId(explicit)).bot_id,worker.id);
  const before=database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n);
  const mismatch=await api('/api/tasks','POST',{botId:worker.id,worker:root.name,task:'Conflicting selectors must not dispatch.'});assert.equal(mismatch.status,409);
  for(const selector of [{botId:0},{botId:'not-an-id'},{worker:{name:worker.name}}]){const malformed=await api('/api/tasks','POST',{...selector,task:'Malformed selector must not dispatch.'});assert.equal(malformed.status,400);}
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),before);
});

test('canonical Hermes/Lumos frontdoor preserves source, opaque owning-task context and idempotency without claiming a connected bridge',async t=>{
  const {api,database}=await fixture(t),root=await addRoot(api),worker=await addWorker(api);
  const metadata=await api('/api/orchestrator');assert.equal(metadata.status,200);assert.equal(metadata.value.configured,true);assert.equal(metadata.value.orchestrator.id,root.id);assert.equal(metadata.value.bridge.connected,false);
  for(const source of ['lumos','hermes']){
    const context={owningTaskId:source+'-opaque-task-02',requestId:source+'-opaque-request-03',purpose:'Synthetic correlation only'},requestId=source+'-'+randomUUID(),payload={task:'Synthetic accepted task; no external inference is enabled.',source,context,files:[],requestId};
    const accepted=await api('/api/orchestrator/tasks','POST',payload),id=runId(accepted),saved=savedRun(database,id);assert.equal(saved.bot_id,root.id);assert.equal(saved.thread,'bot:'+root.id);assert.equal(saved.source,source);assert.equal(saved.origin_request_id,requestId);assert.ok(saved.prompt.includes(JSON.stringify(context)));
    const before=database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),replayed=await api('/api/orchestrator/tasks','POST',payload);assert.equal(replayed.status,200);assert.equal(replayed.value.replayed,true);assert.equal(replayed.value.runId??replayed.value.id,id);assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),before);
    const changed=await api('/api/orchestrator/tasks','POST',{...payload,task:'A changed task must conflict.'});assert.equal(changed.status,409);
  }
  const before=database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n);
  for(const extra of [{worker:worker.name},{botId:worker.id},{thread:'bot:'+worker.id},{source:'email'}]){const invalid=await api('/api/orchestrator/tasks','POST',{task:'Invalid canonical redirect fixture.',requestId:randomUUID(),...extra});assert.equal(invalid.status,400);}
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),before);
});

test('legacy duplicate Orchestrator records cause clear conflicts and never dispatch to an arbitrary root',async t=>{
  const {api,database,cli}=await fixture(t);await addRoot(api);
  database(db=>db.prepare('INSERT INTO bots(name,template,parent_bot_id) VALUES (?,?,NULL)').run('Legacy duplicate fixture','orchestrator'));
  const metadata=await api('/api/orchestrator');assert.equal(metadata.status,409);assert.match(metadata.value.error,/multiple|duplicate|ambiguous/i);
  for(const route of ['/api/tasks','/api/orchestrator/tasks']){const conflict=await api(route,'POST',{task:'Ambiguous root must not be selected.',requestId:randomUUID()});assert.equal(conflict.status,409);}
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),0);
  const before=(await api('/api/state')).value.bots,setup=await cli('--apply');assert.notEqual(setup.code,0);assert.match(setup.stderr+setup.stdout,/multiple|duplicate|ambiguous/i);assert.deepEqual((await api('/api/state')).value.bots,before);
});

test('new agents default under the root while explicit parents and the GitHub subtree remain intact',async t=>{
  const {api}=await fixture(t),root=await addRoot(api),child=await addWorker(api),independent=await addWorker(api,{parent_bot_id:null});
  assert.equal(child.parent_bot_id,root.id);assert.equal(independent.parent_bot_id,null);
  const nested=await addWorker(api,{parent_bot_id:child.id});assert.equal(nested.parent_bot_id,child.id);
  const builder=await api('/api/templates/builder/add','POST',{});assert.equal(builder.status,200);assert.equal(builder.value.parent_bot_id,root.id);
  const github=await api('/api/templates/github-coordinator/add','POST',{});assert.equal(github.status,200);assert.equal(github.value.parent_bot_id,root.id);
  const sync=await api('/api/templates/github-sync/add','POST',{});assert.equal(sync.status,200);assert.equal(sync.value.parent_bot_id,github.value.id);
  const parentedRoot=await api('/api/bots/'+root.id,'PATCH',{parent_bot_id:child.id});assert.equal(parentedRoot.status,400);
  const duplicate=await api('/api/templates/orchestrator/add','POST',{});assert.equal(duplicate.status,409);
  const stale=await api('/api/bots/'+child.id,'PATCH',{parent_bot_id:independent.id,expected_parent_bot_id:null});assert.equal(stale.status,409);
  const current=await api('/api/state');assert.equal(current.value.bots.find(bot=>bot.id===root.id).parent_bot_id,null);assert.equal(current.value.bots.find(bot=>bot.id===child.id).parent_bot_id,root.id);assert.equal(current.value.bots.find(bot=>bot.id===sync.value.id).parent_bot_id,github.value.id);
});

test('setup CLI dry-run/apply is idempotent and preserves existing worker settings and non-null parent links',async t=>{
  const {api,cli}=await fixture(t);
  const parent=await addWorker(api,{name:'Existing parent fixture',role:'Keep this role',instructions:'Preserve the exact original instructions.',tools:['read_file','ask_worker'],approval_rules:['shell(*git push*)'],allow_rules:['read_file'],model:'luna',default_model:'terra',effort:'high',display_group:'research'});
  const child=await addWorker(api,{name:'Existing child fixture',parent_bot_id:parent.id,instructions:'Keep child instructions.',tools:['read_file'],model:'local',default_model:'luna',approval_rules:['read_file(*)'],allow_rules:[]});
  const github=await api('/api/templates/github-coordinator/add','POST',{}),sync=await api('/api/templates/github-sync/add','POST',{});assert.equal(github.status,200);assert.equal(sync.status,200);assert.equal(sync.value.parent_bot_id,github.value.id);
  const before=(await api('/api/state')).value.bots,dry=await cli();assert.equal(dry.code,0,dry.stderr);assert.equal(dry.value.apply,false);assert.deepEqual((await api('/api/state')).value.bots,before);
  const first=await cli('--apply');assert.equal(first.code,0,first.stderr||first.stdout);
  const state=(await api('/api/state')).value.bots,roots=state.filter(bot=>bot.template==='orchestrator');assert.equal(roots.length,1);const root=roots[0];assert.equal(root.parent_bot_id,null);
  for(const original of before){const current=state.find(bot=>bot.id===original.id);assert.deepEqual(preserve(current),preserve(original));assert.equal(current.parent_bot_id,original.parent_bot_id??root.id);}
  assert.equal(state.find(bot=>bot.id===child.id).parent_bot_id,parent.id);assert.equal(state.find(bot=>bot.id===sync.value.id).parent_bot_id,github.value.id);
  const customized=await api('/api/bots/'+root.id,'PATCH',{instructions:'Keep customized coordinator instructions.',tools:['read_file','ask_worker'],approval_rules:['shell(*)'],allow_rules:['read_file'],model:'luna',default_model:'terra',effort:'low'});assert.equal(customized.status,200);
  const stable=(await api('/api/state')).value.bots,second=await cli('--apply');assert.equal(second.code,0,second.stderr||second.stdout);
  const repeated=(await api('/api/state')).value.bots;assert.equal(repeated.filter(bot=>bot.template==='orchestrator').length,1);assert.equal(repeated.length,stable.length);
  for(const original of stable){const current=repeated.find(bot=>bot.id===original.id);assert.deepEqual(preserve(current),preserve(original));assert.equal(current.parent_bot_id,original.parent_bot_id);}
});
