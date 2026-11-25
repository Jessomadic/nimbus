import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {inspectStageCompletion,completionDecision} from '../runtime/lifecycle-completion.js';
import {ToolDevelopment} from '../runtime/tool-development.js';
import {ProjectLifecycleOwnership} from '../runtime/project-lifecycle.js';

const source='a'.repeat(64),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function evidence(state,id='call',result={observed:'actual check'}){
  state.messages.push({role:'assistant',tool_calls:[{id,function:{name:'read_file',arguments:'{"path":"candidate.js"}'}}]},{role:'tool',tool_call_id:id,content:JSON.stringify(result)});
}
function setup(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-completion-')),db=new DatabaseSync(':memory:'),q=s=>db.prepare(s),dataDir=path.join(root,'data');
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT,template TEXT,tools TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,status TEXT,parent_run INTEGER,source TEXT,checkpoint TEXT,last_error TEXT);
    CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT);
    CREATE TABLE approvals(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);`);
  q('INSERT INTO bots VALUES(1,?,?,?)').run('QA','qa-engineer','[]');
  for(const [id,status,kind]of[[1,'done','user'],[2,'done','tool-development'],[3,'done','tool-development'],[4,'done','tool-development']])q('INSERT INTO runs VALUES(?,1,?,?,1,?,?,NULL)').run(id,'bot:1',status,kind,JSON.stringify({messages:[],steps:0}));
  const s={root,db,q,dataDir,continued:[],diskHash:source,pending:null};
  s.service=new ToolDevelopment({db,query:q,root,dataDir,maintenance:{status:()=>({sourceHash:s.diskHash,pending:s.pending,snapshot:{id:'snapshot',state:'snapshot'}})},continueStageTask:(id,options)=>{
    s.continued.push({id,options});const checkpoint=JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint);checkpoint.messages.push({role:'user',content:options.continuation});q("UPDATE runs SET status='queued',checkpoint=? WHERE id=?").run(JSON.stringify(checkpoint),id);
  }}).initialize();
  q(`INSERT INTO tool_development_requests(id,tool_name,title,capability,domain,acceptance_json,effects,gap_type,fingerprint,status,phase,message,origin_run_id,requester_run_id,origin_json,snapshot_id,error_metadata) VALUES('request','fixture','Fixture','Fixture','engineering','[]','read','missing_tool','fp','blocked','blocked','Missing receipt',1,1,'{}','snapshot',?)`).run(JSON.stringify({code:'lifecycle_failed',phase:'testing'}));
  q("INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer) VALUES('request',1,1,'bot:1',1)").run();
  const dir=path.join(dataDir,'tool-development','request');fs.mkdirSync(dir,{recursive:true});
  for(const [ordinal,phase,run]of[[0,'designing',2],[1,'building',3],[2,'testing',4]]){
    const file=path.join(dir,phase+'.json'),receipt={requestId:'request',phase,approved:true,summary:'actual prior checks',sourceHash:source};
    let bytes=null;if(phase!=='testing'){bytes=Buffer.from(JSON.stringify(receipt));fs.writeFileSync(file,bytes);}
    q('INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path,artifact_hash,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)').run('request',phase,ordinal,1,run,phase==='testing'?'failed':'done',file,bytes?hash(bytes):null,bytes?bytes.toString():null);
  }
  s.stage=()=>q("SELECT * FROM tool_development_stages WHERE request_id='request' AND phase='testing'").get();
  s.receipt=change=>{const r={requestId:'request',phase:'testing',approved:true,summary:'fresh independent check',sourceHash:source,verification:{args:{action:'status'},assertions:[{path:'ok',equals:true}]},...change};fs.writeFileSync(s.stage().artifact_path,JSON.stringify(r));return r;};
  s.inspect=()=>inspectStageCompletion({request:{id:'request'},stage:s.stage(),currentSourceHash:s.diskHash});
  s.continue=()=>s.service.continueIncompleteStage('request',{stageRunId:4,expectedSourceHash:s.diskHash,reason:'Complete the retained QA checkpoint without replay.'});
  t.after(async()=>{await s.service.close();db.close();assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-completion-/);fs.rmSync(root,{recursive:true,force:true});});return s;
}

test('missing receipt continues same checkpoint; repeated unchanged final holds across serialization',t=>{
  const s=setup(t),state={messages:[]};evidence(state);
  assert.equal(completionDecision(s.inspect(),state,{requestId:'request',phase:'testing',currentSourceHash:source}).action,'continue');
  const restarted=JSON.parse(JSON.stringify(state));restarted.messages.push({role:'assistant',content:'Different incomplete prose'});evidence(restarted,'second');
  const result=completionDecision(s.inspect(),restarted,{requestId:'request',phase:'testing',currentSourceHash:source});assert.equal(result.code,'no_progress');assert.equal(restarted.noProgress,true);assert.equal(fs.existsSync(s.stage().artifact_path),false);
});
test('new inspection evidence permits continuation; volatile times and repeated reads do not',t=>{
  const s=setup(t),state={messages:[]},context={requestId:'request',phase:'testing',currentSourceHash:source};
  evidence(state,'one',{observed:'first',updatedAt:'time1',durationMs:1});assert.equal(completionDecision(s.inspect(),state,context).action,'continue');
  evidence(state,'two',{observed:'second',updatedAt:'time2',durationMs:2});assert.equal(completionDecision(s.inspect(),state,context).action,'continue');
  evidence(state,'three',{observed:'second',updatedAt:'time3',durationMs:3});assert.equal(completionDecision(s.inspect(),state,context).code,'no_progress');
});
test('receipt-only formatting and summary edits do not reset incomplete contract progress',t=>{
  const s=setup(t),state={messages:[]},receiptPath=s.stage().artifact_path,context={requestId:'request',phase:'testing',currentSourceHash:source,receiptPath};
  s.receipt({sourceHash:undefined,summary:'First prose'});assert.equal(completionDecision(s.inspect(),state,context).action,'continue');
  const r=s.receipt({sourceHash:undefined,summary:'Different prose'});fs.writeFileSync(receiptPath,JSON.stringify(r,null,2));const spelling=process.platform==='win32'?receiptPath.replaceAll('\\','/').toUpperCase():receiptPath;state.messages.push({role:'assistant',tool_calls:[{id:'write',function:{name:'write_file',arguments:JSON.stringify({path:spelling,content:JSON.stringify(r)})}}]},{role:'tool',tool_call_id:'write',content:'{"bytes":500}'});
  assert.equal(completionDecision(s.inspect(),state,context).code,'no_progress');
});
test('identical terminal outcome with changing TAP/session timing cannot restart progress',t=>{
  const s=setup(t),state={messages:[]},context={requestId:'request',phase:'testing',currentSourceHash:source};
  const terminal=(id,ms)=>({id,sessionId:id,pid:ms,status:'done',exitCode:0,output:`ok 1 - check\n  duration_ms: ${ms}\n# pass 1\n# duration_ms ${ms}\n✔ check (${ms}ms)\nℹ duration_ms ${ms}`});
  evidence(state,'first',terminal('session1',100));assert.equal(completionDecision(s.inspect(),state,context).action,'continue');
  evidence(state,'second',terminal('session2',200));assert.equal(completionDecision(s.inspect(),state,context).code,'no_progress');
});
test('valid rejection is terminal and cannot be forced through incomplete continuation',async t=>{
  const s=setup(t);s.receipt({approved:false,failureKind:'uncertain',sourceHash:undefined,summary:'A real external result needs inspection'});const before=fs.readFileSync(s.stage().artifact_path);
  assert.equal(s.inspect().rejected,true);await assert.rejects(s.continue(),/valid rejected receipt/);assert.deepEqual(fs.readFileSync(s.stage().artifact_path),before);assert.equal(s.continued.length,0);
});
test('missing on-disk receipt cannot erase a retained real rejection',async t=>{
  const s=setup(t),r={requestId:'request',phase:'testing',approved:false,summary:'Real implementation defect',failureKind:'implementation',findings:['Actual failure']};s.q("UPDATE tool_development_stages SET receipt_json=? WHERE phase='testing'").run(JSON.stringify(r));await assert.rejects(s.continue(),/retained rejected receipt/);assert.equal(s.continued.length,0);
});
test('approved receipts require current source and one-invocation smoke contract',t=>{
  const s=setup(t);s.receipt({sourceHash:undefined});assert.equal(s.inspect().code,'missing_source_hash');s.receipt({sourceHash:'b'.repeat(64)});assert.equal(s.inspect().code,'source_drift');s.receipt({verification:{args:{},assertions:[]}});assert.equal(s.inspect().code,'invalid_verification');s.receipt({});assert.equal(s.inspect().complete,true);
});
test('live completion checks retain lifecycle ownership and actual uncertainty gates',t=>{
  const s=setup(t),state={messages:[]};s.q("UPDATE tool_development_requests SET status='testing',phase='testing' WHERE id='request'").run();s.q("UPDATE runs SET status='running' WHERE id=4").run();
  assert.equal(s.service.completionForRun(4,state).action,'continue');s.q("INSERT INTO tool_calls VALUES('unknown',4,'shell','uncertain')").run();assert.equal(s.service.completionForRun(4,state).code,'needs_review');assert.equal(s.service.completionForRun(1,state).action,'complete');
});
test('phase-aware QA continuation archives malformed receipt and retains run checkpoint/tool receipts',async t=>{
  const s=setup(t),state={messages:[]};evidence(state);s.q('UPDATE runs SET checkpoint=? WHERE id=4').run(JSON.stringify(state));s.q("INSERT INTO tool_calls VALUES('4:call',4,'read_file','done')").run();fs.writeFileSync(s.stage().artifact_path,'{"incomplete":');
  const r=await s.continue();assert.equal(r.status,'testing');assert.equal(r.stages.at(-1).run_id,4);assert.equal(s.continued.length,1);assert.equal(s.continued[0].options.refreshInstructions,true);assert.match(s.continued[0].options.continuation,/SAME testing/);
  assert.equal(s.q('SELECT state FROM tool_calls WHERE id=?').get('4:call').state,'done');assert.deepEqual(JSON.parse(s.q('SELECT checkpoint FROM runs WHERE id=4').get().checkpoint).messages.slice(0,2),state.messages);
  const recovery=r.recoveries.find(r=>r.kind==='incomplete');assert.equal(fs.readFileSync(recovery.artifact_path,'utf8'),'{"incomplete":');assert.equal(hash(fs.readFileSync(recovery.artifact_path)),recovery.artifact_hash);assert.equal(fs.existsSync(s.stage().artifact_path),false);await assert.rejects(s.continue(),/latest incomplete done/);
});
test('explicit continuation rejects source races, ownership, uncertainty, stopped owners and stale predecessors',async t=>{
  for(const gate of ['source','uncertain','denied','noProgress','ownerStopped','adoptedRevoked','predecessor','missingPredecessor','maintenance','wrongStage','dispatching']){
    const s=setup(t);
    if(gate==='source')s.service.maintenance.status=()=>({sourceHash:'b'.repeat(64),snapshot:{id:'snapshot',state:'snapshot'}});
    if(gate==='uncertain')s.q("INSERT INTO tool_calls VALUES('unknown',4,'shell','uncertain')").run();
    if(gate==='denied')s.q("INSERT INTO approvals VALUES(1,4,'denied')").run();
    if(gate==='noProgress')s.q('UPDATE runs SET checkpoint=? WHERE id=4').run(JSON.stringify({messages:[],noProgress:true}));
    if(gate==='ownerStopped'){s.db.exec('CREATE TABLE project_continuations(run_id INTEGER,stopped INTEGER)');s.q('INSERT INTO project_continuations VALUES(1,1)').run();}
    if(gate==='adoptedRevoked')s.service.recoveryOwner=()=>({adopted:true,authorized:false});
    if(gate==='predecessor')fs.appendFileSync(path.join(s.root,'data/tool-development/request/building.json'),' ');
    if(gate==='missingPredecessor')s.q("DELETE FROM tool_development_stages WHERE phase='building'").run();
    if(gate==='maintenance')s.pending={id:'pending'};
    if(gate==='wrongStage')s.q("UPDATE runs SET source='user' WHERE id=4").run();
    if(gate==='dispatching')s.q("INSERT INTO tool_development_recoveries(request_id,kind,phase,run_id,attempt,reason,status) VALUES('request','incomplete','testing',4,1,'interrupted','dispatching')").run();
    await assert.rejects(s.continue(),undefined,gate);assert.equal(s.continued.length,0,gate);assert.equal(s.service.get('request').status,'blocked',gate);
  }
});
test('worker facade may exempt only its trusted current running recovery call',async t=>{
  for(const kind of ['current','otherAction','uncertainCurrent','wrongName']){
    const s=setup(t);s.q("UPDATE runs SET status='running' WHERE id=1").run();s.q('INSERT INTO tool_calls VALUES(?,1,?,?)').run('host-key',kind==='wrongName'?'shell':'project_recovery',kind==='uncertainCurrent'?'uncertain':'running');
    if(kind==='otherAction')s.q("INSERT INTO tool_calls VALUES('other',1,'shell','uncertain')").run();
    const action=()=>s.service.continueIncompleteStage('request',{stageRunId:4,expectedSourceHash:source,reason:'Continue authorized task'},{callerRunId:1,currentCallId:'host-key'});
    if(kind==='current'){await action();assert.equal(s.continued.length,1);}else{await assert.rejects(action());assert.equal(s.continued.length,0);}
  }
});
test('adopted owner supersedes historic owner while revocation never falls back',t=>{
  const s=setup(t);s.db.exec('CREATE TABLE project_continuations(run_id INTEGER,stopped INTEGER,remaining INTEGER,expires INTEGER)');s.q('INSERT INTO project_continuations VALUES(1,1,-1,0)').run();
  s.service.recoveryOwner=()=>({adopted:true,authorized:true});assert.equal(s.service._ownerArmed(s.service._row('request')),true);s.service.recoveryOwner=()=>({adopted:true,authorized:false});assert.equal(s.service._ownerArmed(s.service._row('request')),false);
});

