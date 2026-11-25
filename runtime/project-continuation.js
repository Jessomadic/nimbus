import {recoveryFingerprint} from './provider-recovery.js';
// Structured JSON state/results may contain nested tool envelopes (journal.js).
// Inspect booleans, not prose/string payloads. Exhaustion fails closed.
export function hasStructuredUncertainty(value) {
  const pending=[value]; let budget=100000;
  while(pending.length){
    if(--budget<0)return true;
    const item=pending.pop();
    if(!item||typeof item!=='object')continue;
    // Malformed hold flags cannot prove a settled safe outcome.
    for(const key of ['uncertain','denied'])if(Object.hasOwn(item,key)&&item[key]!==false)return true;
    for(const child of Object.values(item))if(child&&typeof child==='object')pending.push(child);
  }
  return false;
}
// Owner-armed ordinary project recovery. No tool execution or journal mutation.
export function isProjectCheckpointRef(value) {
  return typeof value==='string' && value.trim()===value && value.length>0 && value.length<=2000 &&
    !/[\x00-\x1f:]/.test(value) && !/^[\\/]/.test(value) &&
    value.split(/[\\/]/).every(part=>part && part!=='.' && part!=='..');
}
export class ProjectContinuation {
  constructor({db,query,resume,owned,event,now=()=>Date.now(),withheld=()=>false}) {
    Object.assign(this,{db,query,resume,owned,event,now,withheld});
    db.exec("CREATE TABLE IF NOT EXISTS project_silence_recovery (run_id INTEGER PRIMARY KEY,fingerprint TEXT NOT NULL,retries INTEGER NOT NULL,blocked INTEGER NOT NULL DEFAULT 0)");
    db.exec("CREATE TABLE IF NOT EXISTS project_continuations (run_id INTEGER PRIMARY KEY,project TEXT NOT NULL,checkpoint_ref TEXT NOT NULL,remaining INTEGER NOT NULL,expires INTEGER NOT NULL,stopped INTEGER NOT NULL DEFAULT 0)");
  }
  get(id){return this.query('SELECT * FROM project_continuations WHERE run_id=?').get(Number(id))||null;}
  requireUntilComplete(id,project){
    const policy=this.get(id);
    if(!policy||policy.stopped||policy.remaining!==-1||policy.expires!==0||policy.project!==project||!isProjectCheckpointRef(policy.checkpoint_ref))throw new Error('The project leader must have a matching owner-armed until-complete checkpoint');
    return policy;
  }
  arm(id,{project,checkpointRef,maxContinuations=3,expiresAt,mode='bounded'}={}) {
    id=Number(id);
    if(!Number.isSafeInteger(id)||id<1||!['bounded','until_complete'].includes(mode))throw new Error('Invalid continuation id or mode');
    if(mode==='until_complete'){maxContinuations=-1;expiresAt=0;}
    const prior=this.get(id);
    if(prior){if(prior.project!==project||prior.checkpoint_ref!==checkpointRef||(prior.remaining===-1)!==(mode==='until_complete')||prior.expires!==expiresAt)throw new Error('Conflicting continuation already exists');return prior;}
    const run=this.query('SELECT * FROM runs WHERE id=?').get(id);
    const bot=run&&this.query('SELECT template FROM bots WHERE id=?').get(run.bot_id);
    if(!run||run.parent_run||run.source==='tool-development'||bot?.template!=='orchestrator'||!run.checkpoint||['done','stopped','needs_review','error'].includes(run.status))throw new Error('A checkpointed ordinary leader run is required');
    if(typeof project!=='string'||!project.trim()||project.length>200||!isProjectCheckpointRef(checkpointRef))throw new Error('Project and safe checkpoint reference required');
    if(mode!=='until_complete'&&(!Number.isSafeInteger(maxContinuations)||maxContinuations<1||maxContinuations>3||!Number.isSafeInteger(expiresAt)||expiresAt<=this.now()||expiresAt>this.now()+86400000))throw new Error('Recovery must be bounded to 1-3 continuations and at most 24 hours');
    this.query('INSERT INTO project_continuations(run_id,project,checkpoint_ref,remaining,expires) VALUES(?,?,?,?,?)').run(id,project,checkpointRef,maxContinuations,expiresAt);
    return {continuationId:id,project,checkpointRef,remaining:maxContinuations,expiresAt};
  }
  stop(id){this.query('UPDATE project_continuations SET stopped=1 WHERE run_id=?').run(id);}
  hasDenial(id){
    return this.query('SELECT state,result FROM tool_calls WHERE run_id=?').all(id).some(r=>{
      if(!['done','error'].includes(r.state))return true;
      try{return hasStructuredUncertainty(JSON.parse(r.result));}catch{return true;}
    });
  }
  fingerprint(run,state){return recoveryFingerprint({run,state,query:this.query});}

