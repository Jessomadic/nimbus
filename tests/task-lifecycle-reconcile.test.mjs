import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createLifecycleReconciler,validateArguments} from '../runtime/task-lifecycle-reconcile.js';
import {execute,tools,roleTools} from '../runtime/toolsets/generated/task_lifecycle_reconcile.js';
function fixture() {
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,checkpoint TEXT,last_error TEXT,ended_at INTEGER); CREATE TABLE task_events(id INTEGER PRIMARY KEY,run_id INTEGER,type TEXT,body TEXT,created_at INTEGER); CREATE TABLE tool_calls(id TEXT,run_id INTEGER,name TEXT,state TEXT,result TEXT); INSERT INTO runs VALUES(1,'running','retain',NULL,NULL),(2,'queued','retain',NULL,NULL);");
 let unknown=false,owned=false;
 const service=createLifecycleReconciler({db,query:s=>db.prepare(s),boot:()=>({pid:1,sourceHash:'fixture',ownershipEpoch:0}),ownership:()=>Object.fromEntries(['controller','queue','provider','terminal','continuation','developmentOwner'].map(k=>[k,{state:unknown?'unknown':owned?'owned':'absent',source:'isolated fixture registry'}]))});
 return {db,service,setUnknown:()=>unknown=true,setOwned:()=>owned=true};
}
test('schema and orchestrator-only adapter fail closed without host authority',()=>{
 assert.equal(tools[0].function.name,'task_lifecycle_reconcile');
 assert.equal(tools[0].function.parameters.additionalProperties,false);
 assert.deepEqual(Object.keys(roleTools),['orchestrator']);
 assert.throws(()=>execute('task_lifecycle_reconcile',{action:'preview',runIds:[1]}),/unavailable/);
 for(const args of [{action:'preview',runIds:[1,1]},{action:'preview',runIds:[1],force:true},{action:'reconcile',runIds:[1]},{action:'preview',runIds:[1],reason:'x'}])assert.throws(()=>validateArguments(args));
});
test('preview is read-only; explicit orphan becomes interrupted with retained checkpoint',()=>{
 const f=fixture();try{
 const before=JSON.stringify(f.db.prepare('SELECT * FROM runs').all());
 const p=f.service({action:'preview',runIds:[1]},{runId:99});
 assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM runs').all()),before);
 assert.equal(f.db.prepare('SELECT count(*) n FROM task_events').get().n,0);
 assert.equal(p.rows[0].eligible,true);
 const result=f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'verified orphan'},{runId:99});
 assert.equal(result.applied,true);
 assert.equal(f.db.prepare('SELECT status FROM runs WHERE id=1').get().status,'interrupted');
 assert.equal(f.db.prepare('SELECT checkpoint FROM runs WHERE id=1').get().checkpoint,'retain');
 assert.equal(f.db.prepare('SELECT status FROM runs WHERE id=2').get().status,'queued');
 assert.equal(f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'retry'},{runId:99}).applied,false);
 }finally{f.db.close();}
});
test('unknown, live, current caller and queued remain protected',()=>{
 for(const kind of ['unknown','live','caller','queued']) {
 const f=fixture();try{
 if(kind==='unknown')f.setUnknown();if(kind==='live')f.setOwned();
 const caller={runId:kind==='caller'?1:99},runIds=[kind==='queued'?2:1];
 const p=f.service({action:'preview',runIds},caller);
 assert.equal(p.rows[0].eligible,false);
 assert.equal(f.service({action:'reconcile',runIds,previewToken:p.previewToken,reason:'test'},caller).applied,false);
 }finally{f.db.close();}
 }
});
test('uncertain effects retained; durable drift and audit failure reject atomically',()=>{
 const f=fixture();try{
 f.db.exec("INSERT INTO tool_calls VALUES('uncertain',1,'external_send','uncertain','retained')");
 let p=f.service({action:'preview',runIds:[1]});
 f.db.exec("UPDATE runs SET checkpoint='changed' WHERE id=1");
 assert.equal(f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'test'}).applied,false);
 p=f.service({action:'preview',runIds:[1]});
 f.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON task_events BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
 assert.throws(()=>f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'test'}),/audit failure/);
 assert.equal(f.db.prepare('SELECT status FROM runs WHERE id=1').get().status,'running');
 f.db.exec('DROP TRIGGER reject_audit');
 assert.equal(f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'test'}).rows[0].after,'needs_review');
 assert.equal(f.db.prepare('SELECT result FROM tool_calls').get().result,'retained');
 }finally{f.db.close();}
});
