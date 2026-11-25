import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createChildContext} from '../runtime/child-context.js';
import {createChildContextScope} from '../runtime/child-context-scope.js';
import {ensureDelegationScopeSchema} from '../runtime/delegation-scope.js';

function fixture(t){
 const db=new DatabaseSync(':memory:'),q=sql=>db.prepare(sql);t.after(()=>db.close());
 db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT,template TEXT,parent_bot_id INTEGER);
 INSERT INTO bots VALUES(22,'Root','orchestrator',NULL),(41,'Memory','orchestrator',22),(29,'Builder','builder',41),(42,'Skills','orchestrator',22);
 CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,parent_run INTEGER,depth INTEGER,thread TEXT,source TEXT,prompt TEXT,status TEXT,ended_at INTEGER,checkpoint TEXT,completion_required INTEGER);
 INSERT INTO runs VALUES(10,22,NULL,0,'bot:22','api','root','running',NULL,'{"messages":[]}',0),(11,41,10,1,'bot:41','Root','scope','running',NULL,'{"messages":[]}',1),(12,29,11,2,'bot:29','Memory','build','running',NULL,'{"messages":[]}',1),(13,42,10,1,'bot:42','Root','sibling','running',NULL,'{"messages":[]}',1);
 CREATE TABLE approvals(run_id INTEGER,status TEXT);CREATE TABLE tool_calls(run_id INTEGER,state TEXT);CREATE TABLE task_questions(run_id INTEGER,status TEXT);CREATE TABLE required_completion_bindings(run INTEGER,binding TEXT);
 CREATE TABLE project_lifecycle_owners(request_id TEXT,leader_run_id INTEGER,project TEXT,checkpoint_ref TEXT,request_fingerprint TEXT,revoked INTEGER);
 INSERT INTO project_lifecycle_owners VALUES('request',10,'migration','checkpoint','fingerprint',0);
 CREATE TABLE tool_development_stages(run_id INTEGER,request_id TEXT);CREATE TABLE tool_development_recoveries(task_id INTEGER,request_id TEXT);`);
 ensureDelegationScopeSchema(db);
 for(const [id,parent]of[[11,10],[12,11],[13,10]])q('INSERT INTO required_completion_bindings VALUES(?,?)').run(id,JSON.stringify({runId:id,parentRun:parent,contract:{scope:'fixture'}}));
 const owned=new Set([10,11,12,13]),protectedRuns=new Set(),policies=new Map([[10,{project:'migration',checkpoint_ref:'checkpoint',stopped:0}]]),authority={authorized:true,runId:10};
 const options={db,owned:id=>owned.has(id),protectedRun:id=>protectedRuns.has(id),resolveOwner:()=>authority,getContinuation:id=>policies.get(id)||null};
 const service=createChildContext({...options,scope:createChildContextScope(options)});
 return{db,q,owned,protectedRuns,policies,authority,service};
}
const caller={runId:11,botId:41},input={childRunId:12,requestId:'scoped-context',text:'Use the assigned installed baseline; this is context only.'};

test('real nested coordinator queues and consumes context once without acquiring lifecycle ownership',t=>{
 const s=fixture(t),owners=JSON.stringify(s.q('SELECT * FROM project_lifecycle_owners').all()),bindings=JSON.stringify(s.q('SELECT * FROM required_completion_bindings').all());
 const first=s.service.queue(caller,input);assert.equal(s.service.queue(caller,input).replayed,true);
 const state={messages:[]};assert.equal(s.service.consume(12,state).length,1);assert.equal(s.service.consume(12,state).length,0);assert.equal(state.childContextCursor,first.id);assert.match(state.messages[0].content,/non-authoritative/);
 assert.equal(JSON.stringify(s.q('SELECT * FROM project_lifecycle_owners').all()),owners);assert.equal(JSON.stringify(s.q('SELECT * FROM required_completion_bindings').all()),bindings);
 assert.throws(()=>s.service.queue({runId:13,botId:42},input),/directly owned/);
});

test('canonical root to scoped coordinator delivery still succeeds',t=>{
 const s=fixture(t),result=s.service.queue({runId:10,botId:22},{...input,childRunId:11});assert.equal(result.queued,true);const state={messages:[]};assert.equal(s.service.consume(11,state).length,1);
});

const holds={
 revoked:s=>{s.authority.authorized=false;},
 foreignOwner:s=>{s.authority.runId=99;},
 stopped:s=>{s.policies.get(10).stopped=1;},
 noProgress:s=>s.q('UPDATE runs SET checkpoint=? WHERE id=10').run('{"noProgress":true}'),
 refusal:s=>s.q('UPDATE runs SET checkpoint=? WHERE id=10').run('{"refusal":true}'),
 uncertain:s=>s.q("INSERT INTO tool_calls VALUES(10,'uncertain')").run(),
 pendingApproval:s=>s.q("INSERT INTO approvals VALUES(10,'pending')").run(),
 unowned:s=>s.owned.delete(10),
 protected:s=>s.protectedRuns.add(10),
 terminal:s=>s.q("UPDATE runs SET status='done',ended_at=1 WHERE id=10").run(),
 heldDomain:s=>s.q("INSERT INTO branch_host_domain_holds(kind,domain_key,preparation_id) VALUES('run','10','fixture')").run(),
 missingAncestor:s=>s.q('UPDATE runs SET parent_run=999 WHERE id=11').run(),
 wrongDepth:s=>s.q('UPDATE runs SET depth=9 WHERE id=10').run(),
 lifecycleParent:s=>s.q("UPDATE runs SET source='tool-development' WHERE id=11").run(),
 foreignChildRequest:s=>{s.q("INSERT INTO tool_development_stages VALUES(12,'foreign')").run();s.authority.runId=99;}
};
for(const [name,hold]of Object.entries(holds))for(const late of [false,true])test('nested context preserves '+name+' at '+(late?'consumption':'queue'),t=>{
 const s=fixture(t);if(late)s.service.queue(caller,input);hold(s);
 const before=JSON.stringify(s.q('SELECT * FROM child_context').all()),state={messages:[]};
 assert.throws(()=>late?s.service.consume(12,state):s.service.queue(caller,input));
 assert.equal(JSON.stringify(s.q('SELECT * FROM child_context').all()),before);assert.deepEqual(state,{messages:[]});
});

for(const change of ['prompt','binding','fingerprint'])test('queued context rejects changed ancestor '+change,t=>{
 const s=fixture(t);s.service.queue(caller,input);
 if(change==='prompt')s.q("UPDATE runs SET prompt='different assignment' WHERE id=10").run();
 if(change==='binding')s.q('UPDATE required_completion_bindings SET binding=? WHERE run=11').run(JSON.stringify({runId:11,parentRun:10,contract:{scope:'changed'}}));
 if(change==='fingerprint')s.q("UPDATE project_lifecycle_owners SET request_fingerprint='changed'").run();
 assert.throws(()=>s.service.consume(12,{messages:[]}),/provenance changed/);
});

test('a parentless task on a scoped profile does not impersonate the canonical root',t=>{
 const s=fixture(t);s.q('UPDATE runs SET parent_run=NULL,depth=0,completion_required=0 WHERE id=11').run();s.q('DELETE FROM required_completion_bindings WHERE run=11').run();s.q('UPDATE runs SET depth=1 WHERE id=12').run();
 assert.throws(()=>s.service.queue(caller,input),/Canonical coordinator root/);
});

const structuredHolds={
 returnedUncertainty:(s,id)=>s.q('INSERT INTO tool_calls VALUES(?,?,?)').run(id,'done',JSON.stringify({envelope:[{uncertain:true}]})),
 returnedDenial:(s,id)=>s.q('INSERT INTO tool_calls VALUES(?,?,?)').run(id,'error',JSON.stringify({denied:true,uncertain:false})),
 malformedFlag:(s,id)=>s.q('INSERT INTO tool_calls VALUES(?,?,?)').run(id,'done',JSON.stringify({envelope:{uncertain:'false'}})),
 malformedReceipt:(s,id)=>s.q('INSERT INTO tool_calls VALUES(?,?,?)').run(id,'done','{invalid'),
 checkpointUncertainty:(s,id)=>s.q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[],observation:{uncertain:true}}),id)
};
for(const [name,hold]of Object.entries(structuredHolds))for(const id of[10,11,12])for(const late of[false,true])test(name+' protects '+id+' at '+(late?'consume':'queue'),t=>{
 const s=fixture(t);s.db.exec('ALTER TABLE tool_calls ADD COLUMN result TEXT');
 if(late)s.service.queue(caller,input);hold(s,id);
 const before=JSON.stringify(s.q('SELECT * FROM child_context').all()),state={messages:[]};
 assert.throws(()=>late?s.service.consume(12,state):s.service.queue(caller,input),/hold/i);
 assert.equal(JSON.stringify(s.q('SELECT * FROM child_context').all()),before);assert.deepEqual(state,{messages:[]});
});

test('settled false flags and quoted prose do not manufacture an uncertainty hold',t=>{
 const s=fixture(t);s.db.exec('ALTER TABLE tool_calls ADD COLUMN result TEXT');
 for(const id of[10,11,12])s.q('INSERT INTO tool_calls VALUES(?,?,?)').run(id,'done',JSON.stringify({uncertain:false,denied:false,output:'Example text: {"uncertain":true}',nested:[{uncertain:false}]}));
 s.service.queue(caller,input);assert.equal(s.service.consume(12,{messages:[]}).length,1);
});

test('an active child effect may queue context but consumes only after its settled boundary',t=>{
 const s=fixture(t);s.db.exec('ALTER TABLE tool_calls ADD COLUMN result TEXT');
 s.q('INSERT INTO tool_calls VALUES(?,?,?)').run(12,'running',null);
 s.service.queue(caller,input);const state={messages:[]};assert.throws(()=>s.service.consume(12,state),/message boundary/);assert.deepEqual(state,{messages:[]});
 s.q('UPDATE tool_calls SET state=?,result=? WHERE run_id=12').run('done','{"uncertain":false}');
 assert.equal(s.service.consume(12,state).length,1);
});
