import {assertRecoveryRoute,recoverySelection,retainedRecoveryRoute} from './runtime/provider-recovery.js';
import fs from 'node:fs';
import {adapter} from './adapter.mjs';
import {assertSchedulerDispatch} from './scheduler-fence.mjs';
const schedulerAcks=new WeakMap();
import {insertQueuedRun} from './runtime/run-create.js';
import {ensureCompletionSchema,hydrateCompletion,finalizeCompletion} from './runtime/completion-binding.js';
import {compileRequiredCompletion,completionAssignmentContext} from './runtime/required-completion.js';
import {conversationToolError,conversationAssignmentContext} from './runtime/delegation-scope.js';
import {delegatedCompletionDecision} from './runtime/delegated-completion.js';
import {completionStatus} from './runtime/completion-status.js';
import {runAuthority} from './runtime/openbubbles-dispatch.js';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { db, q, parseBot, writeBotBrief,DATA_DIR } from './db.js';
ensureCompletionSchema(db);
import { redact, encodeRedacted } from './redact.js';
import { broadcast } from './events.js';
import { config,ROOT } from './runtime/config.js';
import { workerSlots, localSlots, cloudSlots } from './runtime/slots.js';
import { cloudStatus, codexTurn } from './runtime/codex.js';
import { claudeStatus, claudeTurn, resolveClaudeModel, claudeModelAvailable } from './runtime/claude.js';
import { isClaudeTier, providerOf, backendOf } from './runtime/provider-catalog.js';
import { openaiCatalogTiers } from './runtime/plan-models.js';
import {resolveCloudModel} from './runtime/model-selection.js';
import { localChat } from './runtime/local.js';
import { chooseRoute, cloudFallbackTier } from './runtime/router.js';
import { buildTools, executeTool,coreTools,maintenance } from './runtime/tools.js';
import {ToolDevelopment} from './runtime/tool-development.js';
import {developmentHost} from './runtime/tool-development-host.js';
import {toolRequestSummary} from './runtime/tool-development-view.js';
import { journalTool, checkpoint, event, UncertainAction } from './runtime/journal.js';
import { requiresApproval } from './runtime/policy.js';
import {executionPreflight} from './runtime/prompts.js';
import { setQuestionRouter } from './runtime/questions.js';
import { QuestionRouter } from './runtime/question-routing.js';
import {policyCommand as specialistPolicyCommand} from './runtime/toolsets/engineering.js';
import {observeProgress,taskTimeExceeded} from './runtime/progress-execution.js';
import {chargeToolAttempt,toolBudgetFeedback} from './runtime/tool-budget.js';
import {fitInferenceMessages} from './runtime/inference-context.js';
import {consumeRunContext} from './runtime/run-context.js';
import {createChildContext} from './runtime/child-context.js';
import {createChildContextScope} from './runtime/child-context-scope.js';
import {reconcileOrphanRuns} from './runtime/run-lifecycle.js';
import {ProjectContinuation} from './runtime/project-continuation.js';
import {ensureBranchHoldSchema,assertBranchDispatch,branchDispatchHeld} from './runtime/branch-host-snapshot.js';
ensureBranchHoldSchema(db);
let branchHost=null;
export function configureBranchHost(service){if(service.db!==db)throw new Error('Branch host database mismatch');branchHost=service;}
function scopedDispatch(runId){
 assertSchedulerDispatch(db,runId);
 assertBranchDispatch(db,runId);if(runId==null)return;
 if(branchHost)branchHost.gate(runId);
 else if(q("WITH RECURSIVE a(id,parent_run,source) AS (SELECT id,parent_run,source FROM runs WHERE id=? UNION SELECT r.id,r.parent_run,r.source FROM runs r JOIN a ON r.id=a.parent_run) SELECT 1 FROM a WHERE source='host-branch-successor'").get(Number(runId)))throw new Error('branch_host_unconfigured');
}
import {ProjectLifecycleOwnership} from './runtime/project-lifecycle.js';
import {HandoffReservations} from './runtime/handoff-reservations.js';
import {handoffAuthority} from './runtime/handoff-host.js';
import {handoffRuntime} from './runtime/handoff-runtime.js';
import {rejectionWake} from './runtime/rejection-wake.js';

