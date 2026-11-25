import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {handoffTaskAdapter} from '../runtime/handoff-task-adapter.js';
function fixture(t,policy=()=>true){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY);INSERT INTO bots VALUES(22);
 CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,prompt TEXT,status TEXT,parent_run INTEGER,source TEXT,quiet INTEGER,depth INTEGER,origin_message_id INTEGER,origin_request_id TEXT);
 CREATE TABLE task_requests(request_key TEXT PRIMARY KEY,fingerprint TEXT,run_id INTEGER);`);
 const args={intent:{successorRequestId:'stable'},fingerprint:'pin',botId:22,prompt:'bounded',existingRunId:null};
 return {db,args,adapter:handoffTaskAdapter({db,applyHostPolicies:policy})};
}
test('real insertion is parentless API, stable mapping survives repeated reconciliation',t=>{
 let calls=0;const f=fixture(t,()=>{calls++;return true;});
 assert.throws(()=>f.adapter(f.args),/transaction_required/);
 f.db.exec('BEGIN IMMEDIATE');const id=f.adapter(f.args);f.db.exec('COMMIT');
 const r=f.db.prepare('SELECT * FROM runs').get();assert.equal(r.parent_run,null);assert.equal(r.source,'api');assert.equal(r.origin_request_id,'stable');
 f.db.exec('BEGIN IMMEDIATE');assert.equal(f.adapter({...f.args,existingRunId:id}),id);f.db.exec('COMMIT');
 assert.equal(calls,1);assert.equal(f.db.prepare('SELECT count(*) n FROM runs').get().n,1);
});
test('policy denial rolls back insertion and mapping',t=>{
 const f=fixture(t,()=>false);f.db.exec('BEGIN IMMEDIATE');
 assert.throws(()=>f.adapter(f.args),/host_policy_not_applied/);f.db.exec('ROLLBACK');
 assert.equal(f.db.prepare('SELECT count(*) n FROM runs').get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM task_requests').get().n,0);
});
test('conflicting durable mapping fails without inserting another task',t=>{
 const f=fixture(t);f.db.exec('BEGIN IMMEDIATE');f.adapter(f.args);f.db.exec('COMMIT');
 f.db.exec('BEGIN IMMEDIATE');assert.throws(()=>f.adapter({...f.args,prompt:'changed'}),/mapping_conflict/);f.db.exec('ROLLBACK');
 assert.equal(f.db.prepare('SELECT count(*) n FROM runs').get().n,1);
});