test('a busy authorized leader cannot dispatch recovery but does not invalidate completed child evidence',async t=>{
  const s=setup(t);s.service.recoveryOwner=()=>({adopted:true,authorized:true,dispatchSafe:false});assert.equal(s.service._ownerArmed(s.service._row('request')),false);
  s.service.recoveryPolicy=()=>({executionMode:'progress'});s.receipt({approved:false,failureKind:'implementation',findings:['Actual failing check']});let dispatched=false;s.service.retry=()=>{dispatched=true;throw new Error('Must not dispatch while owner effects are active');};
  assert.equal(await s.service._recoverStage(s.service._row('request'),s.stage(),s.service._run(4)),false);assert.equal(dispatched,false);
  s.q("UPDATE tool_development_requests SET status='testing',phase='testing' WHERE id='request'").run();s.q("UPDATE runs SET status='running' WHERE id=4").run();s.receipt({});assert.equal(s.service.completionForRun(4,{messages:[]}).action,'complete');
});

function reviewedSetup(t){
  const s=setup(t);s.db.exec("ALTER TABLE tool_calls ADD COLUMN result TEXT; CREATE TABLE task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER,type TEXT,body TEXT)");
  s.q("DELETE FROM tool_development_stages WHERE ordinal>0").run();
  const stage=s.q("SELECT * FROM tool_development_stages WHERE phase='designing'").get();fs.unlinkSync(stage.artifact_path);
  s.q("UPDATE tool_development_stages SET status='needs_review',receipt_json=NULL,artifact_hash=NULL WHERE phase='designing'").run();
  s.q("UPDATE tool_development_requests SET error_metadata=? WHERE id='request'").run(JSON.stringify({code:'needs_review',stageRunId:2}));
  s.q("UPDATE runs SET status='needs_review',last_error='Enumeration timed out' WHERE id=2").run();
  s.q("UPDATE runs SET status='paused',checkpoint=?,last_error='Design review needed' WHERE id=1").run(JSON.stringify({messages:[],awaitingToolRequest:'request'}));
  s.reviewedCallId='2:enumerate';s.observed={userVerified:true,observedResult:'Host verified child exit; read-only enumeration timed out with partial output, not success. Do not replay.'};
  s.q('INSERT INTO tool_calls VALUES(?,?,?,?,?)').run(s.reviewedCallId,2,'shell','done',JSON.stringify(s.observed));
  s.event=(runId,type,body)=>s.q('INSERT INTO task_events(run_id,type,body) VALUES(?,?,?)').run(runId,type,JSON.stringify(body));
  s.event(2,'tool.uncertain',{id:s.reviewedCallId,error:'Enumeration timed out',uncertain:true});s.event(2,'action.reviewed',{id:s.reviewedCallId,result:s.observed});
  s.service.event=s.event;s.service.recoveryOwner=()=>({adopted:true,authorized:true,dispatchSafe:true});
  s.stage=()=>s.q("SELECT * FROM tool_development_stages WHERE phase='designing'").get();
  s.resume=(change={},internal)=>s.service.resumeReviewedStage('request',{stageRunId:2,expectedSourceHash:source,reviewedCallId:s.reviewedCallId,reason:'Continue the retained design after actual owner reconciliation.',...change},internal);
  return s;
}

