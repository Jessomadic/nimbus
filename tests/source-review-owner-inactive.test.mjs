import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {ProjectContinuation} from '../runtime/project-continuation.js';
import {ProjectLifecycleOwnership} from '../runtime/project-lifecycle.js';

// Share the existing isolated SQLite/service fixture without registering its
// test cases or importing application db.js against the production data path.
const original=fs.readFileSync(new URL('./tool-development.test.mjs',import.meta.url),'utf8');
const boundary=original.indexOf("test('queue dispatch");
assert.ok(boundary>0,'The shared fixture must end before test registrations');
const header=original.slice(0,boundary).replaceAll("'../runtime/tool-development.js'",JSON.stringify(new URL('../runtime/tool-development.js',import.meta.url).href));
const {fixture}=await import('data:text/javascript;base64,'+Buffer.from(header+'\nexport {fixture};').toString('base64'));
const ownerError='The adopted project owner is no longer authorized to continue this stage.';
const currentHash='a'.repeat(64),oldHash='b'.repeat(64);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function held(t){
  const s=fixture(t),id=s.request().requestId;
  s.db.exec('CREATE TABLE task_events(id INTEGER PRIMARY KEY,run_id INTEGER,type TEXT,body TEXT)');
  s.q("INSERT INTO bots VALUES(22,'Project leader','orchestrator','[]')").run();
  for(const leader of [90,91])s.q("INSERT INTO runs(id,bot_id,thread,status,source,checkpoint) VALUES(?,22,'bot:22','running','api',?)").run(leader,JSON.stringify({messages:[]}));
  const policy=new ProjectContinuation({db:s.db,query:s.q,resume:()=>assert.fail('No leader replay'),owned:new Set(),event:()=>{}});
  for(const leader of [90,91])policy.arm(leader,{project:'fixture',checkpointRef:'fixture/current.md',mode:'until_complete'});
  const owners=new ProjectLifecycleOwnership({db:s.db,query:s.q,continuation:policy,event:()=>{}}),host={authenticated:true,principal:'synthetic-owner'};
  const adopt=leader=>owners.adopt(id,{leaderRunId:leader,project:'fixture',reason:'Retain the existing candidate under the current project leader'},host);
  s.service.recoveryOwner=request=>owners.recoveryOwner(request);
  adopt(90);s.park(1);s.park(90);
  await s.service.pump();await s.finish(id);
  const stage=s.service.get(id).stages.at(-1),checkpoint={messages:[{role:'tool',tool_call_id:'retained',content:'Completed synthetic implementation evidence'}],steps:7};
  s.q("UPDATE runs SET status='running',checkpoint=? WHERE id=?").run(JSON.stringify(checkpoint),stage.run_id);
  s.diskHash=currentHash;
  const partial={requestId:id,phase:'building',approved:false,reasonCode:'implementation_incomplete',summary:'Partial candidate; authoritative runner wiring remains incomplete.',sourceHash:currentHash,remainingWork:['Finish runner ownership and meaningful acceptance checks']};
  fs.writeFileSync(stage.artifact_path,JSON.stringify(partial));
  fs.writeFileSync(path.join(s.root,'retained-source.js'),'// retained source edits\n');
  s.q("UPDATE runs SET status='done' WHERE id=90").run();
  const hold=s.service.completionForRun(stage.run_id,checkpoint);
  assert.equal(hold.code,'owner_inactive');
  s.q("UPDATE runs SET status='paused',last_error=? WHERE id=?").run(hold.feedback,stage.run_id);
  s.q("INSERT INTO task_events VALUES(1,?,'task.paused',?)").run(stage.run_id,JSON.stringify({error:hold.feedback,code:hold.code}));
  await s.service.pump();
  assert.deepEqual(s.service.get(id).error_metadata,{code:'stage_failed',stage:'building',stageRunId:stage.run_id});
  const priors=[];
  for(let index=0;index<2;index++){
    const prior=randomUUID(),snapshot='prior-'+index,runId=200+index;
    s.q("INSERT INTO tool_development_requests SELECT ?,tool_name,title,capability,domain,acceptance_json,effects,gap_type,?,'blocked','blocked',message,version,origin_run_id,requester_run_id,origin_json,?,validated_hash,candidate_spec,error,error_metadata,activation_state,activation_result,created_at,updated_at FROM tool_development_requests WHERE id=?").run(prior,'prior-fingerprint-'+index,snapshot,id);
    s.snapshots.set(snapshot,{id:snapshot,state:'snapshot',baseline:{hash:oldHash}});
    s.q("INSERT INTO runs(id,bot_id,thread,status,source,checkpoint) VALUES(?,2,'bot:2','done','tool-development',?)").run(runId,JSON.stringify({messages:[]}));
    s.q("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES(?,'building',1,2,?,'failed',?)").run(prior,runId,path.join(s.root,'prior-'+index+'.json'));
    priors.push(prior);
  }
  Object.assign(s,{id,stage,checkpoint,priors,owners,policy,adopt});
  s.input=priorRequestId=>({priorRequestId,expectedSourceHash:currentHash,expectedVersion:s.service.get(id).version,stageRunId:stage.run_id,reason:'The current owner requests independent inspection of retained source, without replay.'});
  s.completeReview=(review,prior,change={})=>{
    s.q("UPDATE runs SET status='done' WHERE id=?").run(review.reviewTaskId);
    const report={requestId:id,priorRequestId:prior,sourceHash:currentHash,approved:true,disposition:'dependency_build_only',summary:'Independent synthetic source inspection',findings:[],...change};
    fs.writeFileSync(review.artifactPath,JSON.stringify(report));
    return report;
  };
  return s;
}

