import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {redact} from '../redact.js';

export function validateArguments(args) {
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['action','runIds','previewToken','reason'].includes(k))||
    !['preview','reconcile'].includes(args.action)||!Array.isArray(args.runIds)||args.runIds.length<1||args.runIds.length>100||
    args.runIds.some(id=>!Number.isSafeInteger(id)||id<1)||new Set(args.runIds).size!==args.runIds.length)
    throw new Error('invalid_arguments');
  if(args.action==='preview'&&(args.previewToken!==undefined||args.reason!==undefined))throw new Error('invalid_arguments');
  if(args.action==='reconcile'&&(typeof args.previewToken!=='string'||!args.previewToken.length||args.previewToken.length>256||
    typeof args.reason!=='string'||!args.reason.trim()||args.reason.length>2000))throw new Error('preview_required');
}
const domains=['controller','queue','provider','terminal','continuation','developmentOwner'];
// All callbacks are synchronous: the host must supply authoritative complete ownership,
// not caller assertions. No database, process, filesystem or registry is opened on import.
export function createLifecycleReconciler({db,query,ownership,boot,broadcast=()=>{}}) {
  const secret=randomBytes(32);
  const digest=value=>createHmac('sha256',secret).update(JSON.stringify(value)).digest('hex');
  function historyFingerprint(sql,id){
    const hash=createHmac('sha256',secret);let count=0;
    hash.update('[');
    // Stream the complete history. UI summaries stay bounded, but older journal
    // mutations must invalidate a preview just like changes in its recent tail.
    for(const row of query(sql).iterate(id)){if(count)hash.update(',');hash.update(JSON.stringify(row));count++;}
    hash.update(']');return {count,hash:hash.digest('hex')};
  }
  function observe(ids,caller) {
    const identity=boot();
    const bootComplete=Number.isSafeInteger(identity?.pid)&&identity.pid>0&&typeof identity.sourceHash==='string'&&!!identity.sourceHash&&Number.isSafeInteger(identity.ownershipEpoch)&&identity.ownershipEpoch>=0;
    const rows=ids.map(id=>{
      const run=query('SELECT * FROM runs WHERE id=?').get(id);
      if(!run)return{runId:id,eligible:false,classification:'missing',blockers:['not_found']};
      const owners=ownership(id);
      if(owners?.then)throw new Error('ownership_unknown');
      const proof=Object.fromEntries(domains.map(key=>[key,owners?.[key]||{state:'unknown',source:'unavailable'}]));
      const unknown=!bootComplete||domains.some(key=>!['owned','absent'].includes(proof[key]?.state)||!proof[key]?.source);
      const live=domains.some(key=>proof[key]?.state==='owned');
      const protectedState=!['running','routing'].includes(run.status)||id===caller.runId;
      const lastEvents=query('SELECT id,type,created_at FROM task_events WHERE run_id=? ORDER BY id DESC LIMIT 10').all(id);
      const unresolvedEffects=query("SELECT id,name,state FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') ORDER BY id LIMIT 100").all(id);
      const blockers=[...(unknown?['ownership_unknown']:[]),...(live?['live_owner']:[]),...(protectedState?['protected_state']:[])];
      return {runId:id,persistedStatus:run.status,...proof,lastEvents,unresolvedEffects,eligible:!blockers.length,
        classification:unknown?'unknown':live?'owned':protectedState?'protected':'orphan',blockers,
        // Bind every persisted byte, but never expose prompts/checkpoints/results.
        durableFingerprint:digest({run,events:historyFingerprint('SELECT * FROM task_events WHERE run_id=? ORDER BY id DESC',id),tools:historyFingerprint('SELECT * FROM tool_calls WHERE run_id=? ORDER BY id',id)})};
    });
    return{boot:identity,rows};
  }
  return function reconcile(args,caller={}) {
    validateArguments(args);
    const ids=[...args.runIds].sort((a,b)=>a-b);
    const current=observe(ids,caller);
    const token=digest({caller,current});
    if(args.action==='preview')return{action:'preview',observedAt:new Date().toISOString(),...current,previewToken:token,applied:false};
    if(token!==args.previewToken)return{applied:false,reasonCode:'state_changed'};
    if(current.rows.some(row=>!row.eligible))return{...current,applied:false,reasonCode:'ineligible_selection'};
    const operationId=randomUUID(),events=[];
    db.exec('BEGIN IMMEDIATE');
    try {
      const checked=observe(ids,caller);
      if(digest({caller,current:checked})!==token)throw new Error('state_changed');
      for(const row of checked.rows) {
        const after=row.unresolvedEffects.length?'needs_review':'interrupted';
        const audit={operationId,caller,selectedRunIds:ids,reason:redact(args.reason),before:row.persistedStatus,after,proof:row,boot:checked.boot};
        const changed=query('UPDATE runs SET status=?,last_error=?,ended_at=unixepoch() WHERE id=? AND status=?')
          .run(after,redact(args.reason),row.runId,row.persistedStatus);
        if(changed.changes!==1)throw new Error('state_changed');
        const inserted=query('INSERT INTO task_events (run_id,type,body) VALUES (?,?,?)')
          .run(row.runId,'task.orphan_reconciled',JSON.stringify(audit));
        events.push({id:Number(inserted.lastInsertRowid),runId:row.runId,type:'task.orphan_reconciled',data:audit});
      }
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    const notificationErrors=[];
    for(const event of events)try{broadcast('task_event',event);}catch{notificationErrors.push(event.id);}
    return{applied:true,operationId,rows:events.map(event=>({runId:event.runId,before:event.data.before,after:event.data.after})),notificationErrors};
  };
}
