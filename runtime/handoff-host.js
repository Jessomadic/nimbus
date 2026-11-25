// Host policy resolver. Never accepts a worker-supplied principal or policy proof.
import {HandoffError} from './project-successor-handoff.js';
export function handoffAuthority({query,continuation,maintenance,currentPid=()=>process.pid}) {
 return (intent,principal,reservingIdentity=null)=>{
  const deny=code=>{throw new HandoffError(code);};
  if(!principal||!['named-owner','local-admin'].includes(principal.kind)||!principal.id)deny('owner_required');
  const leader=query('SELECT r.*,b.template FROM runs r JOIN bots b ON b.id=r.bot_id WHERE r.id=?').get(intent.leaderRunId);
  const policy=continuation.requireUntilComplete(intent.leaderRunId,intent.project);
  if(policy.checkpoint_ref!==intent.checkpointRef)deny('checkpoint_binding');
  if(!leader?.checkpoint)deny('checkpoint_missing');
  const state=JSON.parse(leader.checkpoint);
  if(state.noProgress)deny('no_progress');
  const tree=query('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run=t.id) SELECT r.* FROM runs r JOIN tree t ON r.id=t.id').all(intent.leaderRunId);
  for(const run of tree){
   if(run.status==='stopped'||run.status==='needs_review'||run.status==='waiting_approval')deny('project_gate');
   const effects=query("SELECT id,name,args,state FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain')").all(run.id);
   for(const effect of effects){
    let args;try{args=JSON.parse(effect.args);}catch{}
    // Exclude only the runner-bound current reserve, never uncertainty.
    const own=run.id===intent.leaderRunId&&reservingIdentity?.runId===run.id&&
     reservingIdentity.botId===leader.bot_id&&effect.id===reservingIdentity.requestKey&&
     effect.state==='running'&&effect.name==='project_successor_handoff'&&
     args?.action==='reserve'&&args.reservationId===intent.reservationId&&
     args.expectedCheckpointHash===intent.checkpointSha256&&
     Object.keys(args).every(k=>['action','reservationId','expectedCheckpointHash','reason'].includes(k));
    if(!own)deny('effect_gate');
   }
   if(query("SELECT id FROM approvals WHERE run_id=? AND status IN ('rejected','denied') LIMIT 1").get(run.id))deny('approval_gate');
  }
  const status=maintenance.status(intent.deployment.snapshotId),receipt=status.snapshot,d=intent.deployment;
  if(status.pending!==null||status.supervised!==true||currentPid()!==d.oldPid||
   receipt?.id!==d.snapshotId||receipt.state!=='validated'||receipt.validatedHash!==d.validatedHash||
   receipt.candidate?.hash!==d.validatedHash||status.sourceHash!==d.validatedHash)deny('validated_target_required');
  // Source review holds have their own durable lifecycle evidence. Do not infer
  // permission to clear them from a continuation policy.
  const requests=query("SELECT id,status FROM tool_development_requests WHERE requester_run_id=? AND status IN ('needs_review','blocked')").all(leader.id);
  if(requests.length)deny('source_or_request_hold');
  return {leader,project:policy.project,ownerArmed:true};
 };
}