test('reviewed designing timeout resumes same checkpoint and reaches real next lifecycle stage without replay',async t=>{
  const s=reviewedSetup(t),original=s.q('SELECT * FROM tool_calls WHERE id=?').get(s.reviewedCallId),checkpoint=s.q('SELECT checkpoint FROM runs WHERE id=2').get().checkpoint;
  const result=await s.resume();assert.equal(result.status,'designing');assert.equal(result.stages[0].run_id,2);assert.equal(s.q('SELECT status FROM runs WHERE id=1').get().status,'waiting_tool');assert.equal(s.continued.length,1);
  assert.deepEqual(s.q('SELECT * FROM tool_calls WHERE id=?').get(s.reviewedCallId),original);assert.equal(s.service.completionForRun(2,{messages:[]}).action,'continue');
  const recovery=result.recoveries.find(r=>r.kind==='reviewed'),audit=JSON.parse(recovery.summary);const saved=JSON.parse(fs.readFileSync(audit.evidencePath,'utf8'));assert.equal(saved.checkpoint,checkpoint);assert.deepEqual(JSON.parse(saved.review.call.result),s.observed);assert.match(s.continued[0].options.continuation,/review is not proof of success/);
  for(const [id,template]of [[2,'builder'],[3,'architect'],[4,'reviewer']])s.q('INSERT INTO bots VALUES(?,?,?,?)').run(id,template,template,JSON.stringify(['read_file','write_file','apply_patch','shell']));
  s.q('UPDATE bots SET tools=? WHERE id=1').run(JSON.stringify(['read_file','write_file','shell']));s.service.tools=()=>['read_file','write_file','apply_patch','shell'].map(name=>({function:{name}}));s.service.spawnTask=task=>{s.q('INSERT INTO runs VALUES(5,?,?,?,1,?,?,NULL)').run(task.botId,task.thread,'queued',task.source,'{"messages":[]}');return 5;};
  fs.writeFileSync(s.stage().artifact_path,JSON.stringify({requestId:'request',phase:'designing',approved:true,summary:'Design inspected and completed after bounded source discovery.'}));s.q("UPDATE runs SET status='done' WHERE id=2").run();await s.service.pump();assert.equal(s.service.get('request').status,'building');assert.equal(s.service.get('request').stages.at(-1).run_id,5);assert.deepEqual(s.q('SELECT * FROM tool_calls WHERE id=?').get(s.reviewedCallId),original);
});

