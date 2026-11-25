import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {ProjectContinuation} from '../runtime/project-continuation.js';
// Exercise actual runner resume function without importing its production singleton,
// providers, timers or database. All persistence here is an in-memory owned fixture.
const runner=fs.readFileSync(new URL('../runner.js',import.meta.url),'utf8');
const body=runner.slice(runner.indexOf('export function resumeRun('),runner.indexOf('export function stopRun(')).replace('export function','function');
assert.match(runner,/resume:resumeRun,owned:ownedRunIds/);
assert.ok(runner.includes('withheld:id=>{try{scopedDispatch(id);}catch{return true;}return projectSuccessorHandoffs.holdsLeader(id);}'));
assert.match(runner,/projectContinuation.pump\(\)/);
function fixture({held=false,owned=false,uncertain=false,childHold}={}){
 const db=new DatabaseSync(':memory:'),q=s=>db.prepare(s);
 db.exec("CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,status TEXT,prompt TEXT,source TEXT,parent_run INTEGER,actual_model TEXT,backend TEXT,checkpoint TEXT,ended_at INTEGER,last_error TEXT);CREATE TABLE run_context(id INTEGER PRIMARY KEY,run_id INTEGER,message_id INTEGER,prompt TEXT);CREATE TABLE messages(id INTEGER PRIMARY KEY,run_id INTEGER,author TEXT,kind TEXT);CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT);CREATE TABLE tool_calls(id INTEGER PRIMARY KEY,run_id INTEGER,state TEXT,name TEXT,args TEXT,result TEXT);");
 q("INSERT INTO bots VALUES(1,'orchestrator')").run();
 const state={messages:[],steps:9,providerRecovery:{code:'provider_inference_silence',model:'retained',backend:'codex',provider:'openai'},route:{tier:'sol'}};
 q("INSERT INTO runs(id,bot_id,status,prompt,source,actual_model,backend,checkpoint) VALUES(1,1,'paused','private fixture','api','retained','codex',?)").run(JSON.stringify(state));
 const child={messages:[],...(childHold?{[childHold]:true}:{})};
 q("INSERT INTO runs(id,bot_id,status,parent_run,checkpoint) VALUES(2,1,'paused',1,?)").run(JSON.stringify(child));
 if(uncertain)q("INSERT INTO tool_calls VALUES(1,1,'uncertain','fixture','{}','{}')").run();
 const dispatch=[],events=[];
 const checkpoint=(id,s)=>q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(s),id);
 const resume=new Function('q','projectSuccessorHandoffs','settleQuestionReceipts','pendingQuestionCall','reconcileCheckpoint','checkpoint','event','enqueue','redact','fs','path','DATA_DIR','randomUUID','scopedDispatch',body+';return resumeRun;')(q,{holdsLeader:()=>held},()=>{},()=>false,(_id,s)=>s,checkpoint,(...e)=>events.push(e),id=>dispatch.push(id),x=>x,{mkdirSync(){},writeFileSync(){}},{join:(...s)=>s.join('/')},'fixture',()=> 'fixture',id=>assert.equal(id,1));
 const continuation=new ProjectContinuation({db,query:q,resume,owned:new Set(owned?[1]:[]),event:(...e)=>events.push(e),withheld:()=>held});
 continuation.arm(1,{project:'integration',checkpointRef:'private/checkpoint.md',mode:'until_complete'});
 return {db,q,continuation,dispatch,events};
}
test('current runner dispatch resumes leader once with retained route and immutable child',()=>{
 const f=fixture();try{
 const child=JSON.stringify(f.q('SELECT * FROM runs WHERE id=2').get());
 assert.deepEqual(f.continuation.pump(),[1]);assert.deepEqual(f.dispatch,[1]);
 const leader=f.q('SELECT * FROM runs WHERE id=1').get(),s=JSON.parse(leader.checkpoint);
 assert.equal(leader.status,'queued');assert.equal(leader.actual_model,'retained');assert.equal(leader.backend,'codex');
 assert.equal(s.providerRecovery.model,'retained');assert.equal(s.resumeCount,1);
 assert.match(s.messages.at(-1).content,/never replay uncertain actions/);
 assert.equal(JSON.stringify(f.q('SELECT * FROM runs WHERE id=2').get()),child);
 assert.deepEqual(f.continuation.pump(),[]);assert.deepEqual(f.dispatch,[1]);
 }finally{f.db.close();}
});
for(const [name,options] of [['successor hold',{held:true}],['active owned leader',{owned:true}],['uncertain leader journal',{uncertain:true}],...['noProgress','refusal','explicitStop','hostDenied'].map(childHold=>['protected child '+childHold,{childHold}])])test(name+' prevents dispatch and checkpoint mutation',()=>{
 const f=fixture(options);try{
 const before=JSON.stringify(f.q('SELECT * FROM runs ORDER BY id').all());
 assert.deepEqual(f.continuation.pump(),[]);assert.deepEqual(f.dispatch,[]);
 assert.equal(JSON.stringify(f.q('SELECT * FROM runs ORDER BY id').all()),before);
 }finally{f.db.close();}
});
