import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
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


function progress(s){automaticRecovery(s,{continuations:0,repairs:0});s.service.recoveryPolicy=()=>({executionMode:'progress',maxAutomaticContinuations:0,maxAutomaticRepairs:0});}
async function building(s){const r=s.request();s.park();await s.service.pump();await s.finish(r.requestId);return r.requestId;}
function partial(s,id,{steps=2,noProgress=false}={}){
  const stage=s.service.get(id).stages.at(-1);
  s.q("UPDATE runs SET status='done',checkpoint=? WHERE id=?").run(JSON.stringify({steps,noProgress,messages:[{role:'tool',content:'retained completion'}]}),stage.run_id);
  fs.writeFileSync(stage.artifact_path,JSON.stringify({requestId:id,phase:'building',approved:false,reasonCode:'tool_budget_exhausted',summary:'Partial implementation',remainingWork:['Finish checks']}));
  return stage;
}


async function scenario(t,withHistoricalReview,originalMode=null){
  const s=fixture(t);automaticRecovery(s,{continuations:3,repairs:3});
  let safe=true;s.service.recoveryOwner=()=>({adopted:true,authorized:true,dispatchSafe:safe});
  const id=await building(s);
  await s.finish(id,{approved:false});
  const originalStage=s.service.get(id).stages.at(-1);
  let reviewTaskId=null;
  if(withHistoricalReview){
    // Synthetic prior state only. Actual service creates the review record/task.
    const prior=randomUUID();
    s.q("INSERT INTO tool_development_requests SELECT ?,tool_name,title,capability,domain,acceptance_json,effects,gap_type,'historical-prior','blocked','blocked',message,version,origin_run_id,requester_run_id,origin_json,'prior-snapshot',validated_hash,candidate_spec,error,error_metadata,activation_state,activation_result,created_at,updated_at FROM tool_development_requests WHERE id=?").run(prior,id);
    s.snapshots.set('prior-snapshot',{state:'snapshot',baseline:{hash:baseline}});
    s.q("INSERT INTO runs(id,bot_id,thread,status,source) VALUES(200,2,'bot:2','done','tool-development')").run();
    s.q("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES(?,'building',1,2,200,'failed',?)").run(prior,path.join(s.root,'synthetic-prior.json'));
    const held=s.service.get(id);
    const review=s.service.initiateSourceReview(id,{priorRequestId:prior,expectedSourceHash:candidate,expectedVersion:held.version,stageRunId:originalStage.run_id,reason:'Synthetic independent baseline prerequisite'});
    reviewTaskId=review.reviewTaskId;
    fs.writeFileSync(review.artifactPath,JSON.stringify({requestId:id,priorRequestId:prior,sourceHash:candidate,approved:true,disposition:'dependency_build_only',summary:'Synthetic independent review only',findings:[]}));
    s.q("UPDATE runs SET status='done' WHERE id=?").run(reviewTaskId);
  }
  if(originalMode==='legacy'){s.q("UPDATE tool_development_recoveries SET summary=NULL WHERE request_id=? AND kind='source_review'").run(id);originalMode=null;}
  if(originalMode){
    partial(s,id,{steps:2});await s.service.pump();await s.service.pump();
    const after=s.service.get(id);
    assert.equal(after.stages.at(-1).run_id,originalStage.run_id);
    assert.equal(s.applyCalls,0);assert.equal(s.enabled.length,0);
    if(originalMode==='held'){assert.equal(after.status,'blocked');assert.equal(s.continued.length,0);}
    else {assert.equal(after.status,'building');assert.equal(s.continued.length,1);}
    return;
  }
  s.service.retry(id,{fromPhase:'building',reason:'Synthetic first failure corrected; start a distinct Builder'});
  const nextStage=s.service.get(id).stages.at(-1);
  assert.notEqual(nextStage.run_id,originalStage.run_id,'The failure under test belongs to a NEW Builder');
  partial(s,id,{steps:2});
  // A real temporary dispatch hold makes the normal lifecycle retain the new
  // partial stage as blocked. No direct request status mutation is used.
  safe=false;await s.service.pump();
  const held=s.service.get(id);
  assert.equal(held.status,'blocked');assert.equal(s.continued.length,0);
  safe=true;
  const eligible=s.service.get(id).recovery;
  assert.equal(eligible?.kind,'continuation','Retained recovery planner recognizes safe unfinished work');
  await s.service.pump();
  const after=s.service.get(id);
  const result={withHistoricalReview,originalStageRunId:originalStage.run_id,newStageRunId:nextStage.run_id,reviewTaskId,eligibleRecovery:eligible.kind,status:after.status,continuations:s.continued.length,sourceReviewRecords:after.recoveries.filter(x=>x.kind==='source_review').length,applyCalls:s.applyCalls,enabled:s.enabled.length};
  t.diagnostic(JSON.stringify(result));
  assert.equal(s.applyCalls,0);assert.equal(s.enabled.length,0);
  return result;
}
test('control: a new held Builder resumes after temporary owner-busy state clears',async t=>{
  const result=await scenario(t,false);assert.equal(result.continuations,1);assert.equal(result.status,'building');
});
test('historical completed source review must not suppress recovery of a NEW Builder',async t=>{
  const result=await scenario(t,true);assert.equal(result.continuations,1,'Historical review suppressed an eligible new-stage continuation');assert.equal(result.status,'building');
});

test('original exact stage remains held',async t=>scenario(t,true,'held'));
test('legacy pre-initiation review does not suppress later eligible stage',async t=>scenario(t,true,'legacy'));
