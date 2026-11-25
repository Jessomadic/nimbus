// Transaction-only stable mapping adapter. The boot host must supply its existing
// authenticated continuation/adoption policy callback; no worker can invoke this.
import {insertQueuedRun} from './run-create.js';
import {HandoffError} from './project-successor-handoff.js';
export function handoffTaskAdapter({db,applyHostPolicies,sanitize=x=>x}){
 if(!db||typeof applyHostPolicies!=='function')throw new Error('Host policy adapter required');
 const fail=()=>{throw new HandoffError('successor_mapping_conflict');};
 return ({intent,fingerprint,botId,prompt,existingRunId})=>{
  if(!db.isTransaction)throw new HandoffError('activation_transaction_required');
  if(typeof prompt!=='string'||Buffer.byteLength(prompt)>32768||!prompt.trim())throw new HandoffError('context_oversized');
  const mapping=db.prepare('SELECT * FROM task_requests WHERE request_key=?').get(intent.successorRequestId);
  if(mapping){
   if(existingRunId==null)fail();
   const run=db.prepare('SELECT * FROM runs WHERE id=?').get(mapping.run_id);
   if(mapping.fingerprint!==fingerprint||!run||run.parent_run!=null||run.source!=='api'||
    run.bot_id!==botId||run.origin_request_id!==intent.successorRequestId||
    run.prompt!==sanitize(prompt)||(existingRunId!=null&&existingRunId!==run.id))fail();
   // Existing evidence must be reconciled, never reapply policies on replay.
   return Number(run.id);
  }
  if(existingRunId!=null)fail();
  const runId=insertQueuedRun(db,{botId,thread:'bot:'+botId,prompt,source:'api',
   parentRun:null,originRequestId:intent.successorRequestId},sanitize);
  db.prepare('INSERT INTO task_requests(request_key,fingerprint,run_id) VALUES(?,?,?)').run(intent.successorRequestId,fingerprint,runId);
  // Same transaction: policy rejection rolls back task and stable mapping.
  // Callback must return explicit confirmation; missing integration fails closed.
  if(applyHostPolicies({intent,runId})!==true)throw new HandoffError('host_policy_not_applied');
  return runId;
 };
}