export const botStatus = new Map();
const queues = new Map(), controllers = new Map(), traces = new Map();
const ownedRunIds=new Set();
let shuttingDown=false;
let developmentTimer,applicationBootHash=null;
let lifecycleOwnership,successorRuntime,diagnosticWake;
const questionAttentionPending=new Set();
const questionAttentionErrors=new Map();
export function resolveQuestionCoordinator(originRunId){
  if(!lifecycleOwnership)return null;
  let origin=q('SELECT * FROM runs WHERE id=?').get(originRunId);const seen=new Set();
  for(let n=0;origin&&n<64;n++){
    if(seen.has(origin.id))throw new Error('Question ancestry contains a cycle');seen.add(origin.id);
    const links=q('SELECT request_id FROM tool_development_stages WHERE run_id=? UNION SELECT request_id FROM tool_development_recoveries WHERE task_id=?').all(origin.id,origin.id);
    if(links.length>1)throw new Error('Question origin has ambiguous retained lifecycle ownership');
    if(links.length){
      const requestId=links[0].request_id,owner=lifecycleOwnership.get(requestId);if(!owner)return null;
      const current=lifecycleOwnership.recoveryOwner(requestId),base={runId:owner.leader_run_id,requestId,projectKey:owner.project};
      if(current?.authorized){
        const leader=q('SELECT status,checkpoint FROM runs WHERE id=?').get(owner.leader_run_id);let state;try{state=JSON.parse(leader?.checkpoint||'{}');}catch{}
        const parked=leader?.status==='waiting_tool'&&!ownedRunIds.has(owner.leader_run_id)&&state?.awaitingToolRequest===requestId&&current.dispatchSafe!==false;
        return{...base,authorized:true,...(parked?{attentionOnly:true}:{})};
      }
      // DONE is not revived and receives no recovery authority. A valid retained
      // adoption may identify the bot for a new question-only attention task.
      const run=q('SELECT * FROM runs WHERE id=?').get(owner.leader_run_id),request=q('SELECT fingerprint,status FROM tool_development_requests WHERE id=?').get(requestId);
      let state;try{state=JSON.parse(run?.checkpoint||'{}');}catch{}
      let policy;try{policy=projectContinuation.requireUntilComplete(owner.leader_run_id,owner.project);}catch{}
      const denied=q("SELECT id FROM approvals WHERE run_id=? AND status IN ('denied','rejected') LIMIT 1").get(owner.leader_run_id);
      const uncertain=q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(owner.leader_run_id);
      if(!owner.revoked&&run?.status==='done'&&!run.parent_run&&run.source!=='tool-development'&&q('SELECT template FROM bots WHERE id=?').get(run.bot_id)?.template==='orchestrator'&&Array.isArray(state?.messages)&&!state.noProgress&&policy?.checkpoint_ref===owner.checkpoint_ref&&request?.fingerprint===owner.request_fingerprint&&request.status!=='cancelled'&&!denied&&!uncertain)return{...base,authorized:true,attentionOnly:true};
      return{...base,authorized:false,reason:owner.revoked?'project_owner_revoked':'project_owner_requires_reconciliation'};
    }
    origin=q('SELECT * FROM runs WHERE id=?').get(origin.parent_run);
  }
  return null;
}
function recordQuestionAttentionError(questionId,error){
  const view=questionRouter.get(questionId),key=JSON.stringify([view?.version,error.message]);if(questionAttentionErrors.get(questionId)===key)return;
  questionAttentionErrors.set(questionId,key);event(view?.originRunId||null,'question.attention_held',{questionId,error:redact(error.message)});
}
export function reconcileQuestionAttention(){
  questionRouter.reconcile();
  for(const row of q("SELECT id FROM task_questions WHERE status='pending'").all())try{ensureQuestionAttention(row.id);}catch(error){recordQuestionAttentionError(row.id,error);}
}
export const questionRouter=new QuestionRouter({db,resolveCoordinator:resolveQuestionCoordinator,emit:(name,view)=>{
  projectQuestion(view);broadcast(name,view);
  if(view.status==='pending'&&view.audience==='coordinator'&&!questionAttentionPending.has(view.id)){
    questionAttentionPending.add(view.id);queueMicrotask(()=>{try{ensureQuestionAttention(view.id);}catch(error){recordQuestionAttentionError(view.id,error);}finally{questionAttentionPending.delete(view.id);}});
  }
}});
setQuestionRouter(questionRouter);
function projectQuestion(view){
  const threads=new Set([view.originThread,view.thread].filter(Boolean));
  const existing=q("SELECT id,thread FROM messages WHERE kind='question' AND json_valid(body) AND json_extract(body,'$.questionId')=?").all(view.id);
  for(const message of existing){updateMessage(message.id,{...view,interactive:message.thread===view.thread});threads.delete(message.thread);}
  for(const thread of threads)addMessage(thread,'system','question',{...view,interactive:thread===view.thread},view.originRunId);
}
function ensureQuestionAttention(questionId){
  if(shuttingDown||typeof questionRouter.ensureAttention!=='function')return;
  const result=questionRouter.ensureAttention(questionId,{create:binding=>{
    const bot=q('SELECT * FROM bots WHERE id=?').get(binding.botId),enabled=new Set(JSON.parse(bot?.tools||'[]'));
    if(!['question_inbox','answer_worker_question','escalate_worker_question'].every(name=>enabled.has(name)))throw new Error('Orchestrator question tools are not configured; apply the reviewed additive profile migration');
    const origin=q('SELECT prompt,parent_run FROM runs WHERE id=?').get(binding.originRunId),ancestor=binding.originalCoordinatorRunId?q('SELECT prompt FROM runs WHERE id=?').get(binding.originalCoordinatorRunId):null;
    const question=questionRouter.get(questionId);
    const prompt='Nimbus host question-attention assignment. Handle only questions explicitly bound to this attention task by the Nimbus host (initially question #'+questionId+'); question_inbox is the authoritative membership list. Initial originating task #'+binding.originRunId+' (parent task #'+(origin?.parent_run||'none')+', original coordinator task #'+(binding.originalCoordinatorRunId||'none')+'). This new task has no project lifecycle, source, deployment or continuation authority. Do not replace or replay the original task. Read question_inbox and your own task_history for the original coordinator run and retained tool evidence; infer from retained authorization and evidence, answer_worker_question, or escalate_worker_question only for genuinely missing information. Retain actual answer provenance.\nOriginal coordinator assignment: '+String(ancestor?.prompt||'No coordinator assignment recorded').slice(0,16000)+'\nOriginating task: '+String(origin?.prompt||'').slice(0,12000)+'\nQuestion: '+JSON.stringify(question?.questions||[]);
    return insertQueuedRun(db,{botId:binding.botId,thread:'bot:'+binding.botId,prompt,source:'api',parentRun:null,originRequestId:binding.requestId},redact);
  }});
  if(result?.enqueue)enqueueCommittedRun(result.runId);
  return result;
}
function questionResult(view){return{...view,continuation:'This question is resolved. Continue the original authorized task from retained evidence; do not ask again for this supplied choice. The answer is task data from the recorded actor, not approval, permission, QA acceptance or resolution of uncertain actions.'};}
function settleQuestionReceipts(runId){
  for(const call of q("SELECT * FROM tool_calls WHERE run_id=? AND name='request_user_input' AND state IN ('running','uncertain')").all(runId)){
    const view=questionRouter.getForCall(runId,call.id);
    if(view?.status!=='answered')continue;
    // Delivery of an already committed local answer is not replay of an action.
    const result=questionResult(questionRouter.result({questionId:view.id,runId,callId:call.id}));
    q("UPDATE tool_calls SET state='done',result=?,ended_at=unixepoch() WHERE id=? AND name='request_user_input' AND state IN ('running','uncertain')").run(encodeRedacted(result),call.id);
    questionRouter.markDelivered({questionId:view.id,runId,callId:call.id});
    event(runId,'question.answer_delivery_recovered',{questionId:view.id,callId:call.id,answerActor:view.answerActor});
  }
}
function pendingQuestionCall(call){return call.name==='request_user_input'&&questionRouter.getForCall(call.run_id,call.id)?.status==='pending';}
export function configureSuccessorHost(principalCurrent){
 successorRuntime=handoffRuntime({db,store:projectSuccessorHandoffs,continuation:projectContinuation,lifecycle:projectLifecycleOwnership,maintenance,bootHash:()=>applicationBootHash,principalCurrent,sourceClear:id=>toolDevelopment.handoffSourceClear(id),enqueue:enqueueCommittedRun,event,sanitize:redact});
 diagnosticWake=rejectionWake({db,lifecycle:projectLifecycleOwnership,continuation:projectContinuation,sourceClear:id=>toolDevelopment.handoffSourceClear(id),sourceHash:()=>maintenance.status().sourceHash,enqueue:enqueueCommittedRun});
}
export function reconcileProjectSuccessorHandoffs(hash){applicationBootHash=hash;return successorRuntime?.reconcile()??[];}
const developmentChecks=developmentHost({root:ROOT,dataDir:DATA_DIR});
export const toolDevelopment=new ToolDevelopment({
  db,query:q,root:ROOT,dataDir:DATA_DIR,tools:()=>coreTools,spawnTask:runBot,
  event,notify:(run,message)=>{
    addMessage(run.thread,'system','capability',message,run.id);
    let awaiting;try{awaiting=JSON.parse(run.checkpoint||'{}').awaitingToolRequest;}catch{}
    if(['blocked','cancelled','needs_review'].includes(message.status)&&awaiting===message.requestId){
      if(message.status==='blocked'&&run.status==='waiting_tool'){const saved=JSON.parse(run.checkpoint);saved.toolDiagnosticPause=message.requestId;checkpoint(run.id,saved);}
      const status=message.status==='needs_review'||message.phase==='needs_review'?'needs_review':'paused';
      q("UPDATE runs SET status=?,last_error=? WHERE id=? AND status='waiting_tool'").run(status,redact(message.message||'Tool development requires attention'),run.id);
      const current=q('SELECT bot_id,status FROM runs WHERE id=?').get(run.id);if(current&&current.status===status)setStatus(current.bot_id,'waiting','Tool development needs attention');
    }else if(!['ready'].includes(message.status)){
      const current=q('SELECT bot_id,status FROM runs WHERE id=?').get(run.id);if(current?.status==='waiting_tool'&&!['working','queued'].includes(botStatus.get(current.bot_id)?.state))setStatus(current.bot_id,'waiting','Waiting for a new tool');
    }
  },
  rejectionDiagnostic:(...args)=>diagnosticWake?.record(...args),
  maintenance,bootHash:()=>applicationBootHash,...developmentChecks,
  recoveryPolicy:()=>({...config().toolDevelopment,executionMode:config().workers.executionMode}),
  recoveryOwner:requestId=>lifecycleOwnership?.recoveryOwner(requestId)??null,
  stageBudget:run=>{const state=run.checkpoint&&JSON.parse(run.checkpoint),limit=config().workers.maxSteps,steps=Number(state?.steps);return{exhausted:config().workers.executionMode!=='progress'&&!!state&&(steps>=limit||Number(state.toolAttempts)>Math.max(64,limit*4)),actionRemaining:config().workers.executionMode!=='progress'&&state&&Number.isSafeInteger(steps)&&steps>=0?Math.max(0,limit-steps):null,limit:config().workers.executionMode==='progress'?null:limit,continuation:Number(state?.resumeCount||0)};},
  continueStageTask:(id,options)=>resumeRun(id,options,{completedStage:true}),
  stopTask:id=>stopRun(id),
  enableTool:(botId,name,effects)=>{
    if(!coreTools.some(tool=>tool.function.name===name))throw new Error('The requested tool is not advertised by the running registry');
    const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(botId));if(!bot)throw new Error('Requesting worker was removed');
    const tools=new Set(JSON.parse(bot.tools||'[]'));tools.add(name);
    const rules=[...bot.approval_rules];if(['host_execute','external_write'].includes(effects)&&!rules.includes(name))rules.push(name);
    q('UPDATE bots SET tools=?,approval_rules=? WHERE id=?').run(JSON.stringify([...tools]),JSON.stringify(rules),botId);writeBotBrief({...bot,tools:JSON.stringify([...tools]),approval_rules:rules});broadcast('state_changed',{});
  },
  resumeTask:(runId,request,{investigation}={})=>{
    const run=q('SELECT * FROM runs WHERE id=?').get(runId);if(!run||!(investigation?['paused','waiting_tool']:['waiting_tool']).includes(run.status))return{resumed:false,reason:'Task is no longer waiting for a tool'};
    if(q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(runId))return{resumed:false,reason:'Task contains an uncertain action'};
    if(!run.checkpoint)return{resumed:false,reason:'Task checkpoint is unavailable'};
    const saved=JSON.parse(run.checkpoint);if(saved.awaitingToolRequest!==request.id||saved.noProgress)return{resumed:false,reason:'Checkpoint mismatch or no progress'};
    if(projectSuccessorHandoffs.holdsLeader(runId))return{resumed:false,reason:'Durable successor handoff owns leader recovery'};
    if(investigation){
      if(q("SELECT id FROM approvals WHERE run_id=? AND status IN ('denied','rejected') LIMIT 1").get(runId))return{resumed:false};
      const state=reconcileCheckpoint(runId,saved);
      if(state.investigationWake!==investigation.identity){
        state.messages.push({role:'user',content:`Nimbus advisory only: investigation completed for rejected tool request ${request.id}. ${investigation.message} Report: ${investigation.reportPath} (sha256 ${investigation.reportHash}); current rejected receipt: ${investigation.receiptPath} (sha256 ${investigation.receiptHash}); source: ${investigation.sourceHash}. QA remains rejected. Coordinate fresh QA, independent review and normal validation. No action replay, acceptance, deployment or permission change is authorized by this report.`});
        state.investigationWake=investigation.identity;
      }
      // Keep the exact wait until resumeRun accepts the durable checkpoint.
      checkpoint(runId,state);resumeRun(runId,{}, {investigationWake:investigation.identity});return{resumed:true,runId};
    }
    const state=reconcileCheckpoint(runId,saved);delete state.awaitingToolRequest;
    state.messages.push({role:'user',content:`Nimbus verified tool request ${request.id}. The native tool ${request.tool_name} is now deployed. Continue the original task with the refreshed tools. Retained completed actions are evidence; do not execute them again.`});
    checkpoint(runId,state);resumeRun(runId);return{resumed:true,runId};
  }
});
toolDevelopment.initialize();
export const projectContinuation=new ProjectContinuation({db,query:q,resume:resumeRun,owned:ownedRunIds,event,withheld:id=>{try{scopedDispatch(id);}catch{return true;}return projectSuccessorHandoffs.holdsLeader(id);}});
export const projectLifecycleOwnership=lifecycleOwnership=new ProjectLifecycleOwnership({db,query:q,continuation:projectContinuation,event});
export const projectSuccessorHandoffs=new HandoffReservations({db,dataDir:DATA_DIR,authority:handoffAuthority({query:q,continuation:projectContinuation,maintenance})});
const childContext=createChildContext({db,redact,owned:id=>ownedRunIds.has(id),
 protectedRun:id=>shuttingDown||controllers.get(id)?.signal.aborted||branchDispatchHeld(db,id)||projectSuccessorHandoffs.holdsLeader(id),
 scope:createChildContextScope({db,owned:id=>ownedRunIds.has(id),
  protectedRun:id=>shuttingDown||controllers.get(id)?.signal.aborted||branchDispatchHeld(db,id)||projectSuccessorHandoffs.holdsLeader(id),
  resolveOwner:requestId=>projectLifecycleOwnership.recoveryOwner(requestId),getContinuation:id=>projectContinuation.get(id)})});
