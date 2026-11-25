import {createHash} from 'node:crypto';
import {checkpointHeld,contextJournalHeld} from './child-context.js';
import {assertContextRunDispatch} from './branch-domains.js';
import {resolveOrchestrator} from './orchestrator.js';

// Read-only provenance for non-authoritative context. This conveys no lifecycle,
// continuation, deployment, approval, wake or resume capability to a descendant.
export function createChildContextScope({db,owned,protectedRun=()=>false,resolveOwner,getContinuation}){
 const q=sql=>db.prepare(sql),hash=value=>createHash('sha256').update(String(value)).digest('hex');
 const fail=message=>{throw Object.assign(new Error(message),{pause:true,code:'child_context_hold'});};
 return (parent,child)=>{
  const chain=[],seen=new Set();let current=parent;
  while(current){
   if(seen.has(current.id)||seen.size>=64)fail('Coordinator ancestry requires reconciliation');seen.add(current.id);
   if(current.source==='tool-development'||q('SELECT template FROM bots WHERE id=?').get(current.bot_id)?.template!=='orchestrator')fail('Ordinary coordinator ancestry required');
   assertContextRunDispatch(db,current.id);
   if(!owned(current.id)||protectedRun(current.id)||!['queued','routing','running','waiting_local','waiting_cloud'].includes(current.status)||current.ended_at!==null)fail('Active ancestor ownership required; no wake or resume');
   let checkpoint;try{checkpoint=JSON.parse(current.checkpoint||'{}');}catch{fail('Invalid ancestor checkpoint');}
   if(checkpointHeld(checkpoint))fail('Protected ancestor checkpoint hold');
   if(q("SELECT 1 FROM approvals WHERE run_id=? AND status IN ('denied','rejected','pending')").get(current.id))fail('Protected ancestor approval hold');
   if(contextJournalHeld(db,current.id))fail('Uncertain or denied ancestor action hold');
   const policy=getContinuation(current.id);if(policy?.stopped)fail('Stopped ancestor continuation');
   const binding=q('SELECT binding FROM required_completion_bindings WHERE run=?').get(current.id)?.binding||null;
   if(current.completion_required){let parsed;try{parsed=JSON.parse(binding);}catch{fail('Missing coordinator completion binding');}if(parsed?.runId!==current.id||parsed.parentRun!==current.parent_run)fail('Changed coordinator completion binding');}
   else if(binding)fail('Unexpected coordinator completion binding');
   chain.push({runId:current.id,botId:current.bot_id,parentRun:current.parent_run,depth:current.depth,thread:current.thread,source:current.source,promptHash:hash(current.prompt),bindingHash:binding?hash(binding):null,policy:policy?{project:policy.project,checkpoint:policy.checkpoint_ref}:null});
   if(current.parent_run===null)break;
   const ancestor=q('SELECT * FROM runs WHERE id=?').get(current.parent_run);
   if(!ancestor||ancestor.depth+1!==current.depth||ancestor.bot_id===current.bot_id)fail('Changed coordinator ancestry');
   current=ancestor;
  }
  const root=current,canonical=resolveOrchestrator(q('SELECT id,name,template,parent_bot_id FROM bots').all());
  if(!root||root.parent_run!==null||root.bot_id!==canonical.id)fail('Canonical coordinator root required');
  const owners=q('SELECT * FROM project_lifecycle_owners WHERE leader_run_id=? ORDER BY request_id').all(root.id);
  for(const owner of owners){const active=resolveOwner(owner.request_id);if(owner.revoked||!active?.authorized||active.runId!==root.id)fail('Changed or revoked request owner');}
  const links=[];
  for(const runId of [...chain.map(item=>item.runId),child.id]){
   for(const link of q('SELECT request_id FROM tool_development_stages WHERE run_id=? UNION SELECT request_id FROM tool_development_recoveries WHERE task_id=?').all(runId,runId)){
    const owner=resolveOwner(link.request_id);if(!owner?.authorized||owner.runId!==root.id)fail('Foreign child request scope');links.push({runId,request_id:link.request_id});
   }
  }
  return {rootRunId:root.id,ancestry:chain,owners:owners.map(owner=>({request:owner.request_id,project:owner.project,checkpoint:owner.checkpoint_ref,fingerprint:owner.request_fingerprint})),links};
 };
}
