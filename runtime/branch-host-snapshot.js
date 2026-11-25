// PRIVATE host-only branch preparation and independent successor adapter. Not installed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureDomains,archiveDomainArtifacts,ensureDomainSchema,installDomainFences,holdDomains} from './branch-domains.js';
import {Maintenance} from './maintenance.js';
import {insertQueuedRun} from './run-create.js';
import {isProjectCheckpointRef} from './project-continuation.js';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const fail=code=>{throw new Error(code);};
const positive=x=>Number.isSafeInteger(x)&&x>0;
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const tables=['project_continuations','project_silence_recovery','project_lifecycle_owners','project_lifecycle_owner_events','tool_development_requests','tool_development_stages','tool_development_stage_history','tool_development_recoveries','tool_development_watchers','tool_development_checks','project_handoff_reservations','project_handoff_bindings','task_questions','task_question_routes','task_question_outbox','task_question_attention'];
function unsafe(value,{historical=false}={}){
 const stack=[value];let budget=100000;
 while(stack.length){
  if(--budget<0)fail('nested_budget');
  const x=stack.pop();if(!x||typeof x!=='object')continue;
  for(const [k,v]of Object.entries(x)){
   if(['uncertain','denied'].includes(k)&&v!==false)fail('unsettled');
   if(!historical&&['explicitStop','refusal','hostDenied','noProgress'].includes(k)&&v)fail('leader_hold');
   if(v&&typeof v==='object')stack.push(v);
  }
 }
}
export class BranchHostSnapshot {
 constructor({db,sessions,sourceRoot,checkpointRoot,ownerEmail,now=()=>Date.now()}){
  if(!db||!sessions||typeof sessions.authenticate!=='function'||typeof ownerEmail!=='string')fail('host_dependencies_required');
  Object.assign(this,{db,sessions,sourceRoot,checkpointRoot,ownerEmail,now});this.serial=0;ensureDomainSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS branch_host_preparations(id TEXT PRIMARY KEY,principal TEXT NOT NULL,snapshot TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS branch_host_holds(run_id INTEGER PRIMARY KEY,preparation_id TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS branch_host_events(id INTEGER PRIMARY KEY,preparation_id TEXT NOT NULL,action TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS branch_host_successors(run_id INTEGER PRIMARY KEY,preparation_id TEXT NOT NULL UNIQUE,prompt_hash TEXT NOT NULL,bot_id INTEGER NOT NULL);`);
 }
 atomic(fn){const s='branch_host_'+(++this.serial);this.db.exec('SAVEPOINT '+s);try{const r=fn();this.db.exec('RELEASE '+s);return r;}catch(e){this.db.exec('ROLLBACK TO '+s);this.db.exec('RELEASE '+s);throw e;}}
 principal(token){
  const session=this.sessions.authenticate(token,{touch:false});
  if(!session||session.email!==this.ownerEmail)fail('authenticated_host_required');
  const row=this.db.prepare('SELECT * FROM auth_sessions WHERE token=?').get(hash(token));
  if(!row||row.email!==session.email)fail('authenticated_host_required');
  return {id:session.email,sessionHash:row.token,binding:row.binding};
 }
 current(p){
  const r=this.db.prepare('SELECT * FROM auth_sessions WHERE token=?').get(p.sessionHash),n=this.sessions.now();
  if(!r||r.email!==p.id||p.id!==this.ownerEmail||r.binding!==p.binding||this.sessions.binding(r.email)!==p.binding||
    n-r.created_at>=this.sessions.absoluteSeconds||n-r.last_seen>=this.sessions.idleSeconds)fail('owner_revoked');
 }
 plan(p){
  if(!p||Object.keys(p).sort().join(',')!=='checkpointRef,excludedRoots,expiresAt,leaderId,project,scope'||
   !positive(p.leaderId)||typeof p.project!=='string'||!p.project.trim()||!isProjectCheckpointRef(p.checkpointRef)||
   typeof p.scope!=='string'||!p.scope.trim()||!Array.isArray(p.excludedRoots)||!p.excludedRoots.length||
   p.excludedRoots.some(x=>!positive(x)||x===p.leaderId)||new Set(p.excludedRoots).size!==p.excludedRoots.length||
   !Number.isSafeInteger(p.expiresAt)||p.expiresAt<=this.now()||p.expiresAt>this.now()+86400000)fail('invalid_plan');
 }
 capture(plan){
  this.plan(plan);installDomainFences(this.db);const q=s=>this.db.prepare(s);
  const domain=captureDomains(this.db,plan.leaderId);
  const runs=domain.relations.runs.sort((a,b)=>a.id-b.id);
  const leader=runs.find(r=>r.id===plan.leaderId);
  if(!leader||leader.parent_run!==null||!['paused','interrupted'].includes(leader.status)||q('SELECT template FROM bots WHERE id=?').get(leader.bot_id)?.template!=='orchestrator')fail('leader_hold');
  const ids=new Set(runs.map(r=>r.id)),excluded=new Set();
  for(const root of plan.excludedRoots){
   if(!ids.has(root))fail('invalid_graph');
   for(const r of q('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run=t.id) SELECT id FROM tree').all(root)){
    if(!ids.has(r.id)||r.id===plan.leaderId||excluded.has(r.id))fail('invalid_graph');excluded.add(r.id);
   }
  }
  const descendants=new Set(q('WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT r.id FROM runs r JOIN tree t ON r.parent_run=t.id) SELECT id FROM tree').all(leader.id).map(r=>r.id));
  for(const id of domain.runs)if(!descendants.has(id))excluded.add(id);
  const policy=q('SELECT * FROM project_continuations WHERE run_id=?').get(leader.id);
  if(!policy||policy.stopped||policy.remaining!==-1||policy.expires!==0||policy.project!==plan.project||policy.checkpoint_ref!==plan.checkpointRef)fail('owner_policy');
  const calls=[],approvals=[];
  for(const r of runs){
   if(!['paused','interrupted','stopped','done','error','needs_review'].includes(r.status))fail('active_branch');
   const state=JSON.parse(r.checkpoint||'null');if(!Array.isArray(state?.messages))fail('checkpoint_invalid');
   unsafe(state,{historical:excluded.has(r.id)});
   if(!excluded.has(r.id)&&r.id!==leader.id)fail('unpartitioned_descendant');
   const c=q('SELECT * FROM tool_calls WHERE run_id=? ORDER BY id').all(r.id),a=q('SELECT * FROM approvals WHERE run_id=? ORDER BY id').all(r.id);
   for(const call of c){if(!['done','error'].includes(call.state))fail('effect_hold');unsafe(JSON.parse(call.result||'null'),{historical:excluded.has(r.id)});}
   if(a.some(a=>['pending','rejected','denied'].includes(a.status)))fail('approval_hold');
   calls.push(...c);approvals.push(...a);
  }
  const relations=domain.relations;
  for(const r of relations.project_handoff_reservations)if(['reserved','blocked','activated'].includes(r.state))fail('reservation_hold');
  const owners=relations.project_lifecycle_owners;
  for(const o of owners){
   if(o.revoked||o.project!==plan.project||o.checkpoint_ref!==plan.checkpointRef||o.leader_run_id!==leader.id)fail('ownership_hold');
   const req=relations.tool_development_requests.find(r=>r.id===o.request_id);
   if(!req||req.fingerprint!==o.request_fingerprint)fail('ownership_changed');
  }
  const artifacts=archiveDomainArtifacts(domain,this.checkpointRoot);
  const base=fs.realpathSync(this.checkpointRoot),file=path.resolve(base,plan.checkpointRef);
  if(!file.startsWith(base+path.sep)||fs.realpathSync(file)!==file)fail('checkpoint_path');
  const artifact=fs.readFileSync(file),source=new Maintenance({root:this.sourceRoot,dataDir:this.checkpointRoot}).inventory();
  return {version:2,domain,artifacts,plan,sourceHash:source.hash,checkpointSha256:hash(leader.checkpoint),artifactSha256:createHash('sha256').update(artifact).digest('hex'),runs,calls,approvals,relations,excludedIds:[...excluded].sort((a,b)=>a-b),ownerEpoch:hash(owners)};
 }
 inspect(token,plan){return this.atomic(()=>{this.principal(token);const snapshot=this.capture(plan);return {snapshot,snapshotHash:hash(snapshot)};});}
 prepare(token,input){return this.atomic(()=>{
  if(!input||Object.keys(input).sort().join(',')!=='plan,snapshotHash'||!sha(input.snapshotHash))fail('invalid_binding');
  const principal=this.principal(token),snapshot=this.capture(input.plan);
  if(hash(snapshot)!==input.snapshotHash)fail('snapshot_changed');
  for(const r of snapshot.runs)if(this.db.prepare('SELECT 1 FROM branch_host_holds WHERE run_id=?').get(r.id))fail('already_held');
  const id=randomUUID();this.db.prepare('INSERT INTO branch_host_preparations VALUES(?,?,?,0)').run(id,JSON.stringify(principal),JSON.stringify(snapshot));
  for(const r of snapshot.runs)this.db.prepare('INSERT INTO branch_host_holds VALUES(?,?)').run(r.id,id);
  holdDomains(this.db,snapshot.domain,id);
  this.db.prepare('INSERT INTO branch_host_events(preparation_id,action) VALUES(?,?)').run(id,'prepared_hold_only');
  return {id,snapshotHash:hash(snapshot),dispatchAuthorized:false};
 });}
 activate(token,id,input){return this.atomic(()=>{
  const principal=this.principal(token),snapshot=this.validate(id),row=this.db.prepare('SELECT * FROM branch_host_preparations WHERE id=?').get(id);
  if(JSON.stringify(principal)!==row.principal)fail('wrong_owner');
  if(!input||Object.keys(input).sort().join(',')!=='botId,prompt'||!positive(input.botId)||typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>12000)fail('invalid_successor');
  if(this.db.prepare('SELECT 1 FROM branch_host_successors WHERE preparation_id=?').get(id))fail('successor_already_created');
  if(this.db.prepare('SELECT template FROM bots WHERE id=?').get(input.botId)?.template!=='orchestrator')fail('successor_leader_required');
  const prompt='HOST independent scope: '+snapshot.plan.scope+'\nExcluded historical runs remain held and owned: '+snapshot.excludedIds.join(',')+'. Do not resume, adopt, recover, edit or replay them.\n'+input.prompt;
  const runId=insertQueuedRun(this.db,{botId:input.botId,thread:'bot:'+input.botId,prompt,source:'host-branch-successor'});
  this.db.prepare('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[{role:'user',content:prompt}],steps:0}),runId);
  this.db.prepare('INSERT INTO branch_host_successors VALUES(?,?,?,?)').run(runId,id,hash(prompt),input.botId);
  this.db.prepare('INSERT INTO project_continuations(run_id,project,checkpoint_ref,remaining,expires,stopped) VALUES(?,?,?,-1,0,0)').run(runId,snapshot.plan.project,snapshot.plan.checkpointRef);
  // Rebind only the anticipated addition of the successor's HOST-armed policy,
  // in the same transaction. No historical row is updated by this operation.
  this.db.prepare('UPDATE branch_host_preparations SET snapshot=? WHERE id=?').run(JSON.stringify(this.capture(snapshot.plan)),id);
  // Original until-complete policy, stopped/refused descendants, and all adoption
  // mappings remain unchanged. This independent root owns no old lifecycle.
  this.db.prepare('INSERT INTO branch_host_events(preparation_id,action) VALUES(?,?)').run(id,'independent_successor_created');
  return {runId,preparationId:id,scope:snapshot.plan.scope};
 });}
 gate(runId){
  const q=s=>this.db.prepare(s);
  const ancestry=q('WITH RECURSIVE ancestors(id,parent_run) AS (SELECT id,parent_run FROM runs WHERE id=? UNION SELECT r.id,r.parent_run FROM runs r JOIN ancestors a ON r.id=a.parent_run) SELECT r.* FROM runs r JOIN ancestors a ON a.id=r.id').all(runId);
  const bindings=ancestry.map(r=>q('SELECT * FROM branch_host_successors WHERE run_id=?').get(r.id)).filter(Boolean);
  if(!bindings.length){if(ancestry.some(r=>r.source==='host-branch-successor'))fail('successor_binding_missing');return true;}
  if(bindings.length!==1)fail('ambiguous_scope');
  const binding=bindings[0],snapshot=this.validate(binding.preparation_id),root=ancestry.find(r=>r.id===binding.run_id);
  if(root.parent_run!==null||root.bot_id!==binding.bot_id||hash(root.prompt)!==binding.prompt_hash)fail('successor_binding_changed');
  for(const run of ancestry){
   if(['stopped','needs_review','waiting_approval'].includes(run.status))fail('successor_stopped');
   const state=JSON.parse(run.checkpoint||'null');
   const pristineChild=run.id!==root.id&&run.checkpoint===null&&run.status==='queued'&&run.started_at===null&&!q('SELECT 1 FROM tool_calls WHERE run_id=?').get(run.id);
   if(!pristineChild&&(!state||!Array.isArray(state.messages)))fail('checkpoint_invalid');unsafe(state);
   const policy=q('SELECT * FROM project_continuations WHERE run_id=?').get(run.id);if(policy?.stopped)fail('successor_stopped');
   for(const call of q('SELECT * FROM tool_calls WHERE run_id=?').all(run.id)){if(call.state==='uncertain')fail('effect_hold');if(call.result)unsafe(JSON.parse(call.result));}
  }
  return snapshot.plan.scope;
 }
 validate(id){return this.atomic(()=>{const row=this.db.prepare('SELECT * FROM branch_host_preparations WHERE id=?').get(id);if(!row||row.revoked)fail('preparation_revoked');this.current(JSON.parse(row.principal));const old=JSON.parse(row.snapshot);if(hash(this.capture(old.plan))!==hash(old))fail('snapshot_changed');return old;});}
 rebind(token,id,input){return this.atomic(()=>{
  const principal=this.principal(token),row=this.db.prepare('SELECT * FROM branch_host_preparations WHERE id=?').get(id);
  if(!row||row.revoked)fail('preparation_revoked');
  if(JSON.parse(row.principal).id!==principal.id)fail('wrong_owner');
  if(!input||Object.keys(input).join(',')!=='expiresAt')fail('invalid_binding');
  const old=JSON.parse(row.snapshot),plan={...old.plan,expiresAt:input.expiresAt},fresh=this.capture(plan);
  const expected={...old,plan};
  if(hash(fresh)!==hash(expected))fail('snapshot_changed');
  this.db.prepare('UPDATE branch_host_preparations SET principal=?,snapshot=? WHERE id=?').run(JSON.stringify(principal),JSON.stringify(fresh),id);
  this.db.prepare('INSERT INTO branch_host_events(preparation_id,action) VALUES(?,?)').run(id,'same_owner_rebound_holds_retained');
  return {id,dispatchAuthorized:false};
 });}
 revoke(token,id){return this.atomic(()=>{const p=this.principal(token),r=this.db.prepare('SELECT * FROM branch_host_preparations WHERE id=?').get(id);if(!r||JSON.parse(r.principal).id!==p.id)fail('wrong_owner');this.db.prepare('UPDATE branch_host_preparations SET revoked=1 WHERE id=?').run(id);this.db.prepare('INSERT INTO branch_host_events(preparation_id,action) VALUES(?,?)').run(id,'revoked_holds_retained');});}
}
// Guard deliberately does not release holds upon revocation or accept JSON authority.
// A future reviewed successor protocol must explicitly own any release operation.
export function ensureBranchHoldSchema(db){db.exec('CREATE TABLE IF NOT EXISTS branch_host_holds(run_id INTEGER PRIMARY KEY,preparation_id TEXT NOT NULL)');}
export function branchDispatchHeld(db,runId){try{assertBranchDispatch(db,runId);return false;}catch{return true;}}
export function assertBranchDispatch(db,runId){
 if(runId==null)return;
 const row=db.prepare('WITH RECURSIVE ancestors(id,parent_run) AS (SELECT id,parent_run FROM runs WHERE id=? UNION SELECT r.id,r.parent_run FROM runs r JOIN ancestors a ON r.id=a.parent_run) SELECT h.run_id FROM branch_host_holds h JOIN ancestors a ON a.id=h.run_id LIMIT 1').get(Number(runId));
 if(row)fail('protected_branch_held');
}
export function branchHostApi(service,{sessionToken,sameOrigin}){
 return (request,body)=>{
  if(!sameOrigin(request)||!body||Object.hasOwn(body,'principal')||Object.hasOwn(body,'authenticated'))fail('host_transport_required');
  const token=sessionToken(request);
  if(body.action==='inspect'&&Object.keys(body).sort().join(',')==='action,plan')return service.inspect(token,body.plan);
  if(body.action==='prepare'&&Object.keys(body).sort().join(',')==='action,plan,snapshotHash')return service.prepare(token,{plan:body.plan,snapshotHash:body.snapshotHash});
  if(body.action==='activate'&&Object.keys(body).sort().join(',')==='action,id,input')return service.activate(token,body.id,body.input);
  if(body.action==='rebind'&&Object.keys(body).sort().join(',')==='action,id,input')return service.rebind(token,body.id,body.input);
  if(body.action==='revoke'&&Object.keys(body).sort().join(',')==='action,id')return service.revoke(token,body.id);
  fail('invalid_action');
 };
}
