import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {spawn} from 'node:child_process';import {createHash,randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';import {DatabaseSync} from 'node:sqlite';
import {Maintenance} from '../runtime/maintenance.js';import {HandoffReservations} from '../runtime/handoff-reservations.js';import {handoffAuthority} from '../runtime/handoff-host.js';import {ProjectContinuation} from '../runtime/project-continuation.js';
import {artifactDirectory} from './helpers/artifact-directory.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)),sleep=ms=>new Promise(r=>setTimeout(r,ms)),sha=s=>createHash('sha256').update(s).digest('hex');
test('two actual isolated servers reserve via authenticated HTTP, confirm new boot, recover once without history and retain live instructions',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fe8-boot-http-')),data=path.join(dir,'data'),config=path.join(dir,'config.json');fs.writeFileSync(config,JSON.stringify({cloud:{enabled:false,codexBin:path.join(dir,'no-provider')},local:{enabled:false,managed:{enabled:false}},browser:{enabled:false},mcpServers:{}}));
 const env={};for(const k of ['PATH','Path','SYSTEMROOT','SystemRoot','SystemDrive','TEMP','TMP','COMSPEC','APPDATA','LOCALAPPDATA','PROGRAMFILES','USERPROFILE','HOME'])if(process.env[k])env[k]=process.env[k];
 Object.assign(env,{HOST:'127.0.0.1',NIMBUS_HTTPS_PORT:'0',NIMBUS_DATA:data,NIMBUS_CONFIG:config,NIMBUS_PASSWORD:randomUUID(),NIMBUS_ALLOWED_EMAILS:'',NIMBUS_USERNAME:''});
 const artifacts=artifactDirectory('handoff-boot-http');
 const children=[];let output='';t.after(async()=>{for(const c of children){if(c.exitCode===null){c.kill();await new Promise(r=>c.once('exit',r));}}fs.writeFileSync(path.join(artifacts,'boot-host-output.log'),output);assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});
 async function start(){
  const reserve=http.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
  const child=spawn(process.execPath,['--no-warnings','server.js'],{cwd:root,env:{...env,PORT:String(port)},windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const base='http://127.0.0.1:'+port;for(let i=0;i<240;i++){if(child.exitCode!==null)assert.fail(output);try{if((await fetch(base+'/health')).ok)break;}catch{}await sleep(50);}
  const headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
  async function api(route,body,extra={}){const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...headers,...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,value:await r.json()};}
  return {child,api,stop:async()=>{const done=new Promise(r=>child.once('exit',r));const r=await api('/api/admin/shutdown',{});assert.equal(r.status,200);await done;}};
 }
 const first=await start(),added=await first.api('/api/templates/orchestrator/add',{});assert.equal(added.status,200);const bot=added.value.id;
 let db=new DatabaseSync(path.join(data,'nimbus.db'));const q=s=>db.prepare(s);
 q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'paused','user',?)").run(bot,'bot:'+bot,'old task',JSON.stringify({messages:[{role:'user',content:'old context'}],steps:0}));
 const leader=q('SELECT max(id) id FROM runs').get().id;
 q('INSERT OR REPLACE INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(bot,'bot:'+bot,JSON.stringify([{role:'user',content:'PRIVATE-HISTORY-SENTINEL'.repeat(220455)}]));
 fs.mkdirSync(path.join(data,'shared'),{recursive:true});fs.writeFileSync(path.join(data,'shared','current.md'),'safe canonical checkpoint');
 assert.equal((await first.api('/api/runs/'+leader+'/continuation',{project:'http-fixture',checkpointRef:'shared/current.md',mode:'until_complete'})).status,200);
 const maintenance=new Maintenance({root,dataDir:data}),snapshot=maintenance.snapshot(),hash=maintenance.inventory().hash;
 // Synthetic validation receipt only in this temporary host. This test is not production validation.
 snapshot.state='validated';snapshot.validatedHash=hash;snapshot.candidate={hash};maintenance.save(snapshot);fs.writeFileSync(path.join(data,'supervisor.lock'),JSON.stringify({root:path.resolve(root),pid:process.pid}));
 const intent={reservationId:'http-reserve',successorRequestId:'http-stable',project:'http-fixture',leaderRunId:leader,checkpointRef:'shared/current.md',checkpointSha256:sha('safe canonical checkpoint'),taskSummary:'Read the checkpoint and continue only the synthetic task.',deployment:{snapshotId:snapshot.id,validatedHash:hash,oldPid:first.child.pid},continuationPolicy:'owner_armed',explicitAdoptionRequestIds:[]};
 assert.equal((await first.api('/api/project-successor-handoffs',intent,{'origin':'https://evil.invalid'})).status,403);
 const auth=await first.api('/api/project-successor-handoffs',intent);assert.equal(auth.status,200,JSON.stringify(auth));
 const continuation=new ProjectContinuation({db,query:q}),store=new HandoffReservations({db,dataDir:data,authority:handoffAuthority({query:q,continuation,maintenance,currentPid:()=>first.child.pid})});
 // The reserve helper executes in the test process, whose real parent differs
 // from the spawned server. Bind the synthetic lock to that actual parent only
 // for this synchronous reserve assertion, then restore the server parent lock.
 fs.writeFileSync(path.join(data,'supervisor.lock'),JSON.stringify({root:path.resolve(root),pid:process.ppid}));
 store.command({action:'reserve',reservationId:intent.reservationId,expectedCheckpointHash:intent.checkpointSha256},{runId:leader,botId:bot,requestKey:leader+':reserve'});
 fs.writeFileSync(path.join(data,'supervisor.lock'),JSON.stringify({root:path.resolve(root),pid:process.pid}));
 q("UPDATE runs SET status='done' WHERE id=?").run(leader);
 assert.equal(q('SELECT count(*) n FROM task_requests').get().n,0);
 assert.equal((await first.api('/api/tasks',{botId:bot,task:'cannot steal reservation key',requestId:'http-stable'})).status,409);
 db.close();await first.stop();
 snapshot.state='restart_pending';maintenance.save(snapshot);fs.writeFileSync(path.join(data,'updates','pending.json'),JSON.stringify({snapshotId:snapshot.id,sourceHash:hash,oldPid:first.child.pid}));
 const second=await start();let saved;
 for(let i=0;i<100;i++){db=new DatabaseSync(path.join(data,'nimbus.db'));saved=db.prepare('SELECT r.* FROM runs r JOIN task_requests t ON t.run_id=r.id WHERE t.request_key=?').get('http-stable');db.close();if(saved?.checkpoint&&!JSON.parse(saved.checkpoint).handoffInitialization&&saved.status!=='queued')break;await sleep(100);}
 assert.ok(saved,'boot activation did not create stable mapping: '+output);assert.equal(saved.source,'api');assert.equal(saved.parent_run,null);
 const state=JSON.parse(saved.checkpoint);assert.ok(state.instructions?.includes('Private working memory'));assert.equal(state.handoffInitialization,undefined);assert.ok(!saved.checkpoint.includes('PRIVATE-HISTORY-SENTINEL'));assert.equal(state.messages.filter(m=>m.role==='user').length,1);
 const applied=maintenance.status(snapshot.id);assert.equal(applied.snapshot.state,'applied');assert.equal(applied.snapshot.pid,second.child.pid);assert.equal(applied.pending,null);
 assert.equal((await second.api('/api/project-successor-handoffs/http-reserve')).value.successorRunId,saved.id);
 await second.stop();
});
