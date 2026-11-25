import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ToolDevelopment} from '../runtime/tool-development.js';

const baseline='b'.repeat(64),candidate='a'.repeat(64);
const spec=name=>({type:'function',function:{name,description:'Fixture tool',parameters:{type:'object',properties:{},required:[],additionalProperties:false}}});
function automaticRecovery(state,{continuations=2,repairs=2}={}){
  state.service.recoveryPolicy=()=>({maxAutomaticContinuations:continuations,maxAutomaticRepairs:repairs});
  state.service.stageBudget=run=>({exhausted:Number(JSON.parse(run.checkpoint||'{}').steps)>=2});state.continued=[];
  state.service.continueStageTask=(id,options)=>{state.continued.push({id,options});const checkpoint=JSON.parse(state.q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint);checkpoint.steps=0;checkpoint.resumeCount=(checkpoint.resumeCount||0)+1;checkpoint.messages.push({role:'user',content:options.continuation});state.q("UPDATE runs SET status='queued',last_error=NULL,checkpoint=? WHERE id=?").run(JSON.stringify(checkpoint),id);};
}
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-tool-development-test-')),db=new DatabaseSync(':memory:'),q=sql=>db.prepare(sql);
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT,template TEXT,tools TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY AUTOINCREMENT,bot_id INTEGER,thread TEXT,status TEXT,parent_run INTEGER,source TEXT,depth INTEGER DEFAULT 0,last_error TEXT,origin_request_id TEXT,origin_message_id INTEGER,checkpoint TEXT);
    CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT);
    CREATE TABLE approvals(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);`);
  const base=['read_file','write_file','apply_patch','run_checks','shell','exec_command'];
  for(const [id,template]of [[1,'architect'],[2,'builder'],[3,'qa-engineer'],[4,'reviewer'],[5,'researcher'],[6,'data-analyst'],[7,'frontend-designer'],[8,'windows-operator'],[9,'technical-writer']])q('INSERT INTO bots VALUES(?,?,?,?)').run(id,template,template,JSON.stringify(base));
  q("INSERT INTO runs(id,bot_id,thread,status,source,origin_request_id,origin_message_id) VALUES(1,2,'bot:2','running','api','fixture-source-id',44)").run();
  const state={root,db,q,registry:base.map(spec),notes:[],events:[],spawned:[],enabled:[],resumed:[],stopped:[],snapshotCalls:0,validationCalls:0,applyCalls:0,probeCalls:0,snapshots:new Map(),diskHash:baseline,loadedHash:baseline,services:[]};
  state.options={db,query:q,root,dataDir:path.join(root,'data'),tools:()=>state.registry,
    spawnTask:task=>{const id=Number(q('INSERT INTO runs(bot_id,thread,status,parent_run,source,depth) VALUES(?,?,?,?,?,?)').run(task.botId,task.thread,'queued',task.parentRun,task.source,task.depth??0).lastInsertRowid);state.spawned.push({...task,id});return id;},
    notify:(run,message)=>state.notes.push({runId:run.id,...message}),event:(runId,type,data)=>state.events.push({runId,type,...data}),
    enableTool:(botId,name,effects)=>{assert.equal(state.probeCalls,1,'Consumer grants follow the installed probe');state.enabled.push({botId,name,effects});const row=q('SELECT tools FROM bots WHERE id=?').get(botId);q('UPDATE bots SET tools=? WHERE id=?').run(JSON.stringify([...new Set([...JSON.parse(row.tools),name])]),botId);},
    resumeTask:(runId,request)=>{if(state.preventResume)return false;const result=q("UPDATE runs SET status='queued' WHERE id=? AND status='waiting_tool'").run(runId);if(result.changes)state.resumed.push({runId,requestId:request.id});return!!result.changes;},
    stopTask:runId=>{state.stopped.push(runId);q("UPDATE runs SET status='stopped' WHERE id=?").run(runId);},
    maintenance:{snapshot:()=>{state.snapshotCalls++;const id=randomUUID();state.snapshots.set(id,{id,state:'snapshot',baseline:{hash:state.diskHash}});return{id};},
      validate:async(id,{signal}={})=>{state.validationCalls++;state.validationStarted=true;if(state.holdValidation)await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));if(state.validationFails)throw new Error('Fixture tests failed');const receipt=state.snapshots.get(id);Object.assign(receipt,{state:'validated',validatedHash:candidate});return{...receipt};},
      apply:id=>{state.applyCalls++;state.snapshots.get(id).state='restart_pending';return{state:'restart_pending'};},
      status:id=>({sourceHash:state.diskHash,snapshot:{...state.snapshots.get(id)}})},
    inspectCandidate:async name=>state.badSchema?{found:true,spec:{function:{name,parameters:{type:'object'}}}}:{found:true,spec:spec(name)},
    verifyInstalledTool:async request=>{state.probeCalls++;if(state.probeFails)return{pass:false,needsAction:true,error:'Fixture activation needs a user decision'};const source=fs.readFileSync(request.verification.args.file,'utf8'),words=source.trim().split(/\s+/).length;return{pass:request.verification.assertions.every(item=>item.path==='words'&&item.equals===words),words};},bootHash:()=>state.loadedHash};
  state.create=()=>{const service=new ToolDevelopment(state.options).initialize();state.services.push(service);state.service=service;return service;};state.create();
  state.args={title:'Count words',toolName:'fixture_word_count',capability:'Count words in a local text fixture.',domain:'engineering',acceptanceCriteria:['Count actual whitespace-separated words','Reject missing fixture input'],gapType:'missing_tool',effects:'read'};
  state.request=(args=state.args,runId=1,key)=>{const run=q('SELECT * FROM runs WHERE id=?').get(runId),bot=q('SELECT * FROM bots WHERE id=?').get(run.bot_id);return state.service.request({run,bot,args,availableTools:state.registry,requestKey:key});};
  state.park=(runId=1)=>{const watch=q('SELECT request_id FROM tool_development_watchers WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(runId);return q("UPDATE runs SET status='waiting_tool',checkpoint=? WHERE id=?").run(JSON.stringify({messages:[],awaitingToolRequest:watch?.request_id}),runId);};
  state.finish=async(id,{approved=true,missing=false}={})=>{const request=state.service.get(id),stage=request.stages.at(-1);if(!missing){fs.mkdirSync(path.dirname(stage.artifact_path),{recursive:true});const receipt={requestId:id,phase:stage.phase,approved,summary:approved?'Fixture stage complete':'Fixture stage rejected'};if(['testing','reviewing'].includes(stage.phase))receipt.sourceHash=state.diskHash;if(stage.phase==='testing'){const file=path.join(request.artifact_dir,'fixture.txt');fs.writeFileSync(file,'one two three');receipt.verification={args:{file},assertions:[{path:'words',equals:3}]};}fs.writeFileSync(stage.artifact_path,JSON.stringify(receipt));}if(stage.phase==='building')state.diskHash=candidate;q("UPDATE runs SET status='done' WHERE id=?").run(stage.run_id);await state.service.pump();};
  state.toValidation=async id=>{state.park();await state.service.pump();for(let i=0;i<4;i++)await state.finish(id);assert.equal(state.service.get(id).status,'validating');};
  state.toDeployment=async id=>{await state.toValidation(id);await state.service.pump();assert.equal(state.service.get(id).status,'deploying');};
  state.rejectedReview=async id=>{state.park();await state.service.pump();for(let i=0;i<3;i++)await state.finish(id);await state.finish(id,{approved:false});assert.equal(state.service.get(id).status,'blocked');q("UPDATE runs SET status='paused',checkpoint=? WHERE id=1").run(JSON.stringify({messages:[],awaitingToolRequest:id}));};
  state.boot=id=>{const request=state.service.get(id);Object.assign(state.snapshots.get(request.snapshot_id),{state:'applied',bootHash:candidate,pid:9001});state.loadedHash=candidate;state.registry.push(spec(request.tool_name));};
  t.after(async()=>{for(const service of state.services)await service.close();db.close();assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-tool-development-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return state;
}

test('noProgress waiters must not starve eligible ready request',async t=>{
 const s=fixture(t),r=s.request();await s.toDeployment(r.requestId);s.preventResume=true;s.boot(r.requestId);await s.service.pump();
 const original=s.q('SELECT * FROM tool_development_requests WHERE id=?').get(r.requestId),columns=Object.keys(original);
 for(let i=0;i<60;i++){
  const id='held-'+i,runId=500+i;
  s.q("INSERT INTO runs(id,bot_id,thread,status,source,checkpoint) VALUES(?,2,'bot:2','waiting_tool','api',?)").run(runId,JSON.stringify({awaitingToolRequest:id,noProgress:true,messages:[]}));
  const row={...original,id,created_at:0};s.q(`INSERT INTO tool_development_requests(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
  s.q('INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer) VALUES(?,?,2,?,1)').run(id,runId,'bot:2');
 }
 s.preventResume=false;
 for(let i=0;i<3;i++)await s.service.pump();
 assert.deepEqual(s.resumed.map(r=>r.runId),[1], 'eligible task should resume despite held older waiters');
});

