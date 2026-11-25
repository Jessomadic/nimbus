import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createLifecycleReconciler} from '../runtime/task-lifecycle-reconcile.js';
function fixture(boot=()=>({pid:1,sourceHash:'fixture',ownershipEpoch:0})){
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,last_error TEXT,ended_at INTEGER);CREATE TABLE task_events(id INTEGER PRIMARY KEY,run_id INTEGER,type TEXT,body TEXT,created_at INTEGER);CREATE TABLE tool_calls(id TEXT,run_id INTEGER,name TEXT,state TEXT,result TEXT);INSERT INTO runs VALUES(1,'running',NULL,NULL);INSERT INTO task_events VALUES(1,1,'fixture','before',1);INSERT INTO tool_calls VALUES('a',1,'fixture','done','before');");
 const service=createLifecycleReconciler({db,query:s=>db.prepare(s),boot,ownership:()=>Object.fromEntries(['controller','queue','provider','terminal','continuation','developmentOwner'].map(k=>[k,{state:'absent',source:'fixture'}]))});return {db,service};
}
test('incomplete boot identity cannot establish absence',()=>{for(const boot of [()=>({}),()=>({pid:1,sourceHash:'x'}),()=>({pid:1,sourceHash:'x',ownershipEpoch:-1})]){const f=fixture(boot);try{assert.equal(f.service({action:'preview',runIds:[1]}).rows[0].eligible,false);}finally{f.db.close();}}});
test('event body and completed result drift invalidate preview without writes',()=>{for(const sql of ["UPDATE task_events SET body='after'","UPDATE tool_calls SET result='after'"]){const f=fixture();try{const p=f.service({action:'preview',runIds:[1]});f.db.exec(sql);assert.equal(f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'fixture'}).reasonCode,'state_changed');assert.equal(f.db.prepare('SELECT status FROM runs').get().status,'running');}finally{f.db.close();}}});

test('complete streamed histories bind mutations outside the old display windows',()=>{
 for(const domain of ['events','tools']){
  const f=fixture();try{
   for(let i=2;i<=250;i++){f.db.prepare('INSERT INTO task_events VALUES(?,?,?,?,?)').run(i,1,'fixture','body '+i,i);f.db.prepare('INSERT INTO tool_calls VALUES(?,?,?,?,?)').run('z'+String(i).padStart(4,'0'),1,'fixture','done','body '+i);}
   const before=f.service({action:'preview',runIds:[1]});assert.equal(before.rows[0].eligible,true);assert.equal(before.rows[0].lastEvents.length,10);
   if(domain==='events')f.db.exec("UPDATE task_events SET body='changed old event' WHERE id=1");
   else f.db.exec("UPDATE tool_calls SET result='changed beyond first101' WHERE id='z0250'");
   const stale=f.service({action:'reconcile',runIds:[1],previewToken:before.previewToken,reason:'fixture'});assert.equal(stale.reasonCode,'state_changed');assert.equal(f.db.prepare('SELECT status FROM runs').get().status,'running');
   const fresh=f.service({action:'preview',runIds:[1]});assert.equal(fresh.rows[0].eligible,true);assert.equal(f.service({action:'reconcile',runIds:[1],previewToken:fresh.previewToken,reason:'complete new evidence'}).applied,true);
  }finally{f.db.close();}
 }
});
test('reconciliation reasons use existing secret redaction',()=>{const f=fixture();try{const p=f.service({action:'preview',runIds:[1]});assert.equal(f.service({action:'reconcile',runIds:[1],previewToken:p.previewToken,reason:'password=abcdefghi'}).applied,true);assert.doesNotMatch(f.db.prepare('SELECT last_error FROM runs').get().last_error,/abcdefghi/);assert.doesNotMatch(f.db.prepare('SELECT body FROM task_events ORDER BY id DESC LIMIT 1').get().body,/abcdefghi/);}finally{f.db.close();}});
