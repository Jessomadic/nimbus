import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {HandoffReservations} from '../runtime/handoff-reservations.js';
const hash='a'.repeat(64);
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const store=new HandoffReservations({db,dataDir:'.',authority:()=>{}});
 const intent={project:'hermes',leaderRunId:633,checkpointSha256:hash,deployment:{snapshotId:'snapshot',validatedHash:hash,oldPid:10}};
 db.prepare('INSERT INTO project_handoff_reservations(id,request_id,fingerprint,intent,principal,bot_id,archive,state,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
 .run('r','stable','fingerprint',JSON.stringify(intent),'{}',22,JSON.stringify({manifest:[],prompt:'bounded'}),'reserved',1,0);
 db.exec('CREATE TABLE tasks(id INTEGER PRIMARY KEY,request_id TEXT UNIQUE,fingerprint TEXT)');
 store.verifyArtifacts=()=>{};
 const evidence=()=>({receipt:{id:'snapshot',state:'applied',validatedHash:hash,candidate:{hash},bootHash:hash,pid:11},currentPid:11,currentHash:hash,bootHash:hash,pending:null,supervised:true,checkpointHash:hash,policy:{ownerAuthorized:true,project:'hermes',leaderRunId:633,stopped:false,sourceHeld:false,uncertain:false,rejectedApproval:false,noProgress:false,activeEffects:false}});
 let insertCrash=false,queueCrash=false,queued=[];
 const adapter={evidence,createOrReconcile:b=>{
  const existing=db.prepare('SELECT * FROM tasks WHERE request_id=?').get('stable');
  if(existing){assert.equal(existing.fingerprint,b.fingerprint);return existing.id;}
  const id=Number(db.prepare('INSERT INTO tasks(request_id,fingerprint) VALUES(?,?)').run('stable',b.fingerprint).lastInsertRowid);
  if(insertCrash)throw new Error('before commit');return id;
 },enqueue:id=>{assert.equal(db.isTransaction,false);if(queueCrash)throw new Error('after commit');queued.push(id);}};
 return {db,store,adapter,queued,crashInsert:()=>insertCrash=true,crashQueue:()=>queueCrash=true};
}
test('rollback before commit creates no successor or activation',t=>{
 const f=fixture(t);f.crashInsert();assert.throws(()=>f.store.activate('r',f.adapter),/before commit/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,0);assert.equal(f.store.row('r').state,'reserved');
});
test('postcommit crash is reconciled to same stable ID, never recreated',t=>{
 const f=fixture(t);f.crashQueue();assert.throws(()=>f.store.activate('r',f.adapter),/after commit/);
 const id=f.store.row('r').successor_run_id;assert.ok(id);
 const queued=[];const adapter={...f.adapter,enqueue:id=>queued.push(id)};
 assert.equal(f.store.activate('r',adapter).successorRunId,id);
 assert.equal(f.store.activate('r',adapter).successorRunId,id);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,1);
 assert.deepEqual(queued,[id,id]); // runtime enqueue must deduplicate owned queued ID
 assert.equal(f.db.prepare("SELECT count(*) n FROM project_handoff_events WHERE state='activated'").get().n,1);
});
test('cancelled and changed boot evidence cannot invoke insertion',t=>{
 const f=fixture(t);const bad={...f.adapter,evidence:()=>({...f.adapter.evidence(),currentPid:10})};
 assert.throws(()=>f.store.activate('r',bad),/pid_mismatch/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,0);
 f.db.exec("UPDATE project_handoff_reservations SET state='cancelled'");
 assert.throws(()=>f.store.activate('r',f.adapter),/invalid_transition/);
});