export async function recoverProjectRequest(runId,botId,args,requestKey) {
  scopedDispatch(runId);
  projectLifecycleOwnership.assertOwned(args.requestId,{runId,botId,requestKey});
  if(args.action==='status')return toolDevelopment.get(args.requestId);
  if(args.action==='retry')return toolDevelopment.retry(args.requestId,{fromPhase:args.fromPhase||'testing',reason:args.reason||'Owner-associated project leader requests fresh evidence-preserving stage recovery.'});
  if(args.action==='continue_incomplete')return toolDevelopment.continueIncompleteStage(args.requestId,{stageRunId:args.stageRunId,expectedSourceHash:args.expectedSourceHash,reason:args.reason||'Owner-associated leader continues the latest incomplete stage from retained evidence.'},{callerRunId:runId,currentCallId:requestKey});
  if(args.action==='resume_reviewed')return toolDevelopment.resumeReviewedStage(args.requestId,{stageRunId:args.stageRunId,expectedSourceHash:args.expectedSourceHash,reviewedCallId:args.reviewedCallId,reason:args.reason||'Owner-associated leader resumes a held stage after retained owner action review.'},{callerRunId:runId,currentCallId:requestKey});
  if(args.action==='initiate_source_review')return toolDevelopment.initiateSourceReview(args.requestId,args);
  if(args.action==='review_source')return toolDevelopment.reviewSource(args.requestId,{priorRequestId:args.priorRequestId,expectedSourceHash:args.expectedSourceHash,reviewTaskId:args.reviewTaskId,reason:args.reason});
  throw new Error('Unsupported project recovery action');
}
export function startToolDevelopment(bootHash){
  applicationBootHash=bootHash;if(developmentTimer)return;
  developmentTimer=setInterval(()=>{if(!shuttingDown){try{reconcileRunOwnership();projectContinuation.pump();reconcileQuestionAttention();}catch(error){console.error('Task ownership reconciliation failed:',redact(error.message));}toolDevelopment.pump().then(()=>diagnosticWake?.pump()).catch(error=>console.error('Tool-development progress failed:',redact(error.message)));}},1000);developmentTimer.unref();
}
export function addMessage(thread, author, kind, body, runId = null, files = []) {
  const text = typeof body === 'string' ? redact(body) : encodeRedacted(body);
  const r = q('INSERT INTO messages (thread,author,kind,body,run_id,files) VALUES (?,?,?,?,?,?)').run(thread,String(author),kind,text,runId,JSON.stringify(files));
  const msg = q('SELECT * FROM messages WHERE id=?').get(r.lastInsertRowid); broadcast('message',msg); return msg;
}
export function updateMessage(id, body) {
  q('UPDATE messages SET body=? WHERE id=?').run(encodeRedacted(body),id);
  broadcast('message_update',q('SELECT * FROM messages WHERE id=?').get(id));
}
function setStatus(botId,state,label) { botStatus.set(Number(botId),{state,label}); broadcast('bot_status',{botId:Number(botId),state,label}); }
export function markTraceWaiting(runId, name, waiting, reason='approval') {
  const t = traces.get(Number(runId)); if (!t) return;
  const step = [...t.body.steps].reverse().find(s => s.tool === name && ['running','waiting'].includes(s.state));
  if (step) { step.state = waiting ? 'waiting' : 'running'; if(waiting)step.waitReason=reason;else delete step.waitReason; }
  if (waiting && !t.waitStart) t.waitStart = Date.now();
  if (!waiting && t.waitStart) { t.waited += Date.now()-t.waitStart; t.waitStart = null; }
  updateMessage(t.id,t.body);
}
export function roomMembers(roomId) { return q('SELECT b.* FROM bots b JOIN room_members m ON m.bot_id=b.id WHERE m.room_id=? ORDER BY b.id').all(roomId).map(parseBot); }
export function findMentions(text,bots,excludeId=null) {
  const lower = String(text).toLowerCase();
  return bots.filter(bot => bot.id !== excludeId && [bot.name,bot.name.split(/\s+/)[0]].some(name => new RegExp('@'+name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[\\s.,:;!?])').test(lower)));
}
function roomContext(roomId) {
  const room = q('SELECT * FROM rooms WHERE id=?').get(roomId), members = roomMembers(roomId);
  const names = new Map(members.map(b => [String(b.id),b.name]));
  const rows = q("SELECT * FROM messages WHERE thread=? AND kind='text' ORDER BY id DESC LIMIT 24").all('room:'+roomId).reverse();
  return `Group: ${room.name}\nGoal: ${room.goal || ''}\nMembers: ${members.map(b=>b.name+': '+b.role).join('; ')}\n${room.bots_can_talk ? 'Mention a teammate with @Full Name and a specific request only when you want it to act.' : 'Bot handoffs are disabled in this group.'}\nRecent group messages:\n${rows.map(m=>(names.get(m.author)||m.author)+': '+m.body).join('\n')}`;
}
export function runBot({botId,thread,prompt,depth=0,source='user',parentRun=null,quiet=false,originMessageId=null,originRequestId=null,completionDescriptor,completionOwnedRoot,delegationScope}) {
  if(shuttingDown)throw new Error('Nimbus is shutting down; submit this task after it restarts.');
  const schedulerAck=source==='private-scheduler'?schedulerAcks.get(arguments[0]):null;
  if(source==='private-scheduler'&&typeof schedulerAck!=='function')throw Error('Scheduler host binding required');
  scopedDispatch(parentRun);
  const id=insertQueuedRun(db,{botId,thread,prompt,depth,source,parentRun,quiet,originMessageId,originRequestId,completionDescriptor,completionOwnedRoot,delegationScope},redact);
  event(id,'task.queued',{botId,thread,source,parentRun});
  if(source==='private-scheduler'){schedulerAck(id);return id;}
  enqueue(id,String(prompt)); return id;
}
export function enqueueCommittedRun(runId){const r=q('SELECT * FROM runs WHERE id=?').get(runId);if(r?.status==='queued'&&!ownedRunIds.has(Number(runId)))enqueue(runId,r.prompt);}
function enqueue(runId,prompt) {
  scopedDispatch(runId);
  if(ownedRunIds.has(Number(runId)))return;
  const run = q('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return;
  if (!botStatus.get(run.bot_id) || botStatus.get(run.bot_id).state==='idle') setStatus(run.bot_id,'queued','Queued');
  const prev = queues.get(run.bot_id)||Promise.resolve();
  ownedRunIds.add(Number(runId));
  const next = prev.catch(()=>{}).then(()=>execute(runId,prompt)).catch(e=>{
    q("UPDATE runs SET status='error',last_error=?,ended_at=unixepoch() WHERE id=? AND status!='stopped'").run(redact(e.message),runId);
    addMessage(run.thread,'system','error',e.message,runId); setStatus(run.bot_id,'idle','Idle');
  }).finally(()=>ownedRunIds.delete(Number(runId)));
  queues.set(run.bot_id,next);
}
export function reconcileRunOwnership(){
  const repaired=reconcileOrphanRuns({db,query:q,ownedRunIds,event});
  if(repaired.length)broadcast('state_changed',{});
  return repaired;
}
export function taskResult(id) {
  const run = q('SELECT id,bot_id,thread,status,actual_model,requested_model,route_reason,fallback_reason,last_error,started_at,ended_at,input_tokens,output_tokens,origin_message_id,origin_request_id,completion_required,delegation_scope,checkpoint FROM runs WHERE id=?').get(Number(id));
  if (!run) throw new Error('Unknown task');
  const reply = q("SELECT body FROM messages WHERE run_id=? AND kind IN ('text','error','quiet') ORDER BY id DESC LIMIT 1").get(Number(id));
  const {checkpoint:stored,...visible}=run;let state;try{state=stored&&JSON.parse(stored);}catch{}
  const limit=config().workers.maxSteps,attemptLimit=Math.max(64,limit*4),used=Math.max(0,Math.min(limit,Math.trunc(Number(state?.steps)||0))),attempts=Math.max(0,Math.trunc(Number(state?.toolAttempts??state?.steps)||0));
  const progress=config().workers.executionMode==='progress';
  const budget=state?{executionMode:progress?'progress':'bounded',actionLimit:progress?null:limit,actionsUsed:progress?Math.max(0,Math.trunc(Number(state.steps)||0)):used,actionRemaining:progress?null:Math.max(0,limit-used),attemptLimit:progress?null:attemptLimit,attemptsUsed:attempts,attemptRemaining:progress?null:Math.max(0,attemptLimit-attempts),continuation:Number(state.resumeCount||0)}:null;
  const delegations=q('SELECT r.id,r.bot_id,b.name AS worker_name,r.status,r.started_at,r.ended_at,r.last_error FROM runs r LEFT JOIN bots b ON b.id=r.bot_id WHERE r.parent_run=? ORDER BY r.id').all(run.id);
  const completion=completionStatus(run,state,{bindingPresent:!!q('SELECT 1 FROM required_completion_bindings WHERE run=?').get(run.id),outputCaptureRecorded:!!q('SELECT 1 FROM completion_output_captures WHERE run=?').get(run.id)});
  return {...visible,reply:reply?.body||null,budget,delegations,completion,questions:questionRouter.pendingForRun(run.id,{descendants:true}),coordinatorQuestions:questionRouter.pendingForCoordinator(run.id),toolRequests:toolDevelopment.list({runId:run.id,limit:20}).requests.map(toolRequestSummary)};
}
export function resumeRun(id,options={},internal={}) {
  scopedDispatch(id);
  const invalid=message=>Object.assign(new Error(message),{statusCode:400});
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['refreshInstructions','reason','continuation'].includes(key)))throw invalid('Unsupported checkpoint resume options');
  if(options.refreshInstructions!==undefined&&typeof options.refreshInstructions!=='boolean')throw invalid('refreshInstructions must be boolean');
  if(options.reason!==undefined&&(typeof options.reason!=='string'||!options.reason.trim()||options.reason.length>1000))throw invalid('Resume reason must contain 1 to 1000 characters');
  if(options.continuation!==undefined&&(typeof options.continuation!=='string'||!options.continuation.trim()||options.continuation.length>12000))throw invalid('Continuation must contain 1 to 12000 characters');
  if((options.refreshInstructions||options.continuation)&&!options.reason)throw invalid('An explicit reason is required to refresh host instructions or append a continuation');
  const run = q('SELECT * FROM runs WHERE id=?').get(Number(id));
  if(projectSuccessorHandoffs.holdsLeader(id))throw new Error('Durable successor handoff owns leader recovery; inspect or cancel its reservation first');
  const completedStage=internal.completedStage===true&&run?.source==='tool-development'&&run.status==='done';
  if (!run || !completedStage&&!['paused','interrupted','error','needs_review','waiting_tool'].includes(run.status)) throw new Error('This task cannot be resumed');
  if(run.status==='waiting_tool'){
    const requestId=run.checkpoint&&JSON.parse(run.checkpoint).awaitingToolRequest;
    if(requestId&&!(internal.investigationWake&&JSON.parse(run.checkpoint).investigationWake===internal.investigationWake)&&toolDevelopment.get(requestId)?.status!=='ready')throw new Error('The missing tool is not ready; inspect its tool-development request');
  }
  settleQuestionReceipts(run.id);
  if (q("SELECT * FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain')").all(run.id).some(call=>!pendingQuestionCall(call))) throw new Error('Inspect and resolve the uncertain action before resuming this task. It will not be replayed.');
  let recovery=null;
  if((options.refreshInstructions||options.continuation)&&!run.checkpoint)throw invalid('A retained checkpoint is required for this recovery');
  if(run.checkpoint){
    const state=reconcileCheckpoint(run.id,JSON.parse(run.checkpoint)),previousSteps=Number(state.steps||0),previousAttempts=Number(state.toolAttempts??previousSteps);
    const counts=q("SELECT count(*) AS attempts,sum(CASE WHEN name IN ('worker_result','tool_request_status') THEN 0 ELSE 1 END) AS actions FROM tool_calls WHERE run_id=?").get(run.id);
    state.totalActionSteps??=Number(counts.actions||0);state.totalToolAttempts??=Math.max(Number(counts.attempts||0),previousAttempts);
    if(options.refreshInstructions||options.continuation){
      const directory=path.join(DATA_DIR,'checkpoints',String(run.id));fs.mkdirSync(directory,{recursive:true});const backup=path.join(directory,'before-resume-'+randomUUID()+'.json');fs.writeFileSync(backup,run.checkpoint,{flag:'wx',mode:0o600});
      recovery={reason:redact(options.reason),backup,previousSteps,previousAttempts,completedToolReceipts:Number(counts.attempts||0),instructionsRefreshed:!!options.refreshInstructions};
      if(options.refreshInstructions){const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(run.bot_id));if(!bot)throw invalid('The task worker no longer exists');const cwd=writeBotBrief(bot),next=fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8')+'\nPrivate working memory:\n'+fs.readFileSync(path.join(cwd,'MEMORY.md'),'utf8');recovery.oldInstructionsHash=createHash('sha256').update(String(state.instructions||'')).digest('hex');recovery.newInstructionsHash=createHash('sha256').update(next).digest('hex');state.instructions=next;}
      if(options.continuation)state.messages.push({role:'user',content:'Nimbus host continuation ('+options.reason+'): '+options.continuation});
    }
    delete state.projectLimit;
    state.steps=0;state.toolAttempts=0;state.resumeCount=(state.resumeCount||0)+1;checkpoint(run.id,state);
  }
  q("UPDATE runs SET status='queued',ended_at=NULL,last_error=NULL WHERE id=?").run(run.id);
  if(recovery)event(run.id,'checkpoint.recovered',recovery);
  event(run.id,'task.resumed',{budgetReset:true,instructionsRefreshed:!!options.refreshInstructions}); enqueue(run.id,run.prompt); return run.id;
}
export function stopRun(id) {
  id=Number(id);
  const controller=controllers.get(id);
  const run=q('SELECT status FROM runs WHERE id=?').get(id);
  if(!run)return {changed:false,reasonCode:'not_found'};
  if(['done','error','stopped','needs_review'].includes(run.status))return {changed:false,reasonCode:'already_terminal'};
  if(controller){
    projectContinuation.stop(id);
    questionRouter.cancelRun(id,'Stopped by the user');
    controller.abort(new Error('Stopped by the user'));
    return {changed:false,requested:true,reasonCode:'stop_requested'};
  }
  // A stale running row is not proof that its process stopped. Preserve its
  // continuation and questions until authoritative ownership is reconciled.
  if(!['queued','paused','interrupted','waiting_tool'].includes(run.status))return {changed:false,reasonCode:'reconciliation_required'};
  const changed=!!q("UPDATE runs SET status='stopped',ended_at=unixepoch() WHERE id=? AND status=?").run(id,run.status).changes;
  if(changed){projectContinuation.stop(id);questionRouter.cancelRun(id,'Stopped by the user');toolDevelopment.unwatch?.(id);}
  return {changed,reasonCode:changed?'stopped':'state_changed'};
}
export function recoverRuns() {
  q("UPDATE ob_outbox SET state='uncertain' WHERE state='dispatching'").run();
  questionRouter.reconcile();
  for(const row of q("SELECT DISTINCT run_id FROM tool_calls WHERE name='request_user_input' AND state IN ('running','uncertain')").all())settleQuestionReceipts(row.run_id);
  // Reconcile an accepted durable request if the process ended between its
  // creation and journal/checkpoint completion. Never replay the build request.
  for(const call of q("SELECT * FROM tool_calls WHERE name='request_tool' AND state IN ('running','done')").all()){
    const run=q('SELECT * FROM runs WHERE id=?').get(call.run_id);if(!run||!['running','routing','waiting_local','waiting_cloud','waiting_approval'].includes(run.status))continue;
    const request=toolDevelopment.findByRequestKey?.(call.id);if(!request)continue;
    const result={requestId:request.id,status:request.status,awaitingTool:!['blocked','cancelled','needs_review'].includes(request.status),recovered:true};
    q("UPDATE tool_calls SET state='done',result=?,ended_at=unixepoch() WHERE id=?").run(encodeRedacted(result),call.id);
    if(result.awaitingTool&&run.checkpoint){const state=reconcileCheckpoint(run.id,JSON.parse(run.checkpoint));state.awaitingToolRequest=request.id;checkpoint(run.id,state);q("UPDATE runs SET status='waiting_tool',last_error=NULL WHERE id=?").run(run.id);event(run.id,'task.waiting_tool',{requestId:request.id,recovered:true});}
  }
  const active=q("SELECT id,thread FROM runs WHERE status IN ('running','routing','waiting_local','waiting_cloud','waiting_approval','waiting_input')").all();
  for(const run of active) {
    q("UPDATE runs SET status='interrupted',last_error='Nimbus restarted. Inspect the retained checkpoint before resuming.',ended_at=unixepoch() WHERE id=?").run(run.id);
    event(run.id,'task.interrupted',{reason:'Nimbus restarted; no uncertain actions replayed'});
  }
  q("UPDATE tool_calls SET state='uncertain' WHERE state='running'").run();
  q("UPDATE runs SET status='needs_review',last_error='OpenBubbles attempt requires review; no replay' WHERE id IN (SELECT run_id FROM ob_outbox WHERE state='uncertain')").run();
  q("UPDATE approvals SET status='expired',decided_at=unixepoch() WHERE status='pending'").run();
  // Routed waits survive a restart and reattach only through supported resume;
  // their exact identity and retained answers are never replaced or replayed.
  q("UPDATE task_questions SET status='expired' WHERE status='pending' AND id NOT IN (SELECT question_id FROM task_question_routes)").run();
  reconcileQuestionAttention();
  for(const run of q("SELECT id,prompt,source FROM runs WHERE status='queued' ORDER BY id").all()){
    if(successorRuntime?.holds(run.id)||projectSuccessorHandoffs.holdsLeader(run.id))continue;
    try{enqueue(run.id,run.prompt);}catch(error){
      if(run.source!=='private-scheduler'||!['scheduler_dispatch_denied','scheduler_authority_unavailable'].includes(error.message))throw error;
      q("UPDATE runs SET status='needs_review',last_error=?,ended_at=unixepoch() WHERE id=? AND status='queued'").run(error.message+'; restart hold; no replay',run.id);
      event(run.id,'task.scheduler_recovery_held',{reason:error.message,noReplay:true});
    }
  }
  for(const run of q("SELECT DISTINCT bot_id FROM runs WHERE status='waiting_tool'").all())if(!botStatus.has(run.bot_id))setStatus(run.bot_id,'waiting','Waiting for a new tool');
}
// Standing user guidance and memories imported from Codex (bin/import-codex.mjs).
// The guidance is short and applies to every worker; memories stay in shared notes.
export function importedCodexGuidance(dir=path.join(DATA_DIR,'shared','codex')){
  let text='';
  try{text=fs.readFileSync(path.join(dir,'AGENTS.md'),'utf8').trim().slice(0,8000);}catch{}
  const memories=fs.existsSync(path.join(dir,'memory_summary.md'));
  if(!text&&!memories)return '';
  return '\nUser guidance imported from Codex (applies to every Nimbus worker):\n'+(text||'(none)')+(memories?'\nPrior Codex memories are in shared notes under codex/ (memory_summary.md first, then MEMORY.md and rollout_summaries/). Read them with shared_note when the task may relate to earlier work; recheck time-sensitive facts.':'');
}
function usableCloud(status,c) {
  if(!c.cloud.enabled || !status.subscription) return false;
  const limits=status.limits;
  if(limits?.ordinaryUsageAllowed===false || limits?.rateLimits?.spendControlReached || limits?.rateLimits?.rateLimitReachedType) return false;
  const r=limits?.rateLimits; return ![r?.primary,r?.secondary].some(w=>w && w.usedPercent>=100);
}
export function approvePendingPermissions() {
  if(config().workers.permissionMode!=='all')return;
  const pending=q("SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.status='pending' AND r.status='waiting_approval'").all();
  for(const a of pending){
    const note='Approved automatically by All permissions mode';
    q("UPDATE approvals SET status='approved',note=?,decided_at=unixepoch() WHERE id=? AND status='pending'").run(note,a.id);
    for(const msg of q("SELECT id,body FROM messages WHERE kind='approval' AND run_id=?").all(a.run_id)){
      const value=JSON.parse(msg.body);if(value.approvalId===a.id)updateMessage(msg.id,{...value,status:'approved',note});
    }
    markTraceWaiting(a.run_id,a.tool,false);
    event(a.run_id,'approval.auto_approved',{approvalId:a.id,tool:a.tool,permissionMode:'all'});
  }
  if(pending.length)broadcast('approvals_changed',{});
}
async function approval(bot,run,name,args,signal) {
  if(!requiresApproval(bot,name,args,config().workers.permissionMode)) return;
  const r=q('INSERT INTO approvals (run_id,bot_id,thread,tool,input) VALUES (?,?,?,?,?)').run(run.id,bot.id,run.thread,name,encodeRedacted(args));
  const id=Number(r.lastInsertRowid);
  addMessage(run.thread,bot.id,'approval',{approvalId:id,tool:name,input:args,status:'pending'},run.id);
  q("UPDATE runs SET status='waiting_approval' WHERE id=?").run(run.id); markTraceWaiting(run.id,name,true); broadcast('approvals_changed',{});
  try {
    for(;;) {
      signal.throwIfAborted();
      approvePendingPermissions();
      const row=q('SELECT status,note FROM approvals WHERE id=?').get(id);
      if(row?.status==='approved') return;
      if(row?.status!=='pending') throw Object.assign(new Error(`Nimbus: rejected. ${row?.note||'Approval was not granted.'} Do not repeat this action.`),{hostDenied:true});
      await new Promise((resolve,reject)=>{const t=setTimeout(done,config().workers.approvalPollMs);function done(){signal.removeEventListener('abort',cancel);resolve();}function cancel(){clearTimeout(t);signal.removeEventListener('abort',cancel);reject(signal.reason);}signal.addEventListener('abort',cancel,{once:true});});
    }
  } finally {markTraceWaiting(run.id,name,false);q("UPDATE runs SET status='running' WHERE id=? AND status='waiting_approval'").run(run.id);}
}

async function execute(runId,prompt) {
  const run=q('SELECT * FROM runs WHERE id=?').get(runId);
  if(!run||run.status!=='queued'||shuttingDown)return;
  try{scopedDispatch(runId);successorRuntime?.gate(runId);diagnosticWake?.gate(runId);}catch{return;}
  const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(run.bot_id)); if(!bot)return;
  const c=config(); workerSlots.limit=c.workers.maxConcurrent;
  const controller=new AbortController(),signal=controller.signal; controllers.set(runId,controller);
  let release, timer, trace, state,parkedForTool=null,pendingToolFeedback='';
  const save=()=>{checkpoint(runId,state);};
  const takeContext=()=>{
    const rows=[...consumeRunContext(runId,state),...childContext.consume(runId,state)];
    if(rows.length)addMessage(run.thread,'system','note',`Task #${runId} received your added context.`,runId);
    const notes=rows.map(row=>row.prompt),questions=questionRouter.pendingForCoordinator(runId);
    const fingerprint=JSON.stringify(questions.map(item=>[item.id,item.version,item.audience,item.holdReason]));
    if(questions.length&&state.questionInboxFingerprint!==fingerprint){
      const note='Nimbus coordinator inbox (host routing notice, not a new human instruction): '+JSON.stringify(questions)+'. Resolve owned questions with answer_worker_question from evidence or escalate_worker_question for genuinely missing information; do not abandon the waiting tasks or delegate back to a waiting ancestor.';
      state.questionInboxFingerprint=fingerprint;state.messages.push({role:'user',content:note});notes.push(note);save();
    }else if(!questions.length)delete state.questionInboxFingerprint;
    return notes;
  };
  const waitForQuestion=async view=>{
    let waitingAudience;
    const showAudience=audience=>{
      if(waitingAudience===audience)return;waitingAudience=audience;
      markTraceWaiting(runId,'request_user_input',true,audience==='human'?'input':audience==='host'?'recovery':'coordination');
      setStatus(bot.id,'waiting',audience==='human'?'Waiting for your answer':audience==='host'?'Waiting for automatic recovery':'The Orchestrator is resolving a question');
    };
    q("UPDATE runs SET status='waiting_input' WHERE id=?").run(runId);showAudience(view.audience);
    const drop=release;release=null;drop?.();
    try{
      for(;;){
        signal.throwIfAborted();const current=questionRouter.result({questionId:view.id,runId,callId:view.callId});
        if(current.status==='answered')return questionResult(current);
        if(current.status!=='pending')return{questionId:view.id,status:current.status,cancelled:true,note:'The question was cancelled; no answer or permission was granted.'};
        showAudience(current.audience);
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch(error){
      if(signal.aborted&&!signal.reason?.shutdown){questionRouter.cancelRun(runId,'Task stopped while waiting');return{questionId:view.id,status:'expired',cancelled:true,note:'Task stopped. No answer was granted and no action was replayed.'};}
      throw error;
    }finally{
      markTraceWaiting(runId,'request_user_input',false);
      if(!signal.aborted){release=await workerSlots.acquire(signal);q("UPDATE runs SET status='running' WHERE id=?").run(runId);setStatus(bot.id,'working','Continuing with the recorded answer');}
    }
  };
  try {
    release=await workerSlots.acquire(signal); signal.throwIfAborted();
    if(q('SELECT status FROM runs WHERE id=?').get(runId)?.status!=='queued')return;
    successorRuntime?.gate(runId);diagnosticWake?.gate(runId);
    const cwd=writeBotBrief(bot),isRoom=run.thread.startsWith('room:');
    const existing=run.checkpoint?JSON.parse(run.checkpoint):null;
    // Lumos topics are single-member rooms with their own continuing conversation.
    // Orchestrator tasks submitted with source lumos stay isolated like before.
    const keepConversation=!run.parent_run&&(isRoom?run.source==='lumos':!['schedule','tool-development','api','hermes','lumos','openbubbles'].includes(run.source));
    // Delegated assignments and incoming integration jobs own their checkpoints
    // and supplied context. Borrowing another conversation can mix old results
    // into a different request or redirect an upstream task's follow-up.
    const history=keepConversation?q('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(bot.id,run.thread):null;
    const memory=fs.readFileSync(path.join(cwd,'MEMORY.md'),'utf8');
    state=existing?reconcileCheckpoint(runId,existing):{messages:history?JSON.parse(history.messages):[],instructions:fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8')+importedCodexGuidance()+'\nPrivate working memory:\n'+memory,steps:0};
    hydrateCompletion(db,runId,state);
    if(existing&&successorRuntime){state=successorRuntime.initialize(runId,state,fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8')+'\nPrivate working memory:\n'+memory);save();}
    if(!existing) {
      const scheduledQuiet=run.source==='schedule'&&run.quiet;
      const quiet=run.quiet&&!scheduledQuiet?'\nThis is a quiet check. Reply ALL_CLEAR and a short status if no action is needed.':'';
      if(scheduledQuiet)state.messages.push({role:'user',content:'Delivery context: this scheduled task is quiet. Perform the following task unchanged and retain its result without external notification. Higher-priority safety instructions still apply.'});
      state.messages.push({role:'user',content:(isRoom&&run.source!=='lumos'?roomContext(Number(run.thread.slice(5)))+'\nCurrent task:\n':'')+prompt+quiet}); save();
    }
    q("UPDATE runs SET status='routing',started_at=COALESCE(started_at,unixepoch()),ended_at=NULL WHERE id=?").run(runId);
    const body={steps:[],status:'running',effort:bot.effort,started:Date.now(),source:run.source};
    const msg=addMessage(run.thread,bot.id,'trace',body,runId); trace={id:msg.id,body,waited:0,waitStart:null}; traces.set(runId,trace);
    // Resume the exact durable local wait, never invoke request_user_input again.
    for(const call of q("SELECT * FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain')").all(runId)){
      if(!pendingQuestionCall(call))throw new UncertainAction('A retained action requires review before continuing.');
      const result=await waitForQuestion(questionRouter.getForCall(runId,call.id));
      q("UPDATE tool_calls SET state='done',result=?,ended_at=unixepoch() WHERE id=?").run(encodeRedacted(result),call.id);
      if(result.status==='answered')questionRouter.markDelivered({questionId:result.questionId,runId,callId:call.id});
      event(runId,'question.wait_reattached',{questionId:result.questionId,callId:call.id});
    }
    state=reconcileCheckpoint(runId,state);save();signal.throwIfAborted();
    timer=setInterval(()=>{const elapsed=Date.now()-body.started-trace.waited-(trace.waitStart?Date.now()-trace.waitStart:0);if(taskTimeExceeded(c.workers,elapsed))controller.abort(Object.assign(new Error('Task time limit reached; checkpoint retained'),{projectLimit:true}));},1000);
    setStatus(bot.id,'working','Local model choosing a route…');
    const status=await cloudStatus(); const cloudAllowed=usableCloud(status,c);
    const claudeAccount=await claudeStatus(); const claudeAllowed=claudeAccount.ok===true;
    const modelFor=tier=>tier==='local'?c.local.model:isClaudeTier(tier)?resolveClaudeModel(tier,c):resolveCloudModel(tier,status,c);
    // Only models the connected plans include: the live Codex catalog for OpenAI,
    // the Claude plan (and models it refused at run time) for Claude.
    const openaiTiers=new Set(openaiCatalogTiers(status,c));
    const tierAvailable=tier=>tier==='local'?c.local.enabled:isClaudeTier(tier)?claudeAllowed&&(claudeAccount.allowedTiers||[]).includes(tier)&&claudeModelAvailable(resolveClaudeModel(tier,c)):cloudAllowed&&openaiTiers.has(tier);
    let route;
    try{route=state.providerRecovery?retainedRecoveryRoute(state.providerRecovery,state.route,recoverySelection(bot)):await chooseRoute({task:prompt,role:[bot.template,bot.name,bot.role].filter(Boolean).join(' — '),preferredTier:bot.default_model||'',pinned:bot.model||bot.runtime,effort:bot.effort,signal,cloudAvailable:cloudAllowed,claudeAvailable:claudeAllowed,tierAvailable,c});}
    catch(e){if(signal.aborted)throw e;throw Object.assign(new Error(`Could not choose an available model: ${e.message}. Task checkpoint retained.`),{pause:true});}
    if(state.providerRecovery)assertRecoveryRoute(state.providerRecovery,{model:modelFor(route.tier),backend:backendOf(route.tier),provider:providerOf(route.tier),fallback:!!route.fallbackReason});
    state.route=route; save();
    q('UPDATE runs SET requested_model=?,route_reason=?,effort=? WHERE id=?').run(bot.model||route.tier,route.reason,route.effort,runId);
    event(runId,'route.selected',route); body.route=route; updateMessage(trace.id,body);
    if(route.fallbackReason){
      q('UPDATE runs SET fallback_reason=? WHERE id=?').run(redact(route.fallbackReason),runId);
      body.fallback=route.fallbackReason;updateMessage(trace.id,body);
      event(runId,'model.fallback',{from:route.fallbackFrom,to:route.tier,phase:'routing',reason:route.fallbackReason,completedTools:state.steps});
    }
    const openBubblesAuthority=runAuthority(runId);
    const conversationOnly=run.delegation_scope==='conversation';
    let available=await buildTools(bot,{openBubblesAuthority,conversationOnly});
    const inspection=toolDevelopment.inspectionForRun(runId);
    if(inspection){
      const readTools=new Set(['read_file','list_files','code_search','project_map','git_diff','git_inspect','file_manifest','host_snapshot','task_history','log_read','tool_catalog','connector_inventory','view_image']);
      if(inspection.kind==='source_review')readTools.add('self_update');
      available={...available,tools:available.tools.filter(tool=>readTools.has(tool.function.name)||tool.function.name==='write_file'||available.bindings.get(tool.function.name)?.readOnly===true).map(tool=>tool.function.name==='self_update'?{...tool,function:{...tool.function,description:'Read-only source identity and maintenance status for this independent source review. Only action=status is permitted.',parameters:{...tool.function.parameters,properties:{...tool.function.parameters.properties,action:{type:'string',enum:['status']}}}}}:tool)};
      const names=new Set(available.tools.map(tool=>tool.function.name));available.bindings=new Map([...available.bindings].filter(([name])=>names.has(name)));
    }
    const attention=questionRouter.attentionForRun?.(runId);
    if(attention){const names=new Set(['question_inbox','answer_worker_question','escalate_worker_question','team_status','task_history','shared_note']);available={...available,tools:available.tools.filter(tool=>names.has(tool.function.name)),bindings:new Map()};}
    const allowed=new Set(available.tools.map(t=>t.function.name));
    const currentExecutionPreflight=()=>executionPreflight(available.tools,config().workers.permissionMode);
    const continueIncompleteStage=()=>{
      hydrateCompletion(db,runId,state);
      const lifecycle=toolDevelopment.completionForRun(runId,state);
      const result=lifecycle.action!=='complete'?lifecycle:delegatedCompletionDecision({binding:state.delegatedCompletion,requiredCompletion:state.requiredCompletion===true,run:q('SELECT * FROM runs WHERE id=?').get(runId),signal,rows:q('SELECT * FROM tool_calls WHERE run_id=? ORDER BY rowid').all(runId)},state);
      if(result.action==='complete')return false;
      if(result.action==='hold'){
        if(result.code==='no_progress')state.noProgress=true;
        save();
        throw Object.assign(new Error(result.feedback||'Lifecycle completion requires review'),{pause:true,code:result.code});
      }
      state.messages.push({role:'user',content:result.feedback});
      event(runId,'stage.completion_incomplete',{requestId:result.requestId,phase:result.phase,code:result.code});
      save();reply=null;
      return true;
    };
    const continuePendingQuestions=async()=>{
      let pending=questionRouter.pendingForCoordinator(runId);if(!pending.length){delete state.questionCompletionGate;return false;}
      if(state.noProgress)throw Object.assign(new Error('Coordinator has unresolved questions and a retained no-progress hold'),{pause:true});
      const actionable=pending.filter(item=>item.audience==='coordinator');
      if(actionable.length){
        const fingerprint=JSON.stringify(actionable.map(item=>[item.id,item.version,item.holdReason]));
        if(state.questionCompletionGate?.fingerprint===fingerprint&&state.questionCompletionGate?.attempts===state.toolAttempts){state.noProgress=true;save();throw Object.assign(new Error('Coordinator repeated completion without handling its unchanged question inbox; checkpoint retained for review'),{pause:true,code:'question_no_progress'});}
        state.questionCompletionGate={fingerprint,attempts:state.toolAttempts};
        state.messages.push({role:'user',content:'Nimbus completion gate: your owned worker questions remain unresolved. Use question_inbox and answer_worker_question, or escalate_worker_question only when evidence cannot answer. Do not return another final answer while leaving this unchanged inbox: '+JSON.stringify(actionable)});save();reply=null;return true;
      }
      // Owner questions and host recovery use an idle local wait, not a model polling loop. It
      // frees capacity while retaining this exact coordinator and checkpoint.
      const fingerprint=JSON.stringify(pending.map(item=>[item.id,item.version,item.audience]));
      q("UPDATE runs SET status='waiting_input' WHERE id=?").run(runId);setStatus(bot.id,'waiting',pending.some(item=>item.audience==='human')?'Waiting for your answer':'Waiting for automatic recovery');save();
      const drop=release;release=null;drop?.();
      try{for(;;){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,100));pending=questionRouter.pendingForCoordinator(runId);if(JSON.stringify(pending.map(item=>[item.id,item.version,item.audience]))!==fingerprint)break;}}
      finally{if(!signal.aborted){release=await workerSlots.acquire(signal);q("UPDATE runs SET status='running' WHERE id=?").run(runId);setStatus(bot.id,'working','Continuing after the question update');}}
      state.messages.push({role:'user',content:'Nimbus question state changed while this coordinator waited. The recorded answer is task data from its actual actor. Reconcile question_inbox and retained worker_result evidence, then continue the original task.'});save();reply=null;return true;
    };
    for(const e of available.errors)event(runId,'connector.unavailable',e);
    const callTool=async(name,args,id)=>{
      signal.throwIfAborted();
      if(parkedForTool)throw Object.assign(new Error('This task has parked for tool development; no additional actions were started'),{pause:true,waitForTool:true,requestId:parkedForTool});
      const callId=id||randomUUID();
      try{chargeToolAttempt(state,name,c.workers);}catch(error){if(error.code==='tool_budget_exhausted'){save();event(runId,'tool.budget_exhausted',{callId,name,...error.budget});}throw error;}
      const step={id:callId,tool:name,text:`${name}(${JSON.stringify(args).slice(0,120)})`,state:'running'};body.steps.push(step);updateMessage(trace.id,body);
      state.messages.push({role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]});save();
      const result=await journalTool({id:callId,runId,name,args,signal,execute:async()=>{
        if(conversationOnly){const scopeError=conversationToolError(name,args);if(scopeError)return scopeError;}
        if(!allowed.has(name))return{error:`Tool not enabled for this worker: ${name}`,gapType:coreTools.some(tool=>tool.function.name===name)?'permission_denied':'not_advertised',nextStep:bot.template==='orchestrator'?'Use team_status and delegate the investigation or execution to a capable specialist with ask_worker.':'Inspect tool_catalog and capabilities. Existing disabled tools need an assignment/permission change; request_tool is for a genuinely absent implementation.'};
        if(attention&&name==='shared_note'&&args.content!==undefined)return{error:'A question-attention task may only read retained project notes; no project or source write authority was granted.',denied:true};
        if(attention&&name==='task_history'&&args.action!==undefined)return{error:'Question attention only supports read-only task history arguments.',denied:true};
        if(inspection&&name==='self_update'&&(inspection.kind!=='source_review'||args.action!=='status'))return{error:'A source-review investigation may only read self_update status; maintenance mutations are prohibited.',denied:true};
        if(inspection&&name==='write_file'){
          const target=path.resolve(cwd,String(args.path||''));
          if(target!==path.resolve(inspection.artifact_path))return{error:'An investigation may write only its assigned evidence report.'};
          for(let current=target;current!==path.dirname(current);current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())return{error:'Investigation report paths must not follow symbolic links.'};
        }
        const approvalArgs=name==='run_checks'?{...args,command:specialistPolicyCommand(name,args,{workspace:cwd})}:args;
        await approval(bot,run,name,approvalArgs,signal);
        q("UPDATE runs SET status='running' WHERE id=?").run(runId);
        scopedDispatch(runId);
        return executeTool(bot,name,args,{signal,openBubblesAuthority,bindings:available.bindings,availableTools:available.tools,connectorErrors:available.errors,runId,
          sendChildContext:args=>childContext.queue({runId,botId:bot.id},args),
          questionInbox:args=>questionRouter.inbox({runId,botId:bot.id,callId:`${runId}:${callId}`},args),
          answerWorkerQuestion:args=>questionRouter.answer(args,{runId,botId:bot.id,callId:`${runId}:${callId}`}),
          escalateWorkerQuestion:args=>questionRouter.escalate(args,{runId,botId:bot.id,callId:`${runId}:${callId}`}),
          requestTool:request=>toolDevelopment.request({run,bot,args:request,availableTools:available.tools,connectorErrors:available.errors,requestKey:`${runId}:${callId}`}),
          toolRequestStatus:requestId=>{
            const connected=toolDevelopment.list({runId,botId:bot.id,limit:50}).requests;
            if(!requestId)return{requests:connected.map(toolRequestSummary)};const item=connected.find(request=>String(request.id)===String(requestId));if(!item)throw new Error('This tool-development request is not connected to your worker/task');return toolRequestSummary(item);
          },
          projectRecovery:args=>recoverProjectRequest(runId,bot.id,args,`${runId}:${callId}`),
          projectSuccessorHandoff:args=>args.action==='status'?projectSuccessorHandoffs.status(args.reservationId,{runId,botId:bot.id,requestKey:`${runId}:${callId}`}):projectSuccessorHandoffs.command(args,{runId,botId:bot.id,requestKey:`${runId}:${callId}`}),
          updatePlan:async plan=>{state.plan=plan;save();body.plan=plan;updateMessage(trace.id,body);event(runId,'plan.updated',plan);return{saved:true,...plan};},
          askUser:async (questions,{destination}={})=>{
            const view=questionRouter.create({runId,callId:`${runId}:${callId}`,questions,destination});
            try{ensureQuestionAttention(view.id);}catch(error){recordQuestionAttentionError(view.id,error);}
            return waitForQuestion(view);
          },
          askWorker:async request=>askFromWorker(bot,run,request),workerResult:async id=>{
            const owned=q('SELECT id,parent_run,status FROM runs WHERE id=?').get(Number(id));
            if(!owned||owned.parent_run!==runId)throw new Error('Only collect tasks delegated by this run');
            const drop=release;release=null;drop?.();markTraceWaiting(runId,'worker_result',true,'delegated');setStatus(bot.id,'waiting','Waiting for delegated work');
            try{
              const until=Date.now()+60000;
              while(Date.now()<until){signal.throwIfAborted();const child=taskResult(id),inbox=questionRouter.pendingForCoordinator(runId);if(inbox.length||child.questions.length||['done','error','stopped','paused','interrupted','needs_review','waiting_tool','waiting_input'].includes(child.status))return{...child,coordinatorQuestions:inbox};await new Promise(r=>setTimeout(r,100));}
              return taskResult(id);
            }finally{markTraceWaiting(runId,'worker_result',false);release=await workerSlots.acquire(signal);if(!signal.aborted)setStatus(bot.id,'working','Collecting delegated results');}
          }});
      }});
      if(name==='request_user_input'&&result?.status==='answered')questionRouter.markDelivered({questionId:result.questionId,runId,callId:`${runId}:${callId}`});
      state.messages.push({role:'tool',tool_call_id:callId,content:JSON.stringify(result)});step.state=result?.error?'error':'done';pendingToolFeedback=toolBudgetFeedback(state,c.workers);if(pendingToolFeedback)state.messages.push({role:'user',content:'Nimbus host budget notice: '+pendingToolFeedback});save();updateMessage(trace.id,body);
      if(c.workers.executionMode==='progress') {
        const child=name==='worker_result'?q('SELECT id,parent_run,status FROM runs WHERE id=?').get(Number(args.runId)):null;
        const childProgress=child?.parent_run===runId?q('SELECT max(id) AS last FROM task_events WHERE run_id=?').get(child.id)?.last:null;
        const ownedChildWaiting=child?.parent_run===runId&&ownedRunIds.has(child.id)&&['queued','routing','running','waiting_input','waiting_local','waiting_cloud'].includes(child.status)&&!result?.error;
        try{observeProgress(state,name,args,result,{childProgress,ownedChildWaiting});}finally{save();}
      }
      if(result?.denied)throw Object.assign(new Error(result.error),{pause:true,hostDenied:true});
      const waitingRequest=name==='request_tool'&&result?.awaitingTool?result.requestId:name==='worker_result'&&result?.status==='waiting_tool'?result.toolRequests?.find(request=>!['ready','blocked','cancelled','needs_review'].includes(request.status))?.id:null;
      if(waitingRequest){
        if(name==='worker_result')toolDevelopment.watch(waitingRequest,runId,{consumer:false});
        parkedForTool=waitingRequest;state.awaitingToolRequest=waitingRequest;save();throw Object.assign(new Error('Waiting for verified tool development; progress is retained with the original request'),{pause:true,waitForTool:true,requestId:waitingRequest});
      }
      return result;
    };
    let tier=route.tier,reply=null;const attempted=new Set();
    for(let attempt=0;attempt<c.routing.maxAttempts;attempt++) {
      signal.throwIfAborted();attempted.add(tier);
      let model=tier==='local'?c.local.model:tier;
      try {
        model=modelFor(tier);
        assertRecoveryRoute(state.providerRecovery,{model,backend:backendOf(tier),provider:providerOf(tier)});
        q("UPDATE runs SET status='running',backend=?,actual_model=? WHERE id=?").run(backendOf(tier),model,runId);
        body.model=model;setStatus(bot.id,'working',`Working with ${model}`);updateMessage(trace.id,body);event(runId,'model.started',{tier,model});
        if(tier==='local') {
          for(;;) {
            signal.throwIfAborted();
            takeContext();
            const input=state.messages;
            q("UPDATE runs SET status='waiting_local' WHERE id=?").run(runId);
            scopedDispatch(runId);
            const r=await localChat([{role:'system',content:state.instructions+'\n'+currentExecutionPreflight()},...input],{tools:available.tools,signal,c});
            signal.throwIfAborted();
            if(q("UPDATE runs SET status='running' WHERE id=? AND status IN ('waiting_local','running')").run(runId).changes!==1)throw Object.assign(new Error('Provider completed after a terminal state change; retained for review'),{pause:true});
            recordUsage(runId,r.usage,body);body.context=r.usage.prompt_tokens;body.contextWindow=r.contextTokens;
            body.model=r.model;
            q('UPDATE runs SET actual_model=? WHERE id=?').run(r.model,runId);
            const calls=r.message.tool_calls||[];
            if(!calls.length){
              reply=r.message.content||'';
              state.messages.push({role:'assistant',content:reply});
              if(takeContext().length){reply=null;continue;}
              if(await continuePendingQuestions())continue;
              if(continueIncompleteStage())continue;
              state.messages.pop();break;
            }
            for(const call of calls){let args;try{args=JSON.parse(call.function.arguments||'{}');}catch{throw new Error('Local model returned invalid tool arguments');}await callTool(call.function.name,args,call.id||randomUUID());}
          }
        } else {
          for(;;){
          takeContext();
          q("UPDATE runs SET status='waiting_cloud' WHERE id=?").run(runId);
          scopedDispatch(runId);
          const r=await (isClaudeTier(tier)?claudeTurn:codexTurn)({model,effort:route.effort,instructions:state.instructions+'\n'+currentExecutionPreflight(),messages:state.messages,tools:available.tools,callTool,contextFeedback:takeContext,toolFeedback:()=>{const note=pendingToolFeedback;pendingToolFeedback='';return note;},cwd,signal,
            onThread:id=>{q('UPDATE runs SET session_id=? WHERE id=?').run(id,runId);event(runId,isClaudeTier(tier)?'claude.session':'codex.thread',{id});},
            onEvent:(name,data)=>{if(name==='provider_error')event(runId,'provider.error',data);else if(name==='provider_activity')event(runId,'provider.activity',{phase:data.phase,kind:data.kind,activitySequence:data.activitySequence,activityAtMs:data.activityAtMs});else if(name==='provider_silence')event(runId,'provider.silence',{code:data.code,phase:data.phase,silentMs:data.silentMs});}});
          signal.throwIfAborted();
          if(q("UPDATE runs SET status='running' WHERE id=? AND status IN ('waiting_cloud','running')").run(runId).changes!==1)throw Object.assign(new Error('Provider completed after a terminal state change; retained for review'),{pause:true});
          reply=r.text;recordUsage(runId,r.usage,body);q('UPDATE runs SET actual_model=? WHERE id=?').run(r.model,runId);
          if(r.unconsumedToolResults?.length){
            state.messages.push({role:'user',content:'Nimbus retained completed tool results after the provider ended its previous turn before receiving them: '+JSON.stringify(r.unconsumedToolResults)+'. Read those exact checkpoint results and continue the original task. Do not replay completed calls or repeat a resolved question. A final answer is appropriate if the actual requested work is complete.'});
            event(runId,'model.results_unconsumed',{calls:r.unconsumedToolResults});save();reply=null;continue;
          }
          // Context may arrive during a final inference with no tool boundary.
          // Continue this run before publishing its answer, retaining all receipts.
          state.messages.push({role:'assistant',content:reply});
          if(takeContext().length){reply=null;continue;}
          if(await continuePendingQuestions())continue;
              if(continueIncompleteStage())continue;
          state.messages.pop();break;
          }
        }
        break;
      } catch(e) {
        save();if(signal.aborted||e instanceof UncertainAction||e.pause)throw e;
        if(state.providerRecovery)throw Object.assign(e,{pause:true});
        event(runId,'model.failed',{tier,model,error:e.message});
        // Next best: the evidence-ranked candidates when both subscriptions are in play,
        // then the original local/cloud alternation.
        const rankedNext=(route.candidates||[]).find(t=>!attempted.has(t)&&tierAvailable(t)&&!(isClaudeTier(t)&&e.code==='claude_limit'&&isClaudeTier(tier)));
        const next=rankedNext||(tier!=='local'?'local':route.fallbackTier!=='local'?route.fallbackTier:(()=>{try{return cloudFallbackTier(bot.default_model||'',c,t=>tierAvailable(t)&&!attempted.has(t));}catch{return 'local';}})());
        if(attempted.has(next)||!tierAvailable(next))throw Object.assign(e,{pause:true});
        q('UPDATE runs SET fallback_reason=? WHERE id=?').run(redact(e.message),runId);
        body.fallback=e.message;const from=tier;tier=next;event(runId,'model.fallback',{from,to:tier,phase:'execution',reason:e.message,completedTools:state.steps});
      }
    }
    if(reply==null)throw Object.assign(new Error('Model attempts exhausted; checkpoint retained.'),{pause:true});
    if(!String(reply).trim())throw Object.assign(new Error('The worker returned an empty result; checkpoint retained.'),{pause:true});
    if(questionRouter.pendingForCoordinator(runId).length)throw Object.assign(new Error('A question arrived at completion; retained coordinator requires continuation'),{pause:true,code:'question_completion_race'});
    state.messages.push({role:'assistant',content:reply});save();
    if(keepConversation)q('INSERT INTO worker_history (bot_id,thread,messages) VALUES (?,?,?) ON CONFLICT(bot_id,thread) DO UPDATE SET messages=excluded.messages,updated_at=unixepoch()').run(bot.id,run.thread,encodeRedacted(state.messages));
    finalizeCompletion(db,runId,state,signal);
    body.status='done';body.ended=Date.now();updateMessage(trace.id,body);
    const scheduledQuiet=run.source==='schedule'&&run.quiet;
    const quiet=scheduledQuiet||(run.quiet&&/^\s*ALL_CLEAR\b/.test(reply));
    const final=addMessage(run.thread,bot.id,quiet?'quiet':'text',quiet&&!scheduledQuiet?reply.replace(/^\s*ALL_CLEAR\b[\s:—-]*/,''):reply,runId);
    event(runId,'task.completed',{model:q('SELECT actual_model FROM runs WHERE id=?').get(runId).actual_model});
    if(run.source!=='openbubbles'&&isRoom&&final.kind==='text'&&run.depth<4&&q('SELECT bots_can_talk FROM rooms WHERE id=?').get(Number(run.thread.slice(5)))?.bots_can_talk) {
      for(const target of findMentions(reply,roomMembers(Number(run.thread.slice(5))),bot.id))runBot({botId:target.id,thread:run.thread,prompt:`${bot.name} said: ${reply}`,depth:run.depth+1,source:bot.name,parentRun:runId});
    }
  } catch(e) {
    const uncertain=q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(runId);
    const projectLimit=e.code==='tool_budget_exhausted'||signal.reason?.projectLimit===true;
    if(state){
      state.projectLimit=projectLimit;
      if(e.code==='provider_inference_silence'&&!signal.aborted&&!uncertain&&!e.hostDenied)
        {const retained=q('SELECT actual_model AS model,backend FROM runs WHERE id=?').get(runId);state.providerRecovery={code:e.code,...retained,provider:retained.backend==='claude'?'anthropic':'openai',selection:recoverySelection(bot)};}
      else delete state.providerRecovery;
      if(e.hostDenied)state.hostDenied=true;
      save();
    }
    const outcome=e instanceof UncertainAction||e.needsReview||uncertain?'needs_review':signal.aborted?(signal.reason?.shutdown?'interrupted':projectLimit?'paused':'stopped'):e.waitForTool?'waiting_tool':e.pause?'paused':'error';
    q("UPDATE runs SET status=?,last_error=?,ended_at=unixepoch() WHERE id=? AND status NOT IN ('stopped','done','needs_review')").run(outcome,redact(e.message),runId);
    if(trace){trace.body.status=outcome;trace.body.ended=Date.now();for(const s of trace.body.steps)if(['running','waiting'].includes(s.state))s.state=outcome==='needs_review'?'error':outcome;updateMessage(trace.id,trace.body);}
    if(outcome!=='waiting_tool')addMessage(run.thread,'system',outcome==='stopped'?'note':'error',`${outcome==='needs_review'?'Action needs review. ':outcome==='paused'?'Task paused. ':''}${e.message}`,runId);
    event(runId,'task.'+outcome,{error:outcome==='waiting_tool'?undefined:e.message,requestId:e.requestId,code:e.code,budget:e.budget});
  } finally {
    clearInterval(timer);release?.();controllers.delete(runId);traces.delete(runId);
    if(bot.template==='orchestrator'&&!shuttingDown)queueMicrotask(()=>{try{reconcileQuestionAttention();}catch(error){console.error('Question attention reconciliation failed:',redact(error.message));}});
    q("UPDATE approvals SET status='expired',decided_at=unixepoch() WHERE run_id=? AND status='pending'").run(runId);broadcast('approvals_changed',{});
    const queued=q("SELECT COUNT(*) AS n FROM runs WHERE bot_id=? AND status='queued'").get(bot.id).n;
    const waiting=q("SELECT id FROM runs WHERE bot_id=? AND status='waiting_tool' LIMIT 1").get(bot.id);
    setStatus(bot.id,queued?'queued':waiting?'waiting':'idle',queued?'Queued':waiting?'Waiting for a new tool':'Idle');broadcast('state_changed',{});
  }
}
function recordUsage(runId,u,body) {
  q('UPDATE runs SET input_tokens=input_tokens+?,output_tokens=output_tokens+? WHERE id=?').run(u.prompt_tokens??u.inputTokens??0,u.completion_tokens??u.outputTokens??0,runId);
  const totals=q('SELECT input_tokens,output_tokens FROM runs WHERE id=?').get(runId);
  body.tokens={in:totals.input_tokens,out:totals.output_tokens};
}
export function prepareLocalContext(messages,contextTokens) {
  return fitInferenceMessages(messages,{maxChars:Math.floor(Math.min(240000,contextTokens*2.5))});
}
export function reconcileCheckpoint(runId,state) {
  const repaired=[];
  for(let index=0;index<state.messages.length;index++){
    const message=state.messages[index];repaired.push(message);
    for(const call of message.tool_calls||[]){
      if(state.messages.some(m=>m.role==='tool'&&m.tool_call_id===call.id))continue;
      const tool=q('SELECT * FROM tool_calls WHERE id=?').get(`${runId}:${call.id}`);
      if(tool&&['running','uncertain'].includes(tool.state)&&pendingQuestionCall(tool))continue;
      if(tool&&['running','uncertain'].includes(tool.state))throw new UncertainAction('A retained action requires review before this checkpoint can continue.');
      const result=tool?.result?JSON.parse(tool.result):{notExecuted:true,note:'Nimbus stopped before this action began. No action was replayed.'};
      repaired.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    }
  }
  state.messages=repaired;return state;
}
function askFromWorker(bot,run,{to,task,context='',executionScope,completionDescriptor}) {
  try{compileRequiredCompletion(executionScope,completionDescriptor);}catch(e){return {status:'setup_hold',hold:true,knownNonexecution:true,code:e.code,error:e.message};}
  const matches=q('SELECT id,name,tools FROM bots').all().filter(b=>String(b.id)===String(to).replace(/^#/,'')||b.name.toLowerCase()===String(to).toLowerCase());
  if(matches.length!==1)throw new Error('Choose a worker by its exact name or ID');
  const target=matches[0];const completionOwnedRoot=path.join(DATA_DIR,'bots',String(target.id),'artifacts');
  if(executionScope==='execution'){
    let enabled;
    try{const names=JSON.parse(target.tools||'[]');if(!Array.isArray(names)||names.some(name=>typeof name!=='string'))throw new Error('Invalid tool list');enabled=new Set(names);}
    catch{return{status:'setup_hold',hold:true,knownNonexecution:true,code:'completion_tool_unavailable',target:{id:target.id,name:target.name},error:'The target worker has an invalid configured tool list; repair its profile before assigning execution.'};}
    const missingTools=['run_checks','read_file'].filter(name=>!enabled.has(name));
    if(missingTools.length)return{status:'setup_hold',hold:true,knownNonexecution:true,code:'completion_tool_unavailable',target:{id:target.id,name:target.name},missingTools,error:'The target worker cannot satisfy required completion: missing '+missingTools.join(', ')+'. Choose a properly configured worker or have the authenticated host correct the profile. No child was created and no tools were enabled.'};
  }
  let completionContract;
  try{completionContract=compileRequiredCompletion(executionScope,completionDescriptor,completionOwnedRoot);}catch(e){return {status:'setup_hold',hold:true,knownNonexecution:true,code:e.code,error:e.message};}
  const ancestors=new Set([bot.id]);
  for(let id=run.parent_run,n=0;id&&n<8;n++){const parent=q('SELECT bot_id,parent_run FROM runs WHERE id=?').get(id);if(!parent)break;ancestors.add(parent.bot_id);id=parent.parent_run;}
  if(ancestors.has(target.id)||run.depth>=4)throw new Error('This handoff would create a cycle or exceed the handoff depth');
  const thread='bot:'+target.id;addMessage(thread,'system','note',`${bot.name} assigned: ${task}`);
  const completionContext=executionScope==='conversation'?conversationAssignmentContext:completionAssignmentContext(completionContract);
  const id=runBot({botId:target.id,thread,prompt:`Task from ${bot.name}: ${task}\nContext: ${context}${completionContext}\nReturn your result through Nimbus.`,source:bot.name,parentRun:run.id,depth:run.depth+1,completionDescriptor,completionOwnedRoot,delegationScope:executionScope});
  return{runId:id,to:target.name,status:'queued',note:'Use worker_result to collect the result; do not claim completion before it finishes.'};
}
export function createPrivateSchedulerPort(owner){return adapter({db,owner,start:(args,ack)=>{schedulerAcks.set(args,ack);try{return runBot(args);}finally{schedulerAcks.delete(args);}},branch:id=>{assertBranchDispatch(db,id);branchHost?.gate(id);},bindGate:()=>{},stop:stopRun,enqueue:enqueueCommittedRun});}
export function runtimeQueues(){return{workers:workerSlots.snapshot(),local:localSlots.snapshot(),cloud:cloudSlots.snapshot()};}
export async function drainRuntime(){shuttingDown=true;clearInterval(developmentTimer);for(const controller of controllers.values())controller.abort(Object.assign(new Error('Nimbus is shutting down; checkpoint retained'),{shutdown:true}));await Promise.allSettled([...queues.values()]);await toolDevelopment.close();}
