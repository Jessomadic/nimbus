import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';
import {createChildContext,checkpointHeld} from '../runtime/child-context.js';
import {ensureDelegationScopeSchema} from '../runtime/delegation-scope.js';
const input={childRunId:11,text:'synthetic non-authoritative context',requestId:'one'},caller={runId:10,botId:22};
function setup(db){db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT);CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,parent_run INTEGER,depth INTEGER,thread TEXT,source TEXT,prompt TEXT,status TEXT,ended_at INTEGER,checkpoint TEXT,completion_required INTEGER);
CREATE TABLE approvals(run_id INTEGER,status TEXT);CREATE TABLE tool_calls(run_id INTEGER,state TEXT);CREATE TABLE task_questions(run_id INTEGER,status TEXT);CREATE TABLE required_completion_bindings(run INTEGER,binding TEXT);
INSERT INTO bots VALUES(22,'orchestrator'),(3,'reviewer');
INSERT INTO runs VALUES(10,22,NULL,0,'bot:22','api','parent','running',NULL,'{"messages":[]}',0);
INSERT INTO runs VALUES(11,3,10,1,'bot:3','Orchestrator','child','running',NULL,'{"messages":[]}',0);`);ensureDelegationScopeSchema(db);}
const service=(db,opts={})=>createChildContext({db,owned:id=>[10,11].includes(id),scope:()=>({owner:10}),...opts});
function fixture(fn){const db=new DatabaseSync(':memory:');try{setup(db);fn(db,service(db));}finally{db.close();}}
const snapshot=db=>JSON.stringify(['runs','child_context','required_completion_bindings'].map(t=>db.prepare('SELECT * FROM '+t).all()));
for(const who of [10,11])test('NEW late-arrival hold '+who+' survives SQLite restart and idempotent cursor',()=>{
 const dir=fs.mkdtempSync(path.join(import.meta.dirname,'sqlite-'));const file=path.join(dir,'isolated.sqlite');let db;
 try{db=new DatabaseSync(file);setup(db);let s=service(db);
 const first=s.queue(caller,input);assert.equal(s.queue(caller,input).replayed,true);
 db.prepare('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[],refusal:true}),who);
 const before=snapshot(db),state={messages:[]};assert.throws(()=>s.consume(11,state),/hold/);assert.equal(snapshot(db),before);assert.deepEqual(state,{messages:[]});
 db.close();db=new DatabaseSync(file);s=service(db);
 assert.throws(()=>s.queue(caller,input),/hold/);assert.throws(()=>s.consume(11,state),/hold/);assert.equal(snapshot(db),before);
 // Remove synthetic hold only in our owned isolated fixture; never a real run.
 db.prepare('UPDATE runs SET checkpoint=? WHERE id=?').run('{"messages":[]}',who);
 assert.equal(s.consume(11,state).length,1);assert.equal(state.childContextCursor,first.id);assert.equal(state.messages.length,1);
 db.close();db=new DatabaseSync(file);s=service(db);const restored=JSON.parse(db.prepare('SELECT checkpoint FROM runs WHERE id=11').get().checkpoint);
 assert.equal(s.queue(caller,input).replayed,true);assert.equal(s.consume(11,restored).length,0);assert.equal(restored.messages.length,1);assert.equal(restored.childContextCursor,first.id);
 }finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}
});
for(const flag of ['hostDenied','refusal','explicitStop','noProgress','awaitingToolRequest','projectLimit'])for(const who of [10,11])for(const late of [false,true])test(flag+' '+who+' '+(late?'late consume':'queue'),()=>fixture((db,s)=>{
 if(late)s.queue(caller,input);
 db.prepare('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[],[flag]:true}),who);
 const before=snapshot(db),state={messages:[]};assert.throws(()=>late?s.consume(11,state):s.queue(caller,input),/hold/);assert.equal(snapshot(db),before);assert.deepEqual(state,{messages:[]});
}));
test('fail closed invalid checkpoint predicate',()=>{for(const v of [null,undefined,[],false,1,'{}'])assert.equal(checkpointHeld(v),true);assert.equal(checkpointHeld({messages:[]}),false);});
test('actual schema NOT NULL CHECK immutable trigger',()=>fixture(db=>{
 const c=db.prepare('PRAGMA table_info(runs)').all().find(x=>x.name==='delegation_scope');assert.equal(c.notnull,1);
 assert.throws(()=>db.exec("UPDATE runs SET delegation_scope='execution' WHERE id=11"),/immutable/);
 assert.throws(()=>db.exec("INSERT INTO runs(id,delegation_scope) VALUES(12,NULL)"),/NOT NULL/);
 assert.throws(()=>db.exec("INSERT INTO runs(id,delegation_scope) VALUES(12,'bogus')"),/CHECK/);
 assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='delegation_scope_no_update'").get().sql.includes('RAISE'));
}));
const blockers={
 foreign:db=>db.exec('UPDATE runs SET parent_run=99 WHERE id=11'),
 terminal:db=>db.exec("UPDATE runs SET status='done',ended_at=1 WHERE id=11"),
 paused:db=>db.exec("UPDATE runs SET status='paused' WHERE id=11"),
 uncertain:db=>db.exec("INSERT INTO tool_calls VALUES(11,'uncertain')"),
 denied:db=>db.exec("INSERT INTO approvals VALUES(10,'denied')"),
 pendingQuestion:db=>db.exec("INSERT INTO task_questions VALUES(11,'pending')"),
 malformed:db=>db.exec("UPDATE runs SET checkpoint='null' WHERE id=10"),
 binding:db=>db.exec("UPDATE runs SET completion_required=1 WHERE id=11"),
};
for(const [name,mutate]of Object.entries(blockers))for(const late of [false,true])test(name+' '+(late?'consume':'queue')+' no mutations',()=>fixture((db,s)=>{
 if(late)s.queue(caller,input);mutate(db);const before=snapshot(db),state={messages:[]};assert.throws(()=>late?s.consume(11,state):s.queue(caller,input));assert.equal(snapshot(db),before);assert.deepEqual(state,{messages:[]});
}));
test('ownership, protection and missing scope fail closed',()=>fixture(db=>{for(const options of [{owned:()=>false},{protectedRun:()=>true},{scope:()=>null}]){const s=service(db,options),before=snapshot(db);assert.throws(()=>s.queue(caller,input));assert.equal(snapshot(db),before);}}));
test('provenance binding change after queue is held without editing binding',()=>fixture((db,s)=>{
 db.exec("UPDATE runs SET completion_required=1 WHERE id=11");db.prepare('INSERT INTO required_completion_bindings VALUES(11,?)').run(JSON.stringify({runId:11,parentRun:10,epoch:1}));
 s.queue(caller,input);db.prepare('UPDATE required_completion_bindings SET binding=?').run(JSON.stringify({runId:11,parentRun:10,epoch:2}));
 const before=snapshot(db);assert.throws(()=>s.consume(11,{messages:[]}),/provenance/);assert.equal(snapshot(db),before);
}));
