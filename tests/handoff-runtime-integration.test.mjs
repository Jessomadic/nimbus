import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {createHash,randomUUID} from 'node:crypto';
import {HandoffReservations} from '../runtime/handoff-reservations.js';import {handoffRuntime} from '../runtime/handoff-runtime.js';import {ProjectContinuation} from '../runtime/project-continuation.js';import {ProjectLifecycleOwnership} from '../runtime/project-lifecycle.js';import {Maintenance} from '../runtime/maintenance.js';import {rejectionWake} from '../runtime/rejection-wake.js';
const sha=s=>createHash('sha256').update(s).digest('hex');
function fixture(t,{adopt=false,queueCrash=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fe8-wiring-')),root=path.join(dir,'source'),data=path.join(dir,'data');fs.mkdirSync(root);fs.mkdirSync(path.join(data,'shared'),{recursive:true});fs.writeFileSync(path.join(root,'app.js'),'// synthetic isolated source');fs.writeFileSync(path.join(data,'shared','current.md'),'canonical');
 const db=new DatabaseSync(path.join(data,'fixture.db'));t.after(()=>{db.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});});const q=s=>db.prepare(s);
 db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT);INSERT INTO bots VALUES(22,'orchestrator');
 CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,prompt TEXT,status TEXT,parent_run INTEGER,source TEXT,quiet INTEGER,depth INTEGER,origin_message_id INTEGER,origin_request_id TEXT,checkpoint TEXT,last_error TEXT,ended_at INTEGER);
 CREATE TABLE task_requests(request_key TEXT PRIMARY KEY,fingerprint TEXT,run_id INTEGER);
 CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT);
 CREATE TABLE approvals(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);
 CREATE TABLE worker_history(bot_id INTEGER,thread TEXT,messages TEXT);
 CREATE TABLE tool_development_requests(id TEXT PRIMARY KEY,requester_run_id INTEGER,fingerprint TEXT,status TEXT);
 CREATE TABLE tool_development_stages(request_id TEXT,run_id INTEGER,artifact_hash TEXT,receipt_json TEXT);
 CREATE TABLE tool_development_watchers(request_id TEXT,run_id INTEGER,bot_id INTEGER,thread TEXT,consumer INTEGER,cancelled INTEGER,PRIMARY KEY(request_id,run_id));
 INSERT INTO runs(id,bot_id,thread,prompt,status,source,checkpoint) VALUES(1,22,'bot:22','original','paused','user','{"messages":[]}');
 INSERT INTO worker_history VALUES(22,'bot:22','${'history-sentinel'.repeat(323334)}');`);
 const continuation=new ProjectContinuation({db,query:q,resume:()=>assert.fail('no resume'),owned:new Set(),event:()=>{}});continuation.arm(1,{project:'fixture',checkpointRef:'shared/current.md',mode:'until_complete'});
 const events=[],lifecycle=new ProjectLifecycleOwnership({db,query:q,continuation,event:(...args)=>events.push(args)});
 const maintenance=new Maintenance({root,dataDir:data}),snapshot=maintenance.snapshot(),hash=maintenance.inventory().hash;
 snapshot.state='validated';snapshot.validatedHash=hash;snapshot.candidate={hash};maintenance.save(snapshot);
 // Real Maintenance boot transition against an isolated lock and receipt.
 fs.writeFileSync(path.join(data,'supervisor.lock'),JSON.stringify({root,pid:process.ppid}));
 fs.writeFileSync(path.join(data,'updates','pending.json'),JSON.stringify({snapshotId:snapshot.id,sourceHash:hash,oldPid:999999}));
 const intent={reservationId:'reserve',successorRequestId:'stable',project:'fixture',leaderRunId:1,checkpointRef:'shared/current.md',checkpointSha256:sha('canonical'),relatedArtifactPins:[],taskSummary:'Continue exact project',deployment:{snapshotId:snapshot.id,validatedHash:hash,oldPid:999999},continuationPolicy:'owner_armed',explicitAdoptionRequestIds:adopt?['request']:[],reason:'Explicit successor'};
 const store=new HandoffReservations({db,dataDir:data,authority:()=>({leader:{id:1,bot_id:22,parent_run:null,template:'orchestrator',status:'paused'},project:'fixture',ownerArmed:true})}),principal={kind:'named-owner',id:'owner'};
 store.authorize(intent,principal);store.command({action:'reserve',reservationId:'reserve',expectedCheckpointHash:intent.checkpointSha256},{runId:1,botId:22,requestKey:'1:reserve'});
 if(adopt)q('INSERT INTO tool_development_requests VALUES(?,?,?,?)').run('request',1,'request-fp','blocked');
 let authorized=true,clear=true,crash=queueCrash;const queued=[];
 const options={db,store,continuation,lifecycle,maintenance,bootHash:()=>hash,principalCurrent:()=>authorized,sourceClear:()=>clear,enqueue:id=>{assert.equal(db.isTransaction,false);if(crash)throw Error('postcommit crash');queued.push(id);},event:(...args)=>{assert.equal(db.isTransaction,false);events.push(args);}};
 const runtime=handoffRuntime(options);
 return {db,q,data,store,intent,continuation,lifecycle,maintenance,runtime,options,queued,events,hash,boot:()=>maintenance.confirmBoot(hash),revoke:()=>authorized=false,hold:()=>clear=false,uncrash:()=>crash=false};
}
test('real temp DB boot transition -> atomic checkpoint/continuation/adoption -> postcommit queue, replay and fresh instructions',t=>{
 const f=fixture(t,{adopt:true});assert.ok(f.runtime.reconcile()[0].held);assert.equal(f.q('SELECT count(*) n FROM task_requests').get().n,0);
 f.boot();assert.equal(f.maintenance.status(f.intent.deployment.snapshotId).snapshot.state,'applied');
 const r=f.runtime.reconcile()[0],id=r.successorRunId;assert.ok(id);assert.equal(f.lifecycle.get('request').leader_run_id,id);assert.equal(f.continuation.requireUntilComplete(id,'fixture').remaining,-1);assert.equal(f.events.length,1);
 const run=f.q('SELECT * FROM runs WHERE id=?').get(id);assert.equal(run.source,'api');assert.equal(run.parent_run,null);assert.ok(run.prompt.includes('archiveRef'));assert.ok(run.prompt.length<32768);
 let state=JSON.parse(run.checkpoint);assert.equal(state.messages.length,1);assert.ok(!run.checkpoint.includes('history-sentinel'));state=f.runtime.initialize(id,state,'CURRENT AGENTS + PRIVATE MEMORY');assert.equal(state.instructions,'CURRENT AGENTS + PRIVATE MEMORY');assert.equal(f.runtime.initialize(id,state,'CHANGED'),state);assert.equal(state.instructions,'CURRENT AGENTS + PRIVATE MEMORY');
 assert.equal(f.runtime.reconcile()[0].successorRunId,id);assert.equal(f.events.length,1);assert.equal(f.q('SELECT count(*) n FROM task_requests').get().n,1);
 assert.ok(f.runtime.holds(1));assert.ok(f.runtime.holds(id));
 f.continuation.stop(id);assert.throws(()=>f.runtime.gate(id),/stopped/);
});
test('adoption failure rolls back run mapping checkpoint continuation binding and events',t=>{
 const f=fixture(t,{adopt:true});f.boot();
 f.q("INSERT INTO runs(id,bot_id,thread,prompt,status,source,checkpoint) VALUES(10,22,'bot:22','other','paused','user','{\"messages\":[]}')").run();
 f.continuation.arm(10,{project:'fixture',checkpointRef:'shared/current.md',mode:'until_complete'});
 f.lifecycle.adopt('request',{leaderRunId:10,project:'fixture',reason:'other active owner'},{authenticated:true,principal:'owner'});f.events.length=0;
 const r=f.runtime.reconcile()[0];assert.ok(r.held);assert.match(r.code,/Another active/);
 for(const table of ['task_requests','project_handoff_bindings'])assert.equal(f.q('SELECT count(*) n FROM '+table).get().n,0);
 assert.equal(f.q('SELECT count(*) n FROM runs').get().n,2);assert.equal(f.events.length,0);
});
test('postcommit crash reconciles same mapping; revoked owner, source hold, stop, uncertainty and pin mutation never release it',t=>{
 const f=fixture(t,{queueCrash:true});f.boot();assert.ok(f.runtime.reconcile()[0].held);const id=f.store.row('reserve').successor_run_id;assert.ok(id);f.uncrash();assert.equal(f.runtime.reconcile()[0].successorRunId,id);
 f.q("INSERT INTO tool_calls VALUES('unknown',1,'shell','uncertain')").run();assert.throws(()=>f.runtime.gate(id),/effect_gate/);f.q('DELETE FROM tool_calls').run();
 fs.writeFileSync(path.join(f.data,'shared/current.md'),'mutated');assert.throws(()=>f.runtime.gate(id),/checkpoint_changed/);fs.writeFileSync(path.join(f.data,'shared/current.md'),'canonical');
 f.revoke();assert.throws(()=>f.runtime.gate(id),/owner_revoked/);assert.equal(f.q('SELECT count(*) n FROM task_requests').get().n,1);
});
test('diagnostic receipt fingerprint is once only, transactional, manual pause safe and stop-safe at execution',t=>{
 const f=fixture(t,{adopt:true});f.boot();const id=f.runtime.reconcile()[0].successorRunId;
 f.q("UPDATE runs SET status='paused',checkpoint=? WHERE id=?").run(JSON.stringify({messages:[{role:'user',content:'original'}],steps:0,awaitingToolRequest:'request',toolDiagnosticPause:'request'}),id);
 f.q("INSERT INTO runs(id,bot_id,status,checkpoint) VALUES(30,22,'done','{\"messages\":[]}')").run();
 f.q("INSERT INTO tool_development_stages VALUES('request',30,?,?)").run('b'.repeat(64),JSON.stringify({sourceHash:f.hash}));
 const queue=[],wake=rejectionWake({db:f.db,lifecycle:f.lifecycle,continuation:f.continuation,sourceClear:()=>true,sourceHash:()=>f.hash,enqueue:run=>{assert.equal(f.db.isTransaction,false);queue.push(run);}});
 const request=f.q("SELECT * FROM tool_development_requests WHERE id='request'").get(),receipt={approved:false,failureKind:'implementation',sourceHash:f.hash,findings:['missing wiring'],reasonCode:'implementation'};
 for(let i=0;i<3;i++)wake.record(request,{phase:'building',run_id:30},receipt,'b'.repeat(64));
 assert.equal(f.q('SELECT count(*) n FROM tool_rejection_diagnostics').get().n,1);
 let state=JSON.parse(f.q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint);delete state.toolDiagnosticPause;f.q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(state),id);wake.pump();assert.equal(queue.length,0);
 state.toolDiagnosticPause='request';f.q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(state),id);wake.pump();wake.pump();assert.deepEqual(queue,[id]);
 state=JSON.parse(f.q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint);assert.equal(state.messages.length,2);assert.equal(state.awaitingToolRequest,undefined);assert.equal(wake.gate(id),true);f.continuation.stop(id);assert.throws(()=>wake.gate(id));
});

test('post-enqueue policy matrix: source hold, durable stop, noProgress, denied approval and later PID all withhold',t=>{
 for(const gate of ['source','stop','noProgress','denied','pid']){
  const f=fixture(t,{adopt:true});f.boot();const id=f.runtime.reconcile()[0].successorRunId;assert.ok(id,gate);
  if(gate==='source')f.hold();
  if(gate==='stop')f.continuation.stop(1);
  if(gate==='noProgress')f.q('UPDATE runs SET checkpoint=? WHERE id=1').run(JSON.stringify({messages:[],noProgress:{reason:'repeat'}}));
  if(gate==='denied')f.q("INSERT INTO approvals VALUES(1,1,'denied')").run();
  if(gate==='pid'){const r=f.maintenance.load(f.intent.deployment.snapshotId);r.pid=process.pid+1;f.maintenance.save(r);}
  assert.throws(()=>f.runtime.gate(id),undefined,gate);
  assert.equal(f.q('SELECT count(*) n FROM task_requests').get().n,1);
 }
});
