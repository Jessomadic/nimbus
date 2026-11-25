import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ProjectContinuation} from '../runtime/project-continuation.js';
import {ProjectLifecycleOwnership} from '../runtime/project-lifecycle.js';

function fixture(){
  const db=new DatabaseSync(':memory:'),query=sql=>db.prepare(sql),events=[];
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,parent_run INTEGER,source TEXT,status TEXT,checkpoint TEXT);
    CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT);
    CREATE TABLE approvals(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);
    CREATE TABLE tool_development_requests(id TEXT PRIMARY KEY,origin_run_id INTEGER,requester_run_id INTEGER,origin_json TEXT,fingerprint TEXT,status TEXT);
    CREATE TABLE tool_development_stages(request_id TEXT,run_id INTEGER,phase TEXT);
    CREATE TABLE tool_development_watchers(request_id TEXT,run_id INTEGER,bot_id INTEGER,thread TEXT,consumer INTEGER DEFAULT 0,cancelled INTEGER DEFAULT 0,PRIMARY KEY(request_id,run_id));
    INSERT INTO bots VALUES(22,'orchestrator'),(2,'builder');`);
  const checkpoint=JSON.stringify({messages:[{role:'user',content:'retained'}],awaitingToolRequest:'different-request'});
  for(const [run,bot,status] of [[1,22,'done'],[2,2,'done'],[10,22,'running'],[11,22,'running'],[12,2,'running']])query('INSERT INTO runs VALUES(?,?,?,NULL,?,?,?)').run(run,bot,'bot:'+bot,'user',status,checkpoint);
  query('INSERT INTO tool_development_requests VALUES(?,?,?,?,?,?)').run('request-a',1,1,'{"historic":true}','fingerprint-a','blocked');
  query('INSERT INTO tool_development_stages VALUES(?,?,?)').run('request-a',2,'building');
  query('INSERT INTO tool_development_watchers VALUES(?,?,?,?,1,0)').run('request-a',1,22,'bot:22');
  const continuation=new ProjectContinuation({db,query,resume:()=>assert.fail('must not resume'),owned:new Set(),event:()=>{}});
  for(const run of [10,11])continuation.arm(run,{project:'fixture',checkpointRef:'fixture/current.md',mode:'until_complete'});
  const options={db,query,continuation,event:(...args)=>events.push(args)};
  const owners=new ProjectLifecycleOwnership(options),host={authenticated:true,principal:'fixture-owner'};
  const adopt=(overrides={},auth=host)=>owners.adopt('request-a',{leaderRunId:10,project:'fixture',reason:'Review retained candidate with current project leader',...overrides},auth);
  return {db,query,continuation,owners,host,adopt,events,options,checkpoint};
}

test('owner adoption survives restart, preserves origin/checkpoints, and scopes the facade to exact leader',()=>{
  const s=fixture();try{
    const original=s.query('SELECT * FROM tool_development_requests').get(),checkpoint=s.query('SELECT checkpoint FROM runs WHERE id=10').get().checkpoint;
    const adopted=s.adopt();assert.equal(adopted.id,10);assert.equal(adopted.replayed,false);
    assert.deepEqual(s.query('SELECT * FROM tool_development_requests').get(),original);
    assert.equal(s.query('SELECT checkpoint FROM runs WHERE id=10').get().checkpoint,checkpoint);
    assert.equal(s.query('SELECT consumer FROM tool_development_watchers WHERE run_id=10').get().consumer,1);
    const restored=new ProjectLifecycleOwnership(s.options);
    assert.equal(restored.assertOwned('request-a',{runId:10,botId:22}).id,10);
    assert.equal(restored.recoveryOwner('request-a').authorized,true);
    assert.equal(restored.recoveryOwner('never-adopted'),null);
    assert.throws(()=>restored.assertOwned('request-a',{runId:11,botId:22}),/another project leader/);
    assert.throws(()=>restored.assertOwned('request-a',{runId:10,botId:2}),/context/);
    assert.equal(s.adopt().replayed,true);assert.equal(s.query('SELECT count(*) n FROM project_lifecycle_owner_events').get().n,1);
  }finally{s.db.close();}
});

test('adoption rejects unauthenticated, foreign-project, unarmed, terminal and unsafe leaders',()=>{
  for(const gate of ['anonymous','foreignProject','unarmed','stoppedPolicy','done','stopped','error','needs_review','child','wrongBot','malformed','noProgress','uncertain','running','denied']){
    const s=fixture();try{
      let overrides={},auth=s.host;
      if(gate==='anonymous')auth={authenticated:false,principal:'owner'};
      if(gate==='foreignProject')overrides={project:'foreign'};
      if(gate==='unarmed')s.query('DELETE FROM project_continuations WHERE run_id=10').run();
      if(gate==='stoppedPolicy')s.continuation.stop(10);
      if(['done','stopped','error','needs_review'].includes(gate))s.query('UPDATE runs SET status=? WHERE id=10').run(gate);
      if(gate==='child')s.query('UPDATE runs SET parent_run=1 WHERE id=10').run();
      if(gate==='wrongBot')s.query('UPDATE runs SET bot_id=2 WHERE id=10').run();
      if(gate==='malformed')s.query('UPDATE runs SET checkpoint=? WHERE id=10').run('{');
      if(gate==='noProgress')s.query('UPDATE runs SET checkpoint=? WHERE id=10').run(JSON.stringify({messages:[],noProgress:{reason:'loop'}}));
      if(['uncertain','running'].includes(gate))s.query('INSERT INTO tool_calls VALUES(?,?,?,?)').run('10:previous',10,'shell',gate);
      if(gate==='denied')s.query('INSERT INTO approvals VALUES(1,10,?)').run('rejected');
      assert.throws(()=>s.adopt(overrides,auth),undefined,gate);
      assert.equal(s.owners.get('request-a'),null,gate);assert.equal(s.query('SELECT count(*) n FROM project_lifecycle_owner_events').get().n,0);
    }finally{s.db.close();}
  }
});

test('worker recovery ignores only its exact currently journaled project_recovery call',()=>{
  const s=fixture();try{
    s.adopt();s.query('INSERT INTO tool_calls VALUES(?,?,?,?)').run('10:current',10,'project_recovery','running');
    assert.equal(s.owners.assertOwned('request-a',{runId:10,botId:22,requestKey:'10:current'}).id,10);
    assert.throws(()=>s.owners.assertOwned('request-a',{runId:10,botId:22,requestKey:'10:other'}),/running or uncertain/);
    s.query("UPDATE tool_calls SET name='shell'").run();
    assert.throws(()=>s.owners.assertOwned('request-a',{runId:10,botId:22,requestKey:'10:current'}),/running or uncertain/);
    s.query("UPDATE tool_calls SET name='project_recovery',state='uncertain'").run();
    assert.throws(()=>s.owners.assertOwned('request-a',{runId:10,botId:22,requestKey:'10:current'}),/running or uncertain/);
    assert.equal(s.owners.recoveryOwner('request-a').authorized,false);
  }finally{s.db.close();}
});

test('ownership survives passive leader collection while recovery dispatch waits for unrelated running calls',()=>{
  for(const name of ['shell','exec_command','self_update','worker_result','tool_request_status']){
    const s=fixture();try{
      s.adopt();s.query('INSERT INTO tool_calls VALUES(?,?,?,?)').run('10:active',10,name,'running');
      const owner=s.owners.recoveryOwner('request-a');assert.equal(owner.authorized,true,name);assert.equal(owner.dispatchSafe,false,name);
      assert.throws(()=>s.owners.assertOwned('request-a',{runId:10,botId:22}),/running or uncertain/);
      s.query("UPDATE tool_calls SET state='done'").run();assert.equal(s.owners.recoveryOwner('request-a').dispatchSafe,true,name);
    }finally{s.db.close();}
  }
});

test('dispatch safety exempts exactly one running recovery call and no uncertain or overlapping effect',()=>{
  const s=fixture();try{
    s.adopt();s.query("INSERT INTO tool_calls VALUES('10:current',10,'project_recovery','running')").run();assert.equal(s.owners.recoveryOwner('request-a').dispatchSafe,true);
    s.query("INSERT INTO tool_calls VALUES('10:other',10,'shell','running')").run();assert.equal(s.owners.recoveryOwner('request-a').dispatchSafe,false);
    s.query("UPDATE tool_calls SET name='project_recovery' WHERE id='10:other'").run();assert.equal(s.owners.recoveryOwner('request-a').dispatchSafe,false);
    s.query("DELETE FROM tool_calls WHERE id='10:other'").run();s.query("UPDATE tool_calls SET state='uncertain'").run();assert.equal(s.owners.recoveryOwner('request-a').authorized,false);
  }finally{s.db.close();}
});

test('a journaled recovery call awaiting approval cannot authorize automatic dispatch',()=>{
  const s=fixture();try{
    s.adopt();s.query("INSERT INTO tool_calls VALUES('10:current',10,'project_recovery','running')").run();s.query("INSERT INTO approvals VALUES(1,10,'pending')").run();s.query("UPDATE runs SET status='waiting_approval' WHERE id=10").run();
    const pending=s.owners.recoveryOwner('request-a');assert.equal(pending.authorized,true);assert.equal(pending.dispatchSafe,false);
    s.query("UPDATE approvals SET status='approved'").run();s.query("UPDATE runs SET status='running' WHERE id=10").run();assert.equal(s.owners.recoveryOwner('request-a').dispatchSafe,true);
  }finally{s.db.close();}
});

test('owner cancellation, scope drift and terminal state revoke effective permission without historical fallback',()=>{
  for(const gate of ['policyStop','ownerRevoke','requestCancel','fingerprint','checkpoint','done','loop']){
    const s=fixture();try{
      s.adopt();
      if(gate==='policyStop')s.continuation.stop(10);
      if(gate==='ownerRevoke')s.owners.revoke('request-a',{reason:'Owner withdraws recovery authority'},s.host);
      if(gate==='requestCancel')s.query("UPDATE tool_development_requests SET status='cancelled'").run();
      if(gate==='fingerprint')s.query("UPDATE tool_development_requests SET fingerprint='changed'").run();
      if(gate==='checkpoint')s.query("UPDATE project_continuations SET checkpoint_ref='fixture/other.md' WHERE run_id=10").run();
      if(gate==='done')s.query("UPDATE runs SET status='done' WHERE id=10").run();
      if(gate==='loop')s.query('UPDATE runs SET checkpoint=? WHERE id=10').run('{"messages":[],"noProgress":true}');
      assert.throws(()=>s.owners.assertOwned('request-a',{runId:10,botId:22}),undefined,gate);
      assert.equal(s.owners.recoveryOwner('request-a').adopted,true,gate);assert.equal(s.owners.recoveryOwner('request-a').authorized,false,gate);
    }finally{s.db.close();}
  }
});

test('adoption retains stage uncertainty and active lifecycle gates',()=>{
  for(const gate of ['activeRequest','cancelledRequest','runningStage','uncertainStage','loopStage','missingStage']){
    const s=fixture();try{
      if(gate==='activeRequest')s.query("UPDATE tool_development_requests SET status='building'").run();
      if(gate==='cancelledRequest')s.query("UPDATE tool_development_requests SET status='cancelled'").run();
      if(gate==='runningStage')s.query("UPDATE runs SET status='running' WHERE id=2").run();
      if(gate==='uncertainStage')s.query("INSERT INTO tool_calls VALUES('2:old',2,'shell','uncertain')").run();
      if(gate==='loopStage')s.query('UPDATE runs SET checkpoint=? WHERE id=2').run('{"messages":[],"noProgress":true}');
      if(gate==='missingStage')s.query('DELETE FROM runs WHERE id=2').run();
      assert.throws(()=>s.adopt(),undefined,gate);assert.equal(s.owners.get('request-a'),null);
    }finally{s.db.close();}
  }
});

test('explicit successor adoption rejects competing leaders and retains auditable history',()=>{
  const s=fixture();try{
    s.adopt();assert.throws(()=>s.adopt({leaderRunId:11}),/Another active/);
    s.query("UPDATE runs SET status='done' WHERE id=10").run();
    const owner=s.adopt({leaderRunId:11,reason:'Continue after completed prior leader handoff'});assert.equal(owner.leader_run_id,11);
    assert.equal(s.query('SELECT cancelled FROM tool_development_watchers WHERE run_id=10').get().cancelled,1);
    assert.equal(s.query('SELECT consumer FROM tool_development_watchers WHERE run_id=11').get().consumer,1);
    const history=s.query('SELECT * FROM project_lifecycle_owner_events ORDER BY id').all();assert.equal(history.length,2);assert.equal(history[1].previous_leader_run_id,10);
    assert.equal(s.query('SELECT origin_run_id,requester_run_id FROM tool_development_requests').get().origin_run_id,1);
    assert.equal(s.query('SELECT checkpoint FROM runs WHERE id=11').get().checkpoint,s.checkpoint);
  }finally{s.db.close();}
});

test('failed adoption rolls back association, consumer watch and audit atomically',()=>{
  const s=fixture();try{
    s.owners.event=()=>{throw new Error('fixture audit event failed');};
    assert.throws(()=>s.adopt(),/audit event failed/);
    assert.equal(s.owners.get('request-a'),null);assert.equal(s.query('SELECT count(*) n FROM tool_development_watchers WHERE run_id=10').get().n,0);
    assert.equal(s.query('SELECT count(*) n FROM project_lifecycle_owner_events').get().n,0);
  }finally{s.db.close();}
});

test('checkpoint references reject traversal/absolute paths while retaining ordinary relative references',()=>{
  const s=fixture();try{
    s.query('DELETE FROM project_continuations WHERE run_id=11').run();
    for(const checkpointRef of ['../outside.md','/absolute.md','C:\\outside.md','fixture/../outside.md','fixture//empty.md','fixture\u0000.md']){
      assert.throws(()=>s.continuation.arm(11,{project:'fixture',checkpointRef,mode:'until_complete'}),/safe checkpoint/);
      assert.equal(s.continuation.get(11),null);
    }
    s.continuation.arm(11,{project:'fixture',checkpointRef:'ordinary.md',mode:'until_complete'});
    assert.equal(s.continuation.requireUntilComplete(11,'fixture').checkpoint_ref,'ordinary.md');
    assert.equal(s.continuation.requireUntilComplete(10,'fixture').checkpoint_ref,'fixture/current.md');
  }finally{s.db.close();}
});
