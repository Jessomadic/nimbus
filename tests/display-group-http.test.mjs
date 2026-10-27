import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';

test('real agent API stores display groups without changing hierarchy, capabilities or standing briefs',async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-display-http-')),data=path.join(directory,'data');
  const config=path.join(directory,'config.json');fs.writeFileSync(config,JSON.stringify({cloud:{enabled:false},local:{enabled:false,managed:{enabled:false}},browser:{enabled:false},mcpServers:{}}));
  const reserve=http.createServer();await new Promise(resolve=>reserve.listen(0,'127.0.0.1',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  const env={...process.env};for(const key of Object.keys(env))if(/^NIMBUS_/i.test(key)||/^(HOST|PORT)$/i.test(key))delete env[key];
  Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),NIMBUS_HTTPS_PORT:'0',NIMBUS_DATA:data,NIMBUS_CONFIG:config,NIMBUS_PASSWORD:randomBytes(32).toString('hex'),NIMBUS_ALLOWED_EMAILS:'',NIMBUS_USERNAME:''});
  const child=spawn(process.execPath,['--no-warnings','server.js'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',exited=false;const retain=b=>{output=(output+b.toString()).slice(-12000);};child.stdout.on('data',retain);child.stderr.on('data',retain);const exit=new Promise(resolve=>child.once('exit',()=>{exited=true;resolve();}));
  t.after(async()=>{if(!exited)child.kill('SIGTERM');await exit;assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.match(path.basename(directory),/^nimbus-display-http-/);fs.rmSync(directory,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port;let ready=false;
  for(let i=0;i<150;i++){if(exited)assert.fail('Fixture server exited: '+output);try{ready=(await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready,output);
  const headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
  const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return{status:r.status,ok:r.ok,value:await r.json()};};
  const architect=await api('/api/templates/architect/add','POST',{});assert.equal(architect.status,200);assert.equal(architect.value.display_group,'engineering');
  const created=await api('/api/bots','POST',{name:'Isolated grouped worker',role:'Metadata fixture',instructions:'Keep this exact standing instruction.',parent_bot_id:architect.value.id,template:'builder',tools:['read_file','ask_worker'],approval_rules:['shell(*git push*)'],allow_rules:['fixture-only']});assert.equal(created.status,200);assert.equal(created.value.display_group,'engineering');
  const before=created.value,brief=fs.readFileSync(path.join(data,'bots',String(before.id),'AGENTS.md'),'utf8');
  const patch=await api('/api/bots/'+before.id,'PATCH',{display_group:'operations'});assert.equal(patch.status,200);assert.equal(patch.value.display_group,'operations');
  const omit=({display_group,...rest})=>rest;assert.deepEqual(omit(patch.value),omit(before));assert.equal(fs.readFileSync(path.join(data,'bots',String(before.id),'AGENTS.md'),'utf8'),brief);
  const state=await api('/api/state');assert.equal(state.status,200);assert.equal(state.value.bots.find(b=>b.id===before.id).display_group,'operations');assert.equal(state.value.bots.find(b=>b.id===before.id).parent_bot_id,architect.value.id);
  for(const display_group of ['unknown-group','<script>',null,42,{id:'quality'}]){const invalid=await api('/api/bots/'+before.id,'PATCH',{display_group});assert.equal(invalid.ok,false,'Invalid display metadata must be rejected');}
  const after=await api('/api/state');assert.equal(after.value.bots.find(b=>b.id===before.id).display_group,'operations');
  const cleared=await api('/api/bots/'+before.id,'PATCH',{display_group:''});assert.equal(cleared.status,200);assert.equal(cleared.value.display_group,'');assert.deepEqual(omit(cleared.value),omit(before));
  const custom=await api('/api/bots','POST',{name:'Custom group fixture',display_group:'research'});assert.equal(custom.status,200);assert.equal(custom.value.display_group,'research');
});