test('owner-expiry source review preserves the paused stage and requires both independent current-source reviews before ordinary retry',async t=>{
  const s=await held(t),before=s.service.get(s.id),originalStage=s.q('SELECT * FROM tool_development_stages WHERE run_id=?').get(s.stage.run_id),originalRun=s.q('SELECT * FROM runs WHERE id=?').get(s.stage.run_id);
  const receipt=fs.readFileSync(s.stage.artifact_path),source=fs.readFileSync(path.join(s.root,'retained-source.js'));
  assert.throws(()=>s.service.initiateSourceReview(s.id,s.input(s.priors[0])),/armed owner/);
  s.adopt(91);
  assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
  const first=s.service.initiateSourceReview(s.id,s.input(s.priors[0]));
  assert.equal(s.service.initiateSourceReview(s.id,s.input(s.priors[0])).reviewTaskId,first.reviewTaskId);
  assert.throws(()=>s.service.initiateSourceReview(s.id,s.input(s.priors[1])),/in flight/);
  assert.equal(s.spawned.at(-1).source,'tool-development-investigation');
  assert.match(s.spawned.at(-1).prompt,/DO NOT retry/);
  assert.deepEqual(s.q('SELECT * FROM tool_development_stages WHERE run_id=?').get(s.stage.run_id),originalStage);
  assert.deepEqual(s.q('SELECT * FROM runs WHERE id=?').get(s.stage.run_id),originalRun);
  assert.deepEqual(s.service.get(s.id).error_metadata,before.error_metadata);
  assert.deepEqual(fs.readFileSync(s.stage.artifact_path),receipt);
  s.completeReview(first,s.priors[0],{sourceHash:oldHash});
  assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
  s.completeReview(first,s.priors[0]);
  assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/,'The second prior remains unreviewed');
  const second=s.service.initiateSourceReview(s.id,s.input(s.priors[1]));s.completeReview(second,s.priors[1]);
  await s.service.pump();assert.equal(s.service.get(s.id).status,'blocked','Reviews do not dispatch or approve the build');
  s.service.retry(s.id,{fromPhase:'building',reason:'Finish the retained partial candidate; do not repeat completed effects.'});
  const after=s.service.get(s.id);
  assert.equal(after.status,'building');assert.notEqual(after.stages.at(-1).run_id,s.stage.run_id);
  assert.equal(after.stages[0].run_id,before.stages[0].run_id);
  assert.equal(after.history.length,1);assert.equal(after.history[0].run_id,s.stage.run_id);
  assert.deepEqual(fs.readFileSync(after.history[0].archived_artifact_path),receipt);
  assert.equal(after.history[0].archived_artifact_hash,sha(receipt));
  assert.deepEqual(s.q('SELECT * FROM runs WHERE id=?').get(s.stage.run_id),originalRun);
  assert.deepEqual(fs.readFileSync(path.join(s.root,'retained-source.js')),source);
  assert.equal(s.applyCalls,0);assert.equal(s.validationCalls,0);assert.deepEqual(s.resumed,[]);
});

