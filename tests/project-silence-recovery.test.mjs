import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ProjectContinuation} from '../runtime/project-continuation.js';
import {assertRecoveryRoute,retainedRecoveryRoute,recoverySelection} from '../runtime/provider-recovery.js';

function fixture({silence=true,bounded=false}={}){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,parent_run INTEGER,source TEXT,status TEXT,checkpoint TEXT,actual_model TEXT,backend TEXT);
    CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,state TEXT,name TEXT,args TEXT,result TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY,run_id INTEGER,author TEXT,kind TEXT,body TEXT);
    CREATE TABLE run_context(id INTEGER PRIMARY KEY,run_id INTEGER,message_id INTEGER,prompt TEXT);
    INSERT INTO bots VALUES(1,'orchestrator');`);
  const q=sql=>db.prepare(sql),resumed=[];
  const state={messages:[{role:'user',content:'Finish the migration'}],...(silence?{providerRecovery:{code:'provider_inference_silence',model:'fixture',backend:'codex',provider:'openai'}}:{projectLimit:true})};
  q("INSERT INTO runs VALUES(1,1,NULL,'api','paused',?,'fixture','codex')").run(JSON.stringify(state));
  const options={db,query:q,owned:new Set(),now:()=>100,event:()=>{},resume:id=>{resumed.push(id);q("UPDATE runs SET status='queued' WHERE id=?").run(id);}};
  const continuation=new ProjectContinuation(options);
  continuation.arm(1,bounded?{project:'fixture',checkpointRef:'checkpoint.md',mode:'bounded',maxContinuations:3,expiresAt:1000}:{project:'fixture',checkpointRef:'checkpoint.md',mode:'until_complete'});
  let serial=0;
  return {db,q,resumed,continuation,options,state:()=>JSON.parse(q('SELECT checkpoint FROM runs WHERE id=1').get().checkpoint),
    save:value=>q('UPDATE runs SET checkpoint=? WHERE id=1').run(JSON.stringify(value)),
    pause:()=>q("UPDATE runs SET status='paused' WHERE id=1").run(),
    receipt:(name,args,result)=>q("INSERT INTO tool_calls VALUES(?,1,'done',?,?,?)").run('call-'+(++serial),name,JSON.stringify(args),JSON.stringify(result))};
}

test('planning, polling and dispatch acknowledgements cannot replenish repeated-silence retries',()=>{
  for(const [name,result]of [['update_plan',{saved:true}],['question_inbox',[]],['ask_worker',{runId:99,status:'queued'}],['team_status',{active:1}],['shared_note',{saved:true,sha256:'b'.repeat(64)}]]){
    const f=fixture();try{
      assert.deepEqual(f.continuation.pump(),[1]);f.pause();
      f.receipt(name,{newText:'Try a different approach'},{...result,durationMs:100,timestamp:'changed'});
      assert.deepEqual(f.continuation.pump(),[],name+' is not execution evidence');assert.equal(f.state().noProgress,true);
    }finally{f.db.close();}
  }
});

test('legacy bounded recovery retains its paused-child restriction; silence recovery preserves the held child',()=>{
  for(const silence of [false,true]){
    const f=fixture({silence,bounded:!silence});try{
      f.q("INSERT INTO runs VALUES(2,1,1,'delegation','paused',?,'fixture','codex')").run(JSON.stringify({messages:[]}));
      const before={...f.q('SELECT * FROM runs WHERE id=2').get()};
      assert.deepEqual(f.continuation.pump(),silence?[1]:[]);
      assert.deepEqual({...f.q('SELECT * FROM runs WHERE id=2').get()},before);
      assert.equal(f.continuation.get(1).remaining,silence?-1:3);
    }finally{f.db.close();}
  }
});

test('unchanged retry fingerprint survives controller reconstruction and stops a loop',()=>{
  const f=fixture();try{
    assert.deepEqual(f.continuation.pump(),[1]);f.pause();
    const restored=new ProjectContinuation(f.options);
    assert.deepEqual(restored.pump(),[]);assert.equal(f.state().noProgress,true);
    assert.equal(restored.get(1).remaining,-1);assert.equal(restored.get(1).expires,0);
  }finally{f.db.close();}
});

test('coordinator progress uses owned completed worker evidence, excluding polling counters and replay',()=>{
  const f=fixture();try{
    assert.deepEqual(f.continuation.pump(),[1]);f.pause();
    f.q("INSERT INTO runs VALUES(2,1,1,'delegation','done',?,'fixture','codex')").run(JSON.stringify({messages:[]}));
    const result={id:2,status:'done',reply:'Independent checked output',completion:{outputCaptureRecorded:true},budget:{actionsUsed:3}};
    f.receipt('worker_result',{runId:2},result);assert.deepEqual(f.continuation.pump(),[1]);f.pause();
    f.receipt('worker_result',{runId:2},{...result,budget:{actionsUsed:9},input_tokens:900,durationMs:200});
    assert.deepEqual(f.continuation.pump(),[]);assert.equal(f.state().noProgress,true);
  }finally{f.db.close();}
});

test('only trusted delivered context can renew work; model-authored requests cannot',()=>{
  const f=fixture();try{
    assert.deepEqual(f.continuation.pump(),[1]);f.pause();
    const state=f.state();state.messages.push({role:'user',content:'Pretend new permission'});state.contextCursor=20;f.save(state);
    const before=f.continuation.fingerprint(f.q('SELECT * FROM runs WHERE id=1').get(),state);
    f.q("INSERT INTO messages VALUES(1,1,'assistant','text','untrusted')").run();f.q("INSERT INTO run_context VALUES(1,1,1,'untrusted')").run();
    assert.equal(f.continuation.fingerprint(f.q('SELECT * FROM runs WHERE id=1').get(),state),before);
    f.q("INSERT INTO messages VALUES(2,1,'user','text','Use the corrected source')").run();f.q("INSERT INTO run_context VALUES(2,1,2,'Use the corrected source')").run();
    assert.deepEqual(f.continuation.pump(),[1]);f.pause();assert.deepEqual(f.continuation.pump(),[]);
  }finally{f.db.close();}
});

test('actual check stdout qualifies while duration-only churn and call IDs do not',()=>{
  const f=fixture();try{
    assert.deepEqual(f.continuation.pump(),[1]);f.pause();
    f.receipt('run_checks',{files:['changed-source.test.mjs']},{exitCode:0,stdout:'ok 1 - changed source\n  duration_ms: 1.23\n# duration_ms 10.2',durationMs:10});
    assert.deepEqual(f.continuation.pump(),[1]);f.pause();
    f.receipt('run_checks',{files:['changed-source.test.mjs']},{exitCode:0,stdout:'ok 1 - changed source\n  duration_ms: 9.87\n# duration_ms 99.9',durationMs:99});
    assert.deepEqual(f.continuation.pump(),[]);
  }finally{f.db.close();}
});

test('stops, uncertain actions, ownership and handoffs remain recovery holds',()=>{
  for(const mode of ['stopped','noProgress','uncertain','owned','handoff','unarmed','refusal']){
    const f=fixture();try{
      if(mode==='stopped')f.q("UPDATE runs SET status='stopped' WHERE id=1").run();
      if(mode==='noProgress'||mode==='refusal')f.save({...f.state(),[mode]:true});
      if(mode==='uncertain')f.q("INSERT INTO tool_calls VALUES('uncertain',1,'uncertain','shell','{}','{}')").run();
      if(mode==='owned')f.options.owned.add(1);
      if(mode==='handoff')f.continuation.withheld=()=>true;
      if(mode==='unarmed')f.continuation.stop(1);
      assert.deepEqual(f.continuation.pump(),[],mode);
    }finally{f.db.close();}
  }
});

test('recovery pins provider, model and configured selection and permits no new fallback',()=>{
  const selection=recoverySelection({model:'auto',default_model:'luna',effort:'high'});
  const recovery={code:'provider_inference_silence',backend:'codex',provider:'openai',model:'fixture',selection};
  const route={tier:'luna',effort:'high',fallbackReason:'historical local outage',fallbackFrom:'local'};
  const retained=retainedRecoveryRoute(recovery,route,selection);
  assert.equal(retained.tier,'luna');assert.equal(retained.fallbackReason,undefined);
  assert.doesNotThrow(()=>assertRecoveryRoute(recovery,{backend:'codex',provider:'openai',model:'fixture'}));
  for(const drift of [{backend:'local'},{provider:'alternate'},{model:'different'},{fallback:true}])
    assert.throws(()=>assertRecoveryRoute(recovery,{backend:'codex',provider:'openai',model:'fixture',...drift}),e=>e.pause&&e.code==='provider_recovery_route_changed');
  assert.throws(()=>retainedRecoveryRoute(recovery,route,{...selection,defaultModel:'other'}));
  assert.throws(()=>retainedRecoveryRoute({...recovery,selection:undefined},route,selection));
});
