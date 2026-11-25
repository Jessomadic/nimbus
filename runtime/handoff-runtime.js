// Host-only boot adapter. No worker arguments can supply deployment or policy proof.
import {HandoffError} from './project-successor-handoff.js';
import {handoffTaskAdapter} from './handoff-task-adapter.js';
import {ProjectLifecycleOwnership} from './project-lifecycle.js';
const fail=code=>{throw new HandoffError(code);};
export function handoffRuntime({db,store,continuation,lifecycle,maintenance,bootHash,currentPid=()=>process.pid,principalCurrent,sourceClear,enqueue,event,sanitize=x=>x}){
 const q=s=>db.prepare(s),pendingEvents=[];
 db.exec('CREATE TABLE IF NOT EXISTS project_handoff_bindings(run_id INTEGER PRIMARY KEY,reservation_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL)');
 const adopter=new ProjectLifecycleOwnership({db,query:q,continuation,event:(...args)=>pendingEvents.push(args)});
 function policy(intent,principal){
  if(principalCurrent(principal)!==true)fail('owner_revoked');
  const leader=q('SELECT * FROM runs WHERE id=?').get(intent.leaderRunId);
  const reservation=store.row(intent.reservationId),bot=leader&&q('SELECT template FROM bots WHERE id=?').get(leader.bot_id);
  if(!leader||leader.parent_run!=null||leader.source==='tool-development'||bot?.template!=='orchestrator'||leader.bot_id!==reservation?.bot_id)fail('leader_missing');
  const p=continuation.requireUntilComplete(leader.id,intent.project);
  if(p.checkpoint_ref!==intent.checkpointRef)fail('checkpoint_binding');
  const tree=q('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run=t.id) SELECT r.* FROM runs r JOIN tree t ON r.id=t.id').all(leader.id);
  const requests=new Set(intent.explicitAdoptionRequestIds);
  for(const r of tree){
   const state=JSON.parse(r.checkpoint||'null');
   if(!state||state.noProgress||['stopped','needs_review','waiting_approval'].includes(r.status))fail('project_gate');
   if(q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(r.id))fail('effect_gate');
   if(q("SELECT id FROM approvals WHERE run_id=? AND status IN ('rejected','denied') LIMIT 1").get(r.id))fail('approval_gate');
   for(const request of q('SELECT id FROM tool_development_requests WHERE requester_run_id=?').all(r.id))requests.add(request.id);
  }
  for(const id of requests)if(sourceClear(id)!==true)fail('source_review_required');
  return {ownerAuthorized:true,project:intent.project,leaderRunId:leader.id,stopped:false,sourceHeld:false,uncertain:false,rejectedApproval:false,noProgress:false,activeEffects:false};
 }
 function evidence(intent,principal){
  const status=maintenance.status(intent.deployment.snapshotId);
  return {receipt:status.snapshot,currentPid:currentPid(),currentHash:status.sourceHash,bootHash:bootHash(),pending:status.pending,supervised:status.supervised,checkpointHash:intent.checkpointSha256,policy:policy(intent,principal)};
 }
 function binding(runId){
  const b=q('SELECT * FROM project_handoff_bindings WHERE run_id=?').get(runId);if(!b)return null;
  const row=store.row(b.reservation_id);
  if(!row||row.state!=='activated'||row.successor_run_id!==runId||row.fingerprint!==b.fingerprint)fail('successor_binding');
  return {b,row,intent:JSON.parse(row.intent)};
 }
 const adapter=handoffTaskAdapter({db,sanitize,applyHostPolicies:({intent,runId})=>{
  if(intent.explicitAdoptionRequestIds.length&&intent.continuationPolicy!=='owner_armed')fail('adoption_requires_continuation');
  const row=store.row(intent.reservationId);
  q('INSERT INTO project_handoff_bindings VALUES(?,?,?)').run(runId,row.id,row.fingerprint);
  const prompt=q('SELECT prompt FROM runs WHERE id=?').get(runId).prompt;
  q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[{role:'user',content:prompt}],steps:0,handoffInitialization:{reservationId:row.id,fingerprint:row.fingerprint}}),runId);
  if(intent.continuationPolicy==='owner_armed')continuation.arm(runId,{project:intent.project,checkpointRef:intent.checkpointRef,mode:'until_complete'});
  for(const requestId of intent.explicitAdoptionRequestIds)adopter.adopt(requestId,{leaderRunId:runId,project:intent.project,reason:intent.reason||'Explicit owner successor handoff'},{authenticated:true,principal:JSON.parse(row.principal).id});
  return true;
 }});
 function gate(runId){
  const found=binding(runId);if(!found)return true;
  const {row,intent}=found;store.verifyArtifacts(row);
  // Applied receipt PID is deliberately exact. A later unrelated restart holds
  // this queued mapping for explicit deployment reconciliation, never blind release.
  const proof=evidence(intent,JSON.parse(row.principal));
  const d=intent.deployment,r=proof.receipt;
  if(proof.pending!==null||proof.supervised!==true||r?.state!=='applied'||r.pid!==currentPid()||r.bootHash!==bootHash()||proof.currentHash!==d.validatedHash||bootHash()!==d.validatedHash)fail('deployment_reconciliation_required');
  const run=q('SELECT * FROM runs WHERE id=?').get(runId),state=JSON.parse(run.checkpoint||'null');
  if(!state||state.noProgress||run.status!=='queued'||continuation.get(runId)?.stopped)fail('successor_stopped');
  for(const id of intent.explicitAdoptionRequestIds){const owner=lifecycle.recoveryOwner(id);if(owner?.runId!==runId||!owner.authorized||owner.dispatchSafe===false)fail('adoption_changed');}
  return true;
 }
 return {
  holds:runId=>!!q('SELECT 1 FROM project_handoff_reservations WHERE successor_run_id=?').get(runId)||store.holdsLeader(runId),
  gate,
  initialize(runId,state,instructions){
   const found=binding(runId);if(!found){if(state?.handoffInitialization)fail('successor_binding');return state;}
   if(state?.handoffInitialization){const m=state.handoffInitialization;if(m.reservationId!==found.row.id||m.fingerprint!==found.row.fingerprint||state.steps!==0||state.messages?.length!==1)fail('successor_binding');state.instructions=instructions;delete state.handoffInitialization;}
   return state;
  },
  reconcile(){
   const results=[];
   for(const row of q("SELECT * FROM project_handoff_reservations WHERE state IN ('reserved','activated') ORDER BY created_at,id").all()){
    pendingEvents.length=0;
    try{
     const result=store.activate(row.id,{evidence,createOrReconcile:args=>{
      if(args.existingRunId!=null){const b=q('SELECT * FROM project_handoff_bindings WHERE run_id=?').get(args.existingRunId);if(b?.reservation_id!==row.id||b.fingerprint!==row.fingerprint)fail('successor_binding');}
      return adapter(args);
     },enqueue:id=>{for(const args of pendingEvents.splice(0))event?.(...args);if(gate(id))enqueue(id);}});
     results.push(result);
    }catch(error){pendingEvents.length=0;results.push({reservationId:row.id,held:true,code:error.code||error.message});}
   }
   return results;
  }
 };
}