  pump() {
    const results=[];
    for(const policy of this.query('SELECT * FROM project_continuations WHERE stopped=0 AND (remaining=-1 AND expires=0 OR remaining>0 AND expires>?) ORDER BY run_id').all(this.now())){
      if(this.owned.has(policy.run_id)||this.withheld(policy.run_id))continue;
      // Only interrupted or paused leaders can resume (see the status gate below).
      // Check status first so finished runs never load or parse multi-MB checkpoints
      // and tool results on every one-second tick.
      const head=this.query('SELECT status FROM runs WHERE id=?').get(policy.run_id);
      if(!head||!['interrupted','paused'].includes(head.status))continue;
      const run=this.query('SELECT * FROM runs WHERE id=?').get(policy.run_id);
      if(!run||!run.checkpoint)continue;
      let state;try{state=JSON.parse(run.checkpoint);}catch{continue;}
      if(!Array.isArray(state?.messages)||state.noProgress||state.explicitStop||state.refusal||state.hostDenied||hasStructuredUncertainty(state))continue;
      const silence=run.status==='paused'&&state.providerRecovery?.code==='provider_inference_silence'&&policy.remaining===-1&&policy.expires===0;
      if(silence&&(!state.providerRecovery.model||run.actual_model!==state.providerRecovery.model||run.backend!=='codex'||state.providerRecovery.backend!=='codex'||state.providerRecovery.provider!=='openai'))continue;
      if(this.hasDenial(run.id))continue;
      if(!(run.status==='interrupted'||run.status==='paused'&&state.projectLimit||silence))continue;
      if(this.query("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(run.id))continue;
      // Resume only the leader; safe inactive children retain their state and
      // receipts for reconciliation, not replay. Active owners, uncertain effects,
      // deliberate pauses and no-progress stops still block.
      const tree=this.query('WITH RECURSIVE tree(id) AS (SELECT id FROM runs WHERE parent_run=? UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run=t.id) SELECT r.id,r.status,r.checkpoint FROM runs r JOIN tree t ON r.id=t.id').all(run.id);
      if(tree.some(r=>{
        if(this.withheld(r.id)||this.owned.has(r.id)||this.query("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(r.id))return true;
        // Settled status does not revoke genuine protected holds.
        let protectedChild;try{protectedChild=JSON.parse(r.checkpoint);}catch{return true;}
        if(!Array.isArray(protectedChild?.messages)||protectedChild.noProgress||protectedChild.explicitStop||protectedChild.refusal||protectedChild.hostDenied||hasStructuredUncertainty(protectedChild)||this.hasDenial(r.id))return true;
        // Only same-route leader silence may bypass a settled child's historical
        // hold. Never waive uncertain outcomes (including completed journal rows).
        if(silence){
          if(!['done','error','stopped','interrupted','paused'].includes(r.status))return true;
          // Journal holds checked above before every route/status bypass.
          let child;try{child=JSON.parse(r.checkpoint);}catch{return true;}
          if(!Array.isArray(child?.messages)||child.explicitStop||hasStructuredUncertainty(child))return true;
          return false; // No child resume, reservation, checkpoint or binding write.
        }
        if(this.hasDenial(r.id))return true;
        if(['done','error','stopped'].includes(r.status))return false;
        let child;try{child=JSON.parse(r.checkpoint);}catch{return true;}
        return !Array.isArray(child?.messages)||child.noProgress||child.explicitStop||child.refusal||child.hostDenied||!(r.status==='interrupted'||r.status==='paused'&&child.projectLimit);
      }))continue;
      this.db.exec('BEGIN IMMEDIATE');
      try{
        if(silence){
          const fingerprint=this.fingerprint(run,state);
          const prior=this.query('SELECT * FROM project_silence_recovery WHERE run_id=?').get(run.id);
          if(prior?.fingerprint===fingerprint&&prior.retries>=1){
            this.query('UPDATE project_silence_recovery SET blocked=1 WHERE run_id=?').run(run.id);
            state.noProgress=true;
            this.query('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(state),run.id);
            this.event(run.id,'project.silence_no_progress',{fingerprint});
            this.db.exec('COMMIT');continue;
          }
          this.query('INSERT INTO project_silence_recovery(run_id,fingerprint,retries,blocked) VALUES(?,?,1,0) ON CONFLICT(run_id) DO UPDATE SET fingerprint=excluded.fingerprint,retries=1,blocked=0').run(run.id,fingerprint);
        }
        const changed=this.query('UPDATE project_continuations SET remaining=CASE WHEN remaining=-1 THEN -1 ELSE remaining-1 END WHERE run_id=? AND stopped=0 AND (remaining=-1 AND expires=0 OR remaining>0 AND expires>?)').run(run.id,this.now());
        if(changed.changes){
          this.resume(run.id,{reason:'Owner-armed project continuation',continuation:'Read the canonical safe checkpoint '+policy.checkpoint_ref+'. Reconcile retained completed outcomes; never replay uncertain actions. Continue only the authorized project '+policy.project+'.'});
          this.event(run.id,'project.continued',{continuationId:run.id,remaining:policy.remaining===-1?-1:policy.remaining-1,checkpointRef:policy.checkpoint_ref});
          results.push(run.id);
        }
        this.db.exec('COMMIT');
      }catch(error){this.db.exec('ROLLBACK');throw error;}
    }
    return results;
  }
}
