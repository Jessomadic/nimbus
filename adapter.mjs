// PRIVATE host composition only; no API/tool registration. All authority is read from owned SQLite.
import {createKernel} from './kernel.mjs';
export function adapter({db,owner,start,branch,bindGate,stop,enqueue=()=>{}}) {
 if(typeof owner!=='string'||!owner)throw Error('Host owner required');
 db.exec('CREATE TABLE IF NOT EXISTS scheduler_run_bindings(occurrence TEXT PRIMARY KEY,execution TEXT UNIQUE NOT NULL,job TEXT NOT NULL,run_id INTEGER UNIQUE NOT NULL)');
 const q=s=>db.prepare(s);
 function current(id,{terminal=false}={}) {
  const r=q(`SELECT o.*,p.owner currentOwner,p.held,j.enabled,j.removed,j.definition,j.next currentNext,v.revision currentRevision FROM dispatch_occurrences o JOIN dispatch_policy p ON p.job=o.job JOIN jobs j ON j.id=o.job JOIN dispatch_revisions v ON v.job=o.job WHERE o.id=?`).get(id);
  // Terminal accounting uses the reserved definition, never mutable dispatch eligibility.
  // Owner/policy and branch holds still apply; launch paths retain every existing fence.
  if(!r||r.owner!==owner||r.currentOwner!==owner||r.held||r.job.startsWith('hermes:')||JSON.parse(terminal?r.expected_definition:r.definition)?.imported===true||(!terminal&&(!r.enabled||r.removed||r.currentRevision!==r.expected_revision||r.currentNext!==r.expected_next||r.definition!==r.expected_definition)))throw Error('Scheduler authority changed');
  return r;
 }
 const kernel=createKernel(db,{owner,port:r=>{
  const c=current(r.occurrenceId),d=JSON.parse(c.definition);
  if(!Number.isSafeInteger(d.botId)||typeof d.prompt!=='string'||!d.prompt.trim())throw Error('Invalid host task');
  // Only these task fields survive. Payload cannot set parent, scope, binding or callback.
  const args={botId:d.botId,thread:'bot:'+d.botId,prompt:d.prompt,source:'private-scheduler',quiet:true};
  const runId=start(args,id=>{
   current(r.occurrenceId);branch(id);
   q('INSERT INTO scheduler_run_bindings VALUES(?,?,?,?)').run(c.id,c.execution,c.job,id);
   bindGate(id,()=>{const a=current(c.id);if(!['invoking','acknowledged'].includes(a.phase))throw Error('Scheduler launch held');});
  });
  return {occurrenceId:c.id,handle:String(runId)};
 }});
 function launch(id){const r=q('SELECT owner FROM dispatch_occurrences WHERE id=?').get(id);if(!r||r.owner!==owner)throw Error('Wrong scheduler owner');return kernel.invoke(id).then(ok=>{if(ok){const b=q('SELECT run_id FROM scheduler_run_bindings WHERE occurrence=?').get(id);enqueue(b.run_id);}return ok;});}
 function observe(id){
  // Edits fence launches, not the outcome of an existing bound effect.
  const c=current(id,{terminal:true}),b=q('SELECT * FROM scheduler_run_bindings WHERE occurrence=?').get(id);
  if(!b||b.execution!==c.execution||b.job!==c.job||String(b.run_id)!==c.handle)return false;
  branch(b.run_id);
  const run=q('SELECT status FROM runs WHERE id=?').get(b.run_id);
  const status={done:'completed',error:'failed',stopped:'cancelled'}[run?.status];
  return status?kernel.observeTerminal(id,String(b.run_id),status):false;
 }
 function cancel(id){const b=q('SELECT run_id FROM scheduler_run_bindings WHERE occurrence=?').get(id);const changed=kernel.cancel(id);if(changed&&b)stop(b.run_id);return changed;}
 // Recovery is inspection and fence reconstruction, never a retry or a success inference.
 function recover(){
  return kernel.recoveryHolds().filter(r=>r.owner===owner).map(r=>{
   const b=q('SELECT * FROM scheduler_run_bindings WHERE occurrence=?').get(r.id);
   const exact=b&&b.execution===r.execution&&b.job===r.job&&String(b.run_id)===r.handle;
   if(exact)bindGate(b.run_id,()=>{const c=current(r.id);if(c.phase!=='acknowledged')throw Error('Scheduler recovery held');});
   const run=exact?q('SELECT status FROM runs WHERE id=?').get(b.run_id):null;
   return {occurrenceId:r.id,phase:r.phase,runId:exact?b.run_id:null,
    action:r.phase==='claimed'?'explicit-launch-or-cancel':r.phase==='acknowledged'&&exact?(run?.status==='paused'?'explicit-cancel-or-hold':'observe-or-hold'):'uncertain-hold'};
  });
 }
 return Object.freeze({claim:kernel.claim,launch,observe,cancel,recover,advanceCursor:kernel.advanceCursor});
}
