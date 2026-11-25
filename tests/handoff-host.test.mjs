import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {handoffAuthority} from '../runtime/handoff-host.js';
test('host resolver executes real SQL and fails closed on effects, holds, checkpoint and deployment drift',()=>{
 const db=new DatabaseSync(':memory:');
 try{
 db.exec("CREATE TABLE bots(id INTEGER,template TEXT); CREATE TABLE runs(id INTEGER,bot_id INTEGER,parent_run INTEGER,status TEXT,checkpoint TEXT); CREATE TABLE tool_calls(id TEXT,run_id INTEGER,state TEXT,name TEXT,args TEXT); CREATE TABLE approvals(id INTEGER,run_id INTEGER,status TEXT); CREATE TABLE tool_development_requests(id TEXT,requester_run_id INTEGER,status TEXT); INSERT INTO bots VALUES(22,'orchestrator'); INSERT INTO runs VALUES(633,22,NULL,'waiting_tool','{}');");
 const intent={leaderRunId:633,project:'hermes',checkpointRef:'shared/current.md',deployment:{snapshotId:'fixture',validatedHash:'hash',oldPid:10}};
 const principal={kind:'named-owner',id:'owner'};
 const status={pending:null,supervised:true,sourceHash:'hash',snapshot:{id:'fixture',state:'validated',validatedHash:'hash',candidate:{hash:'hash'}}};
 const authority=handoffAuthority({query:s=>db.prepare(s),continuation:{requireUntilComplete:()=>({project:'hermes',checkpoint_ref:'shared/current.md'})},maintenance:{status:()=>status},currentPid:()=>10});
 assert.equal(authority(intent,principal).leader.bot_id,22);
 intent.reservationId='r1';intent.checkpointSha256='a'.repeat(64);
 const identity={runId:633,botId:22,requestKey:'633:reserve'};
 const args={action:'reserve',reservationId:'r1',expectedCheckpointHash:intent.checkpointSha256};
 db.prepare("INSERT INTO tool_calls VALUES(?,?,?,?,?)").run(identity.requestKey,633,'running','project_successor_handoff',JSON.stringify(args));
 assert.throws(()=>authority(intent,principal),/effect_gate/);
 assert.equal(authority(intent,principal,identity).leader.id,633);
 for(const changed of [{...identity,botId:7},{...identity,runId:631},{...identity,requestKey:'other'}])
  assert.throws(()=>authority(intent,principal,changed),/effect_gate/);
 for(const changed of [{...args,action:'cancel'},{...args,reservationId:'other'},{...args,expectedCheckpointHash:'b'.repeat(64)},{...args,owner:true}]){
  db.prepare('UPDATE tool_calls SET args=?').run(JSON.stringify(changed));
  assert.throws(()=>authority(intent,principal,identity),/effect_gate/);
 }
 db.prepare('UPDATE tool_calls SET args=?,state=?').run(JSON.stringify(args),'uncertain');
 assert.throws(()=>authority(intent,principal,identity),/effect_gate/);
 db.prepare('UPDATE tool_calls SET state=?').run('running');
 db.prepare("INSERT INTO tool_calls VALUES(?,?,?,?,?)").run('633:sibling',633,'running','read_file','{}');
 assert.throws(()=>authority(intent,principal,identity),/effect_gate/);
 db.exec('DELETE FROM tool_calls');
 assert.throws(()=>authority(intent,null),/owner_required/);
 assert.throws(()=>authority({...intent,checkpointRef:'shared/other'},principal),/checkpoint_binding/);
 status.pending={};assert.throws(()=>authority(intent,principal),/validated_target_required/);status.pending=null;
 for(const id of [undefined,'other-snapshot']){
  status.snapshot.id=id;
  assert.throws(()=>authority(intent,principal),/validated_target_required/);
 }
 status.snapshot.id='fixture';
 assert.equal(authority(intent,principal).leader.id,633);
 db.exec("INSERT INTO tool_calls VALUES('633:one',633,'uncertain',NULL,NULL)");
 assert.throws(()=>authority(intent,principal),/effect_gate/);
 db.exec('DELETE FROM tool_calls');
 for(const status of ['rejected','denied']){
  db.prepare('INSERT INTO approvals VALUES(1,633,?)').run(status);
  assert.throws(()=>authority(intent,principal),/approval_gate/);
  db.exec('DELETE FROM approvals');
 }
 db.exec("INSERT INTO tool_development_requests VALUES('hold',633,'needs_review')");
 assert.throws(()=>authority(intent,principal),/source_or_request_hold/);
 }finally{db.close();}
});