test('reviewed-stage continuation rejects unsafe identities, stale reviews, receipts, authority and source',async t=>{
  const cases=['wrongCall','wrongStage','unresolved','missingReview','wrongResult','reviewBeforeUncertainty','denied','journalDenied','stopped','noProgress','ownerBusy','ownerRevoked','ownerMissing','sourceDrift','pending','acceptedDisk','acceptedRetained','rejectedDisk','rejectedRetained','wrongHold','sourceReviewHold','otherWriter'];
  for(const gate of cases){const s=reviewedSetup(t);let change={};
    if(gate==='wrongCall')change.reviewedCallId='4:foreign';if(gate==='wrongStage')change.stageRunId=4;
    if(gate==='unresolved')s.q("UPDATE tool_calls SET state='uncertain'").run();
    if(gate==='missingReview')s.q("DELETE FROM task_events WHERE type='action.reviewed'").run();
    if(gate==='wrongResult')s.q('UPDATE tool_calls SET result=?').run(JSON.stringify({...s.observed,observedResult:'Tampered result'}));
    if(gate==='reviewBeforeUncertainty')s.event(2,'tool.uncertain',{id:s.reviewedCallId,error:'new uncertainty'});
    if(gate==='denied')s.q("INSERT INTO approvals VALUES(1,2,'denied')").run();
    if(gate==='journalDenied')s.q("INSERT INTO tool_calls VALUES('denied',2,'shell','error','{\"denied\":true}')").run();
    if(gate==='stopped')s.q("UPDATE runs SET status='stopped' WHERE id=2").run();
    if(gate==='noProgress')s.q('UPDATE runs SET checkpoint=? WHERE id=2').run('{"messages":[],"noProgress":true}');
    if(gate==='ownerBusy')s.service.recoveryOwner=()=>({adopted:true,authorized:true,dispatchSafe:false});
    if(gate==='ownerRevoked')s.service.recoveryOwner=()=>({adopted:true,authorized:false});
    if(gate==='ownerMissing')s.service.recoveryOwner=()=>null;
    if(gate==='sourceDrift')change.expectedSourceHash='b'.repeat(64);if(gate==='pending')s.pending={id:'pending'};
    if(['acceptedDisk','acceptedRetained','rejectedDisk','rejectedRetained'].includes(gate)){const receipt={requestId:'request',phase:'designing',approved:gate.startsWith('accepted'),summary:'Retained real decision'};if(gate.endsWith('Disk'))fs.writeFileSync(s.stage().artifact_path,JSON.stringify(receipt));else s.q("UPDATE tool_development_stages SET receipt_json=? WHERE phase='designing'").run(JSON.stringify(receipt));}
    if(gate==='wrongHold')s.q("UPDATE tool_development_requests SET error_metadata='{\"code\":\"no_progress\"}'").run();
    if(gate==='sourceReviewHold')s.q("UPDATE tool_development_requests SET error_metadata=?").run(JSON.stringify({code:'source_review_required',stageRunId:2}));
    if(gate==='otherWriter')s.q("INSERT INTO tool_development_requests SELECT 'other',tool_name,title,capability,domain,acceptance_json,effects,gap_type,'otherfp','building','building',message,version,origin_run_id,requester_run_id,origin_json,snapshot_id,validated_hash,candidate_spec,error,error_metadata,activation_state,activation_result,created_at,updated_at FROM tool_development_requests WHERE id='request'").run();
    await assert.rejects(s.resume(change),undefined,gate);assert.equal(s.continued.length,0,gate);assert.equal(s.service.get('request').status,'blocked',gate);
  }
});

