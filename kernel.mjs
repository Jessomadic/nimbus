// PRIVATE FIXTURE KERNEL. Host constructs this closure; no worker payload can supply a port.
// Not a production authorization boundary. DB and port are trusted host dependencies.
import {randomUUID} from 'node:crypto';
import {installStore} from './store.mjs';
export function createKernel(db,{owner,port,now=()=>Date.now()}) {
 if(typeof owner!=='string'||!owner||typeof port!=='function')throw Error('Host binding required');
 installStore(db);
 db.exec(`PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS dispatch_policy(job TEXT PRIMARY KEY,owner TEXT NOT NULL,held INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS dispatch_occurrences(id TEXT PRIMARY KEY,job TEXT NOT NULL,due INTEGER NOT NULL,execution TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,phase TEXT NOT NULL,handle TEXT UNIQUE,error TEXT,expected_revision INTEGER,expected_next INTEGER,expected_definition TEXT,UNIQUE(job,due));
 CREATE TABLE IF NOT EXISTS dispatch_revisions(job TEXT PRIMARY KEY,revision INTEGER NOT NULL);
 INSERT OR IGNORE INTO dispatch_revisions SELECT id,0 FROM jobs;
 CREATE TRIGGER IF NOT EXISTS dispatch_revision_insert AFTER INSERT ON jobs BEGIN
 INSERT INTO dispatch_revisions VALUES(NEW.id,1) ON CONFLICT(job) DO UPDATE SET revision=revision+1; END;
 CREATE TRIGGER IF NOT EXISTS dispatch_revision_edit AFTER UPDATE OF definition,next,enabled,removed ON jobs
 WHEN OLD.definition IS NOT NEW.definition OR OLD.next IS NOT NEW.next OR OLD.enabled IS NOT NEW.enabled OR OLD.removed IS NOT NEW.removed BEGIN
 UPDATE dispatch_revisions SET revision=revision+1 WHERE job=NEW.id; END;
 CREATE TRIGGER IF NOT EXISTS dispatch_revision_delete AFTER DELETE ON jobs BEGIN
 UPDATE dispatch_revisions SET revision=revision+1 WHERE job=OLD.id; END;`);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}};
 const eligible=r=>{
   if(!r||r.enabled!==1||r.removed!==0||r.held!==0||r.currentOwner!==owner)return false;
   try{return JSON.parse(r.definition).imported!==true&&!r.job.startsWith('hermes:');}catch{return false;}
 };
 const read=id=>db.prepare(`SELECT o.*,j.definition,j.enabled,j.removed,j.next currentNext,v.revision currentRevision,p.owner currentOwner,p.held FROM dispatch_occurrences o JOIN jobs j ON j.id=o.job JOIN dispatch_policy p ON p.job=o.job JOIN dispatch_revisions v ON v.job=o.job WHERE o.id=?`).get(id);
 // Revision prevents edit-and-restore ABA; snapshots fail closed on legacy unbound claims.
 const unchanged=r=>r.expected_revision!=null&&r.currentRevision===r.expected_revision&&r.currentNext===r.expected_next&&r.definition===r.expected_definition;
 // Trusted host-only recurrence operation, NOT an edit API. CAS under BEGIN IMMEDIATE:
 // advance the cursor and rebind only this still-valid unstarted reservation atomically.
 function advanceCursor(id,next) {return tx(()=>{
  const r=read(id);
  if(!r||r.owner!==owner||r.phase!=='claimed'||!eligible(r)||!unchanged(r)||
     !Number.isSafeInteger(next)||next<=r.due||r.expected_next!==r.due)return false;
  db.prepare('UPDATE jobs SET next=? WHERE id=?').run(next,r.job);
  const revision=db.prepare('SELECT revision FROM dispatch_revisions WHERE job=?').get(r.job).revision;
  db.prepare('UPDATE dispatch_occurrences SET expected_next=?,expected_revision=? WHERE id=?').run(next,revision,id);
  return true;
 });}
 function claim(){
  return tx(()=>{
   const candidates=db.prepare(`SELECT j.id job,j.definition,j.enabled,j.removed,j.next due,v.revision currentRevision,p.owner currentOwner,p.held FROM jobs j JOIN dispatch_policy p ON p.job=j.id JOIN dispatch_revisions v ON v.job=j.id WHERE j.next IS NOT NULL AND j.next<=? ORDER BY j.next,j.id`).all(now());
   const r=candidates.find(r=>eligible(r)&&!db.prepare("SELECT id FROM executions WHERE job=? AND status IN ('running','uncertain')").get(r.job)&&!db.prepare('SELECT id FROM dispatch_occurrences WHERE job=? AND due=?').get(r.job,r.due));
   if(!r)return null;
   const id=randomUUID(),execution=randomUUID();
   db.prepare("INSERT INTO executions(id,job,fire_key,trigger,due,status,started) VALUES(?,?,?,'private-fixture',?,'running',?)").run(execution,r.job,String(r.due),r.due,now());
   db.prepare("INSERT INTO dispatch_occurrences(id,job,due,execution,owner,phase,expected_revision,expected_next,expected_definition) VALUES(?,?,?,?,?,'claimed',?,?,?)").run(id,r.job,r.due,execution,owner,r.currentRevision,r.due,r.definition);
   return id;
  });
 }
 function finish(id,phase,handle=null,error=null){
  return tx(()=>{
   const r=read(id);if(!r||r.owner!==owner||r.phase!=='invoking')return false;
   db.prepare('UPDATE dispatch_occurrences SET phase=?,handle=?,error=? WHERE id=?').run(phase,handle,error,id);
   // Acknowledged means submitted, not completed. Remains running until trusted terminal observation.
   db.prepare('UPDATE executions SET status=?,error=?,ended=? WHERE id=?').run(phase==='acknowledged'?'running':phase,error,phase==='acknowledged'?null:now(),r.execution);
   return true;
  });
 }
 async function invoke(id) {
  // No await between authoritative DB reread / durable intent and calling the bound port.
  const record=tx(()=>{
   const r=read(id);
   if(!r||r.owner!==owner||r.phase!=='claimed')return null;
   if(!eligible(r)||!unchanged(r)){
    db.prepare("UPDATE dispatch_occurrences SET phase='cancelled' WHERE id=?").run(id);
    db.prepare("UPDATE executions SET status='cancelled',ended=? WHERE id=?").run(now(),r.execution);return null;
   }
   db.prepare("UPDATE dispatch_occurrences SET phase='invoking' WHERE id=?").run(id);
   return Object.freeze({occurrenceId:r.id,executionId:r.execution,jobId:r.job,due:r.due,owner:r.owner,definition:r.definition});
  });
  if(!record)return false;
  try{
   const ack=await port(record);
   if(ack?.occurrenceId!==record.occurrenceId||typeof ack.handle!=='string'||!ack.handle)throw Error('Uncorrelated acknowledgement');
   return finish(id,'acknowledged',ack.handle);
  }catch(e){finish(id,'uncertain',null,String(e.message));return false;}
 }
 function cancel(id){return tx(()=>{
  const r=read(id);if(!r||r.owner!==owner)return false;
  if(r.phase==='claimed'){db.prepare("UPDATE dispatch_occurrences SET phase='cancelled' WHERE id=?").run(id);db.prepare("UPDATE executions SET status='cancelled',ended=? WHERE id=?").run(now(),r.execution);return true;}
  // Invocation may have had an effect: cancellation is NOT proof of no effect.
  if(['invoking','acknowledged'].includes(r.phase)){
   db.prepare("UPDATE dispatch_occurrences SET phase='uncertain',error='cancel requested after invocation' WHERE id=?").run(id);
   db.prepare("UPDATE executions SET status='uncertain',error='cancel requested after invocation' WHERE id=?").run(r.execution);return true;
  }return false;
 });}
 function observeTerminal(id,handle,status){
  // Internal host observer only, not exposed to worker/user payloads.
  if(!['completed','failed','cancelled'].includes(status))throw Error('Nonterminal');
  return tx(()=>{const r=read(id);if(!r||r.owner!==owner||r.phase!=='acknowledged'||r.handle!==handle)return false;
   db.prepare('UPDATE dispatch_occurrences SET phase=? WHERE id=?').run(status,id);
   db.prepare('UPDATE executions SET status=?,ended=? WHERE id=?').run(status,now(),r.execution);return true;});
 }
 return Object.freeze({claim,invoke,cancel,observeTerminal,advanceCursor,
 recoveryHolds:()=>db.prepare("SELECT * FROM dispatch_occurrences WHERE phase IN ('claimed','invoking','uncertain','acknowledged')").all()});
}
// UNIMPLEMENTED_HOST_HOOK: bind durable occurrence to trusted production runBot/observer,
// current owner revocation and hold fencing. Actual runBot returns insertQueuedRun ID
// synchronously, but loads production runtime/services; not invoked by this fixture.
