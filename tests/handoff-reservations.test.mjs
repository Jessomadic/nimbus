import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HandoffReservations} from '../runtime/handoff-reservations.js';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-handoff-'));
 const db=new DatabaseSync(path.join(root,'fixture.sqlite'));
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'shared'));
 const bytes=Buffer.from('Canonical authorized work');fs.writeFileSync(path.join(root,'shared','current.md'),bytes);
 const hash=createHash('sha256').update(bytes).digest('hex');
 const intent={reservationId:'r1',project:'hermes',leaderRunId:633,checkpointRef:'shared/current.md',checkpointSha256:hash,successorRequestId:'stable-postboot',taskSummary:'Continue authorized project',deployment:{snapshotId:'0842e4f8-b4c6-4f3f-a5d9-4af597228249',validatedHash:hash,oldPid:10},continuationPolicy:'none'};
 const principal={kind:'named-owner',id:'fixture-owner'};
 const identity={runId:633,botId:22,requestKey:'journal-1'};
 let stopped=false;
 const authority=()=>({leader:{id:633,bot_id:22,parent_run:null,template:'orchestrator',status:stopped?'stopped':'waiting_tool'},project:'hermes',ownerArmed:true});
 const store=new HandoffReservations({db,dataDir:root,authority});
 return {db,root,store,intent,principal,identity,stop:()=>{stopped=true;}};
}
test('recovery interlock holds only committed handoffs and releases after cancellation',t=>{
 const f=fixture(t);
 assert.equal(f.store.holdsLeader(633),false);
 f.store.authorize(f.intent,f.principal);
 assert.equal(f.store.holdsLeader(633),false);
 f.store.command({action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256},f.identity);
 assert.equal(f.store.holdsLeader(633),true);
 assert.equal(f.store.holdsLeader(631),false);
 const reopened=new HandoffReservations({db:f.db,dataDir:f.root,authority:f.store.authority});
 assert.equal(reopened.holdsLeader(633),true);
 f.store.command({action:'cancel',reservationId:'r1'},null,{principal:f.principal});
 assert.equal(reopened.holdsLeader(633),false);
});