test('reviewed recovery rollback preserves held state, receipt, journal and checkpoint if host resume fails',async t=>{
  const s=reviewedSetup(t);fs.writeFileSync(s.stage().artifact_path,'{"unfinished":');const before=s.q('SELECT checkpoint FROM runs WHERE id=2').get().checkpoint;
  s.service.continueStageTask=()=>{s.q("UPDATE runs SET status='queued',checkpoint='{}' WHERE id=2").run();throw Error('Host enqueue refused');};
  await assert.rejects(s.resume(),/Host enqueue refused/);assert.equal(s.service.get('request').status,'blocked');assert.equal(s.stage().status,'needs_review');assert.equal(s.q('SELECT status FROM runs WHERE id=1').get().status,'paused');assert.equal(s.q('SELECT checkpoint FROM runs WHERE id=2').get().checkpoint,before);assert.equal(fs.readFileSync(s.stage().artifact_path,'utf8'),'{"unfinished":');assert.equal(s.q("SELECT count(*) AS n FROM tool_development_recoveries WHERE kind='reviewed'").get().n,0);
});

test('owner review cannot be reused for a new held stage and only exact trusted facade call is exempt',async t=>{
  const s=reviewedSetup(t);s.q("UPDATE runs SET status='running' WHERE id=1").run();s.q("INSERT INTO tool_calls VALUES('1:recovery',1,'project_recovery','running',NULL)").run();
  await assert.rejects(s.resume({}, {callerRunId:1,currentCallId:'forged'}),/identity/);
  await s.resume({}, {callerRunId:1,currentCallId:'1:recovery'});s.q("UPDATE runs SET status='needs_review' WHERE id=2").run();s.q("UPDATE tool_development_requests SET status='blocked',error_metadata=? WHERE id='request'").run(JSON.stringify({code:'needs_review',stageRunId:2}));
  await assert.rejects(s.resume({}, {callerRunId:1,currentCallId:'1:recovery'}),/already resumed/);
});

