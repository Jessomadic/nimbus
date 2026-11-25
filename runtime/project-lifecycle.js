import {redact} from '../redact.js';
import {assertDomainMutation} from './branch-domains.js';

const leaderStatuses=new Set(['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool','paused','interrupted']);
const terminalStatuses=new Set(['done','stopped','error','needs_review']);
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const id=value=>{const n=Number(value);if(!(typeof value==='number'||typeof value==='string'&&/^[1-9]\d*$/.test(value))||!Number.isSafeInteger(n)||n<1)throw new Error('A positive leader task ID is required');return n;};
const requestId=value=>{if(typeof value!=='string'||!value||value.length>200||!/^[a-zA-Z0-9._:-]+$/.test(value))throw new Error('A valid retained request ID is required');return value;};

// Adoption is an explicit authenticated HOST operation. Never expose adopt/revoke
// as model tools or accept hostContext from a request body. Workers only receive
// assertOwned against their host-supplied current run, bot and journal identity.
export class ProjectLifecycleOwnership {
  constructor({db,query,continuation,event}={}){
    if(!db||typeof query!=='function'||!continuation)throw new Error('Project lifecycle ownership requires database and continuation policy');
    Object.assign(this,{db,query,continuation,event});this.serial=0;
    db.exec(`CREATE TABLE IF NOT EXISTS project_lifecycle_owners(
      request_id TEXT PRIMARY KEY,leader_run_id INTEGER NOT NULL,project TEXT NOT NULL,
      checkpoint_ref TEXT NOT NULL,request_fingerprint TEXT NOT NULL,adopted_by TEXT NOT NULL,
      reason TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT(unixepoch()),updated_at INTEGER NOT NULL DEFAULT(unixepoch())
    );
    CREATE TABLE IF NOT EXISTS project_lifecycle_owner_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL,leader_run_id INTEGER NOT NULL,
      project TEXT NOT NULL,action TEXT NOT NULL,principal TEXT NOT NULL,reason TEXT NOT NULL,
      previous_leader_run_id INTEGER,created_at INTEGER NOT NULL DEFAULT(unixepoch())
    );`);
  }
  get(value){return this.query('SELECT * FROM project_lifecycle_owners WHERE request_id=?').get(requestId(value))||null;}
  _host(context,reason){
    if(context?.authenticated!==true||typeof context.principal!=='string'||!context.principal.trim()||context.principal.length>200)throw new Error('Authenticated owner adoption is required');
    if(typeof reason!=='string'||!reason.trim()||reason.length>2000)throw new Error('An explicit adoption/revocation reason is required');
    return {principal:redact(context.principal.trim()),reason:redact(reason.trim())};
  }
  _atomic(fn){
    const name='project_lifecycle_'+(++this.serial);this.db.exec('SAVEPOINT '+name);
    try{const result=fn();this.db.exec('RELEASE '+name);return result;}
    catch(error){this.db.exec('ROLLBACK TO '+name);this.db.exec('RELEASE '+name);throw error;}
  }
  _run(value){return this.query('SELECT * FROM runs WHERE id=?').get(id(value));}
  _hasTable(name){return !!this.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  _unsafeCalls(runId,{requestKey,checkRunning=true}={}){
    if(!this._hasTable('tool_calls'))return false;
    const calls=this.query("SELECT id,name,state FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain')").all(runId);
    return calls.some(call=>call.state==='uncertain'||checkRunning&&!(call.id===requestKey&&call.name==='project_recovery'&&call.state==='running'));
  }
  _leader(runId,project,{requestKey,checkRunning=true}={}){
    const run=this._run(runId),bot=run&&this.query('SELECT id,template FROM bots WHERE id=?').get(run.bot_id);
    if(!run||run.parent_run||run.source==='tool-development'||bot?.template!=='orchestrator'||!leaderStatuses.has(run.status))throw new Error('An active ordinary Orchestrator leader is required');
    const state=parse(run.checkpoint);
    if(!Array.isArray(state?.messages)||state.noProgress)throw new Error('The leader requires a safe retained checkpoint without a no-progress stop');
    const policy=this.continuation.requireUntilComplete(run.id,project);
    if(this._unsafeCalls(run.id,{requestKey,checkRunning}))throw new Error('The leader has another running or uncertain action; reconcile it before recovery');
    if(this._hasTable('approvals')&&this.query("SELECT id FROM approvals WHERE run_id=? AND status IN ('rejected','denied') LIMIT 1").get(run.id))throw new Error('Recovery cannot bypass a rejected leader action');
    return {run,policy};
  }
  _request(value){
    const request=this.query('SELECT * FROM tool_development_requests WHERE id=?').get(requestId(value));
    if(!request)throw new Error('Unknown retained tool-development request');return request;
  }
  _record(owner,action,principal,reason,previous){
    this.query('INSERT INTO project_lifecycle_owner_events(request_id,leader_run_id,project,action,principal,reason,previous_leader_run_id) VALUES(?,?,?,?,?,?,?)').run(owner.request_id,owner.leader_run_id,owner.project,action,principal,reason,previous??null);
    this.event?.(owner.leader_run_id,'project.lifecycle.'+action,{requestId:owner.request_id,project:owner.project,previousLeaderRunId:previous??null,principal,reason});
  }
  adopt(value,{leaderRunId,project,reason}={},hostContext){assertDomainMutation(this.db,value);
    const authority=this._host(hostContext,reason);value=requestId(value);leaderRunId=id(leaderRunId);
    if(typeof project!=='string'||!project.trim()||project.length>200)throw new Error('An explicit project is required');
    return this._atomic(()=>{
      const {run,policy}=this._leader(leaderRunId,project),request=this._request(value),prior=this.get(value);
      if(!['blocked','needs_review','queued','ready'].includes(request.status))throw new Error('Adoption requires an inactive retained request; wait for the active lifecycle');
      if(prior&&prior.project!==project)throw new Error('The request is already associated with a different project');
      if(prior&&prior.request_fingerprint!==request.fingerprint)throw new Error('The retained request scope changed; reconcile its identity');
      if(prior&&!prior.revoked&&prior.leader_run_id!==leaderRunId){
        const old=this._run(prior.leader_run_id),oldPolicy=this.continuation.get(prior.leader_run_id);
        if(old&&!terminalStatuses.has(old.status)&&!oldPolicy?.stopped)throw new Error('Another active project leader still owns this request');
      }
      for(const stage of this.query('SELECT run_id FROM tool_development_stages WHERE request_id=? AND run_id IS NOT NULL').all(value)){
        const stageRun=this._run(stage.run_id);
        if(!stageRun||parse(stageRun.checkpoint)?.noProgress||leaderStatuses.has(stageRun.status)&&!['paused','interrupted'].includes(stageRun.status)||this._unsafeCalls(stage.run_id))throw new Error('A lifecycle stage is active, stopped for no progress or has unresolved actions; reconcile it before adoption');
      }
      if(prior&&!prior.revoked&&prior.leader_run_id===leaderRunId&&prior.checkpoint_ref===policy.checkpoint_ref)return {...prior,id:leaderRunId,replayed:true};
      this.query(`INSERT INTO project_lifecycle_owners(request_id,leader_run_id,project,checkpoint_ref,request_fingerprint,adopted_by,reason)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET leader_run_id=excluded.leader_run_id,checkpoint_ref=excluded.checkpoint_ref,adopted_by=excluded.adopted_by,reason=excluded.reason,revoked=0,updated_at=unixepoch()`).run(value,leaderRunId,project,policy.checkpoint_ref,request.fingerprint,authority.principal,authority.reason);
      // Existing origin/requester and stage records remain immutable history. The
      // new consumer supports the lifecycle's existing live-consumer checks.
      this.query(`INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer,cancelled)
        VALUES(?,?,?,?,1,0) ON CONFLICT(request_id,run_id) DO UPDATE SET consumer=1,cancelled=0`).run(value,leaderRunId,run.bot_id,run.thread);
      if(prior&&prior.leader_run_id!==leaderRunId)this.query('UPDATE tool_development_watchers SET cancelled=1 WHERE request_id=? AND run_id=?').run(value,prior.leader_run_id);
      const owner=this.get(value);this._record(owner,'adopted',authority.principal,authority.reason,prior?.leader_run_id);
      return {...owner,id:leaderRunId,replayed:false};
    });
  }
  assertOwned(value,{runId,botId,requestKey}={}){assertDomainMutation(this.db,value);
    const owner=this.get(value);
    if(!owner||owner.revoked)throw new Error('This request has not been adopted for active project recovery');
    if(id(runId)!==owner.leader_run_id)throw new Error('This request belongs to another project leader');
    const {run,policy}=this._leader(runId,owner.project,{requestKey});
    if(id(botId)!==run.bot_id||policy.checkpoint_ref!==owner.checkpoint_ref)throw new Error('Project recovery context does not match its adopted owner');
    const request=this._request(value);
    if(request.fingerprint!==owner.request_fingerprint||request.status==='cancelled')throw new Error('The adopted request changed scope or was cancelled');
    return {...owner,id:run.id};
  }
  // null means no adoption ever existed. A revoked/invalid adoption remains an
  // explicit denial so callers cannot fall back to the historical origin.
  recoveryOwner(value){
    const owner=this.get(value);if(!owner)return null;
    try{
      assertDomainMutation(this.db,value);
      if(owner.revoked)throw new Error('revoked');
      const {run,policy}=this._leader(owner.leader_run_id,owner.project,{checkRunning:false});
      const request=this._request(value);
      if(policy.checkpoint_ref!==owner.checkpoint_ref||request.fingerprint!==owner.request_fingerprint||request.status==='cancelled')throw new Error('changed');
      // Ownership survives a normal in-flight observation by the leader, so a
      // completing child is not spuriously paused. Dispatching new recovery is
      // stricter: unrelated running effects must settle first. Only one exact
      // currently journaled recovery call may exempt itself, never uncertainty.
      const recoveryCalls=this._hasTable('tool_calls')?this.query("SELECT id FROM tool_calls WHERE run_id=? AND name='project_recovery' AND state='running'").all(owner.leader_run_id):[];
      // Journal insertion precedes approval. The runner sets status=running
      // only after approval returns, so a waiting_approval call cannot grant
      // itself the exemption merely by existing in the journal.
      const requestKey=run.status==='running'&&recoveryCalls.length===1?recoveryCalls[0].id:undefined;
      const dispatchSafe=run.status!=='waiting_approval'&&!this._unsafeCalls(owner.leader_run_id,{requestKey});
      return {adopted:true,authorized:true,dispatchSafe,runId:owner.leader_run_id,project:owner.project,checkpointRef:owner.checkpoint_ref};
    }catch{return {adopted:true,authorized:false,runId:owner.leader_run_id,project:owner.project};}
  }
  revoke(value,{reason}={},hostContext){
    const authority=this._host(hostContext,reason);
    return this._atomic(()=>{const owner=this.get(value);if(!owner)throw new Error('Unknown project recovery adoption');
      if(!owner.revoked){this.query('UPDATE project_lifecycle_owners SET revoked=1,updated_at=unixepoch() WHERE request_id=?').run(value);this._record(owner,'revoked',authority.principal,authority.reason,owner.leader_run_id);}
      return this.get(value);
    });
  }
}