test('owner-expiry eligibility rejects unrelated, forged, denied, active, stopped and mismatched state without dispatch',async t=>{
  for(const kind of ['genericFailure','wrongError','missingPause','wrongPauseCode','wrongMetadataStage','wrongMetadataRun','wrongStageStatus','wrongSource','version','stage','hash','ownerDone','ownerBusy','pending','stopped','noProgress','uncertain','denied','priorStopped','priorUncertain','concurrent']){
    await t.test(kind,async t=>{
      const s=await held(t);s.adopt(91);const input=s.input(s.priors[0]),count=s.spawned.length;
      if(kind==='genericFailure')s.q('UPDATE tool_development_requests SET error_metadata=? WHERE id=?').run(JSON.stringify({code:'stage_failed',stage:'building',stageRunId:s.stage.run_id}),s.id),s.q("UPDATE runs SET last_error='Generic failure' WHERE id=?").run(s.stage.run_id);
      if(kind==='wrongError')s.q("UPDATE tool_development_stages SET error='Other failure' WHERE run_id=?").run(s.stage.run_id);
      if(kind==='missingPause')s.q('DELETE FROM task_events WHERE run_id=?').run(s.stage.run_id);
      if(kind==='wrongPauseCode')s.q('UPDATE task_events SET body=? WHERE run_id=?').run(JSON.stringify({error:ownerError,code:'permission_denied'}),s.stage.run_id);
      if(kind==='wrongMetadataStage'||kind==='wrongMetadataRun')s.q('UPDATE tool_development_requests SET error_metadata=? WHERE id=?').run(JSON.stringify({code:'stage_failed',stage:kind==='wrongMetadataStage'?'testing':'building',stageRunId:s.stage.run_id+(kind==='wrongMetadataRun'?1:0)}),s.id);
      if(kind==='wrongStageStatus')s.q("UPDATE tool_development_stages SET status='done' WHERE run_id=?").run(s.stage.run_id);
      if(kind==='wrongSource')s.q("UPDATE runs SET source='api' WHERE id=?").run(s.stage.run_id);
      if(kind==='version')input.expectedVersion++;
      if(kind==='stage')input.stageRunId++;
      if(kind==='hash')input.expectedSourceHash=oldHash;
      if(kind==='ownerDone')s.q("UPDATE runs SET status='done' WHERE id=91").run();
      if(kind==='ownerBusy')s.q("INSERT INTO tool_calls VALUES('busy',91,'write_file','running')").run();
      if(kind==='pending')s.service.maintenance={status:()=>({sourceHash:currentHash,pending:true})};
      if(kind==='stopped')s.q("UPDATE runs SET status='stopped' WHERE id=?").run(s.stage.run_id);
      if(kind==='noProgress')s.q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({...s.checkpoint,noProgress:true}),s.stage.run_id);
      if(kind==='uncertain')s.q("INSERT INTO tool_calls VALUES('unknown',?,'shell','uncertain')").run(s.stage.run_id);
      if(kind==='denied')s.q("INSERT INTO approvals VALUES(88,?,'denied')").run(s.stage.run_id);
      if(kind==='priorStopped')s.q("UPDATE runs SET status='stopped' WHERE id=200").run();
      if(kind==='priorUncertain')s.q("INSERT INTO tool_calls VALUES('prior-unknown',200,'shell','uncertain')").run();
      if(kind==='concurrent')s.q("UPDATE tool_development_requests SET status='building' WHERE id=?").run(s.priors[1]);
      const state=s.q('SELECT * FROM tool_development_requests WHERE id=?').get(s.id);
      assert.throws(()=>s.service.initiateSourceReview(s.id,input),undefined,kind);
      assert.equal(s.spawned.length,count);assert.deepEqual(s.q('SELECT * FROM tool_development_requests WHERE id=?').get(s.id),state);
      assert.equal(s.service.get(s.id).history.length,0);assert.equal(s.applyCalls,0);
    });
  }
});

test('setup review retry keeps owner-expiry hold and original rejection while rechecking authority and exact initiation',async t=>{
  const s=await held(t);s.adopt(91);const input=s.input(s.priors[0]),first=s.service.initiateSourceReview(s.id,input);
  s.completeReview(first,s.priors[0],{approved:false,failureKind:'setup',summary:'Required local inspection evidence unavailable'});
  const bytes=fs.readFileSync(first.artifactPath),metadata=s.service.get(s.id).error_metadata;
  const retry={priorRequestId:s.priors[0],expectedSourceHash:currentHash,reviewTaskId:first.reviewTaskId,reason:'The missing synthetic inspection evidence is now available.'};
  s.q("INSERT INTO approvals VALUES(88,?,'denied')").run(s.stage.run_id);
  assert.throws(()=>s.service.reviewSource(s.id,retry),/reconciliation/);s.q('DELETE FROM approvals WHERE id=88').run();
  s.q('UPDATE tool_development_requests SET version=version+1 WHERE id=?').run(s.id);
  assert.throws(()=>s.service.reviewSource(s.id,retry),/exact retained/);s.q('UPDATE tool_development_requests SET version=version-1 WHERE id=?').run(s.id);
  const second=s.service.reviewSource(s.id,retry);assert.notEqual(second.reviewTaskId,first.reviewTaskId);
  assert.deepEqual(fs.readFileSync(first.artifactPath),bytes);assert.deepEqual(s.service.get(s.id).error_metadata,metadata);
  assert.equal(s.service.get(s.id).stages.at(-1).run_id,s.stage.run_id);
  assert.throws(()=>s.service.reviewSource(s.id,retry),/latest terminal/);
  s.completeReview(second,s.priors[0],{approved:false,failureKind:'implementation',findings:['Retained source is unsafe']});
  assert.throws(()=>s.service.reviewSource(s.id,{...retry,reviewTaskId:second.reviewTaskId}),/setup rejection/);
  assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
});