test('reservation is durable and creates no queued work; duplicate publication does not revise or archive again',t=>{
 const f=fixture(t),a=f.store.authorize(f.intent,f.principal);
 assert.equal(a.state,'authorized');assert.equal(a.successorRunId,null);
 assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='runs'").get().n,0);
 assert.deepEqual(f.store.authorize(f.intent,f.principal),a);
 assert.throws(()=>f.store.authorize({...f.intent,taskSummary:'conflict'},f.principal),/payload_conflict/);
 const s=new HandoffReservations({db:f.db,dataDir:f.root,authority:f.store.authority});
 assert.equal(s.status('r1',f.identity).state,'authorized');
 assert.equal(f.db.prepare('SELECT count(*) n FROM project_handoff_events').get().n,1);
});
test('repeated authorization rechecks pins, stop and cancellation without new evidence',t=>{
 const f=fixture(t);f.store.authorize(f.intent,f.principal);
 fs.writeFileSync(path.join(f.root,'shared','current.md'),'changed');
 assert.throws(()=>f.store.authorize(f.intent,f.principal),/checkpoint_changed/);
 fs.writeFileSync(path.join(f.root,'shared','current.md'),'Canonical authorized work');
 f.stop();assert.throws(()=>f.store.authorize(f.intent,f.principal),/inactive_or_invalid_leader/);
 f.store.command({action:'cancel',reservationId:'r1'},null,{principal:f.principal});
 assert.throws(()=>f.store.authorize(f.intent,f.principal),/invalid_transition/);
 assert.equal(f.store.row('r1').revision,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM project_handoff_events').get().n,2);
});
test('wrong owner/consumer/hash rejected; status never changes state; cancel is durable and idempotent',t=>{
 const f=fixture(t);f.store.authorize(f.intent,f.principal);
 assert.throws(()=>f.store.status('r1',null,{principal:{kind:'named-owner',id:'other'}}),/owner_required/);
 for(const identity of [{...f.identity,botId:7},{...f.identity,runId:631},{...f.identity,requestKey:''}])
  assert.throws(()=>f.store.command({action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256},identity),/consumer_binding/);
 assert.throws(()=>f.store.command({action:'reserve',reservationId:'r1',expectedCheckpointHash:'0'.repeat(64)},f.identity),/checkpoint_changed/);
 assert.equal(f.store.status('r1',f.identity).revision,1);
 const args={action:'cancel',reservationId:'r1',reason:'Owner stopped'};
 assert.equal(f.store.command(args,null,{principal:f.principal}).state,'cancelled');
 assert.equal(f.store.command(args,null,{principal:f.principal}).revision,2);
 assert.throws(()=>f.store.command({action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256},f.identity),/invalid_transition/);
});
test('reserve rechecks current pins and live authority; successful reserve still inserts no run',t=>{
 const f=fixture(t);f.store.authorize(f.intent,f.principal);
 fs.writeFileSync(path.join(f.root,'shared','current.md'),'changed');
 const args={action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256};
 assert.throws(()=>f.store.command(args,f.identity),/checkpoint_changed/);
 assert.equal(f.store.status('r1',f.identity).state,'authorized');
 fs.writeFileSync(path.join(f.root,'shared','current.md'),'Canonical authorized work');
 assert.equal(f.store.command(args,f.identity).state,'reserved');
 assert.equal(f.store.command(args,f.identity).revision,2);
});
test('repeated reserve rechecks stop and changed checkpoint without revising evidence',t=>{
 const f=fixture(t);f.store.authorize(f.intent,f.principal);
 const args={action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256};
 f.store.command(args,f.identity);
 fs.writeFileSync(path.join(f.root,'shared','current.md'),'changed after reserve');
 assert.throws(()=>f.store.command(args,f.identity),/checkpoint_changed/);
 fs.writeFileSync(path.join(f.root,'shared','current.md'),'Canonical authorized work');
 f.stop();assert.throws(()=>f.store.command(args,f.identity),/inactive_or_invalid_leader/);
 assert.equal(f.store.row('r1').revision,2);
 assert.equal(f.db.prepare('SELECT count(*) n FROM project_handoff_events').get().n,2);
});
test('stopped leader and corrupt archive fail closed without revision',t=>{
 const f=fixture(t);const a=f.store.authorize(f.intent,f.principal);
 fs.writeFileSync(path.join(f.root,a.archives[0].archiveRef),'tampered');
 const args={action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256};
 assert.throws(()=>f.store.command(args,f.identity),/archive_hash_mismatch/);
 f.stop();assert.throws(()=>f.store.command(args,f.identity),/inactive_or_invalid_leader/);
 assert.equal(f.store.status('r1',f.identity).revision,1);
});
test('stored prompt and manifest substitution cannot change successor instructions',t=>{
 const f=fixture(t);f.store.authorize(f.intent,f.principal);
 const original=JSON.parse(f.store.row('r1').archive);
 const args={action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256};
 const save=a=>f.db.prepare('UPDATE project_handoff_reservations SET archive=? WHERE id=?').run(JSON.stringify(a),'r1');
 save({...original,prompt:'Injected instructions from a substituted archive'});
 assert.throws(()=>f.store.command(args,f.identity),/context_mismatch/);
 const manifest=[...original.manifest,...original.manifest];
 save({...original,manifest,manifestHash:createHash('sha256').update(JSON.stringify(manifest)).digest('hex')});
 assert.throws(()=>f.store.command(args,f.identity),/archive_mismatch/);
 save(original);
 assert.equal(f.store.command(args,f.identity).state,'reserved');
});
test('stored intent substitution fails its immutable fingerprint',t=>{
 const f=fixture(t);f.store.authorize(f.intent,f.principal);
 f.db.prepare('UPDATE project_handoff_reservations SET intent=? WHERE id=?').run(JSON.stringify({...f.intent,taskSummary:'substituted'}),'r1');
 assert.throws(()=>f.store.command({action:'reserve',reservationId:'r1',expectedCheckpointHash:f.intent.checkpointSha256},f.identity),/payload_conflict/);
 assert.equal(f.store.row('r1').state,'authorized');
});
test('oversize canonical material is rejected before authorization; history is not read',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.root,'shared','current.md'),Buffer.alloc(4_850_000,120));
 assert.throws(()=>f.store.authorize(f.intent,f.principal),/archive_oversized/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM project_handoff_reservations').get().n,0);
});