test('real adopted ownership composes with exact in-flight recovery while overlapping effects remain denied',async t=>{
  for(const overlap of [false,true]){const s=reviewedSetup(t);s.q("INSERT INTO bots VALUES(22,'Leader','orchestrator','[]')").run();s.q("INSERT INTO runs VALUES(9,22,'bot:22','paused',NULL,'api',?,NULL)").run('{"messages":[],"awaitingToolRequest":"request"}');
    const continuation={requireUntilComplete:()=>({checkpoint_ref:'fixture/checkpoint.md'}),get:()=>({stopped:0})};const ownership=new ProjectLifecycleOwnership({db:s.db,query:s.q,continuation,event:s.event});
    ownership.adopt('request',{leaderRunId:9,project:'fixture',reason:'Explicit test owner adoption'},{authenticated:true,principal:'fixture-owner'});s.service.recoveryOwner=id=>ownership.recoveryOwner(id);
    s.q("UPDATE runs SET status='running' WHERE id=9").run();s.q("INSERT INTO tool_calls VALUES('9:recovery',9,'project_recovery','running',NULL)").run();
    if(overlap)s.q("INSERT INTO tool_calls VALUES('9:other',9,'shell','running',NULL)").run();
    assert.equal(ownership.recoveryOwner('request').dispatchSafe,!overlap);
    const invoke=()=>{ownership.assertOwned('request',{runId:9,botId:22,requestKey:'9:recovery'});return s.resume({}, {callerRunId:9,currentCallId:'9:recovery'});};
    if(overlap){assert.throws(invoke,/another running/);assert.equal(s.continued.length,0);}else{await invoke();assert.equal(s.continued.length,1);}
  }
});