test('truthy noProgress values are excluded before LIMIT with JavaScript semantics',async t=>{
 for(const value of [true,1,-1,0.5,'false','0',' ',[],{}]){
  const s=fixture(t),r=s.request();await s.toDeployment(r.requestId);s.preventResume=true;s.boot(r.requestId);await s.service.pump();
  const original=s.q('SELECT * FROM tool_development_requests WHERE id=?').get(r.requestId),columns=Object.keys(original);
  for(let i=0;i<60;i++){
   const id='held-'+i,runId=500+i;
   s.q("INSERT INTO runs(id,bot_id,thread,status,source,checkpoint) VALUES(?,2,'bot:2','waiting_tool','api',?)").run(runId,JSON.stringify({awaitingToolRequest:id,noProgress:value,messages:[]}));
   const row={...original,id,created_at:0};s.q(`INSERT INTO tool_development_requests(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
   s.q('INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer) VALUES(?,?,2,?,1)').run(id,runId,'bot:2');
  }
  s.preventResume=false;await s.service.pump();
  assert.deepEqual(s.resumed.map(r=>r.runId),[1],JSON.stringify(value));
  assert.equal(s.q("SELECT count(*) n FROM runs WHERE id>=500 AND status='waiting_tool'").get().n,60);
  await s.service.close();s.create();await s.service.pump();
  assert.deepEqual(s.resumed.map(r=>r.runId),[1],'no duplicate across restart');
 }
});
test('falsy noProgress values remain eligible',async t=>{
 for(const value of [undefined,null,false,0,-0,'']){
  const s=fixture(t),r=s.request();await s.toDeployment(r.requestId);s.preventResume=true;s.boot(r.requestId);await s.service.pump();
  s.q('UPDATE runs SET checkpoint=? WHERE id=1').run(JSON.stringify({awaitingToolRequest:r.requestId,noProgress:value,messages:[]}));
  s.preventResume=false;await s.service.pump();assert.deepEqual(s.resumed.map(r=>r.runId),[1],String(value));
 }
});
test('older stopped, mismatched, malformed and noProgress rows cannot starve armed valid dependency',async t=>{
 const s=fixture(t),r=s.request();await s.toDeployment(r.requestId);s.preventResume=true;s.boot(r.requestId);await s.service.pump();
 s.db.exec('CREATE TABLE project_continuations(run_id INTEGER,remaining INTEGER,expires INTEGER,stopped INTEGER)');
 s.q('INSERT INTO project_continuations VALUES(1,-1,0,0)').run();
 const original=s.q('SELECT * FROM tool_development_requests WHERE id=?').get(r.requestId),columns=Object.keys(original);
 for(let i=0;i<240;i++){
  const id='held-'+i,runId=500+i,kind=i%4;
  const checkpoint=kind===2?'invalid-json':JSON.stringify({awaitingToolRequest:kind===1?'not-'+id:id,noProgress:kind===3,messages:[]});
  s.q("INSERT INTO runs(id,bot_id,thread,status,source,checkpoint) VALUES(?,2,'bot:2',?,'api',?)").run(runId,kind===0?'stopped':'waiting_tool',checkpoint);
  const row={...original,id,created_at:0};s.q(`INSERT INTO tool_development_requests(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
  s.q('INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer) VALUES(?,?,2,?,1)').run(id,runId,'bot:2');
 }
 s.preventResume=false;await s.service.pump();assert.deepEqual(s.resumed.map(r=>r.runId),[1]);
 assert.equal(s.q("SELECT count(*) n FROM runs WHERE id>=500 AND status='stopped'").get().n,60);
 assert.equal(s.q("SELECT count(*) n FROM tool_development_watchers WHERE run_id>=500 AND resumed_at IS NOT NULL").get().n,0);
});