test('reviewed recovery restores only a proven unrelated notification pause with a real queued wait',async t=>{
  for(const proof of ['valid','missingPause','differentError','targetBlocked','noWatcher']){const s=reviewedSetup(t);
    s.q("INSERT INTO tool_development_requests SELECT 'next',tool_name,title,capability,domain,acceptance_json,effects,gap_type,'nextfp','queued','queued',message,version,origin_run_id,requester_run_id,origin_json,snapshot_id,validated_hash,candidate_spec,error,error_metadata,activation_state,activation_result,created_at,updated_at FROM tool_development_requests WHERE id='request'").run();
    s.q('UPDATE runs SET checkpoint=? WHERE id=1').run('{"messages":[],"awaitingToolRequest":"next"}');
    if(proof!=='noWatcher')s.q("INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer) VALUES('next',1,1,'bot:1',1)").run();
    if(proof!=='missingPause')s.event(1,'tool.development',{requestId:'request',status:'blocked',message:proof==='differentError'?'Other error':'Design review needed'});
    if(proof==='targetBlocked')s.q("UPDATE tool_development_requests SET status='blocked' WHERE id='next'").run();
    await s.resume();assert.equal(s.q('SELECT status FROM runs WHERE id=1').get().status,proof==='valid'?'waiting_tool':'paused',proof);assert.equal(JSON.parse(s.q('SELECT checkpoint FROM runs WHERE id=1').get().checkpoint).awaitingToolRequest,'next');
  }
});
