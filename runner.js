import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { db, q, parseBot, writeBotBrief,DATA_DIR } from './db.js';
import { redact, encodeRedacted } from './redact.js';
import { broadcast } from './events.js';
import { config,ROOT } from './runtime/config.js';
import { workerSlots, localSlots, cloudSlots } from './runtime/slots.js';
import { cloudStatus, codexTurn } from './runtime/codex.js';
import { localChat } from './runtime/local.js';
import { chooseRoute, cloudFallbackTier } from './runtime/router.js';
import { buildTools, executeTool,coreTools,maintenance } from './runtime/tools.js';
import {ToolDevelopment} from './runtime/tool-development.js';
import {developmentHost} from './runtime/tool-development-host.js';
import {toolRequestSummary} from './runtime/tool-development-view.js';
import { journalTool, checkpoint, event, UncertainAction } from './runtime/journal.js';
import { requiresApproval } from './runtime/policy.js';
import { validateQuestions } from './runtime/questions.js';
import {policyCommand as specialistPolicyCommand} from './runtime/toolsets/engineering.js';
import {chargeToolAttempt,toolBudgetFeedback} from './runtime/tool-budget.js';
import {boundedInferenceMessages} from './runtime/inference-context.js';

export const botStatus = new Map();
const queues = new Map(), controllers = new Map(), traces = new Map();
let shuttingDown=false;
let developmentTimer,applicationBootHash=null;
const developmentChecks=developmentHost({root:ROOT,dataDir:DATA_DIR});
export const toolDevelopment=new ToolDevelopment({
  db,query:q,root:ROOT,dataDir:DATA_DIR,tools:()=>coreTools,spawnTask:runBot,
  event,notify:(run,message)=>{
    addMessage(run.thread,'system','capability',message,run.id);
    if(['blocked','cancelled','needs_review'].includes(message.status)){
      const status=message.status==='needs_review'||message.phase==='needs_review'?'needs_review':'paused';
      q("UPDATE runs SET status=?,last_error=? WHERE id=? AND status='waiting_tool'").run(status,redact(message.message||'Tool development requires attention'),run.id);
      const current=q('SELECT bot_id,status FROM runs WHERE id=?').get(run.id);if(current&&current.status===status)setStatus(current.bot_id,'waiting','Tool development needs attention');
    }else if(!['ready'].includes(message.status)){
      const current=q('SELECT bot_id,status FROM runs WHERE id=?').get(run.id);if(current?.status==='waiting_tool'&&!['working','queued'].includes(botStatus.get(current.bot_id)?.state))setStatus(current.bot_id,'waiting','Waiting for a new tool');
    }
  },
  maintenance,bootHash:()=>applicationBootHash,...developmentChecks,
  stopTask:id=>stopRun(id),
  enableTool:(botId,name,effects)=>{
    if(!coreTools.some(tool=>tool.function.name===name))throw new Error('The requested tool is not advertised by the running registry');
    const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(botId));if(!bot)throw new Error('Requesting worker was removed');
    const tools=new Set(JSON.parse(bot.tools||'[]'));tools.add(name);
    const rules=[...bot.approval_rules];if(['host_execute','external_write'].includes(effects)&&!rules.includes(name))rules.push(name);
    q('UPDATE bots SET tools=?,approval_rules=? WHERE id=?').run(JSON.stringify([...tools]),JSON.stringify(rules),botId);writeBotBrief({...bot,tools:JSON.stringify([...tools]),approval_rules:rules});broadcast('state_changed',{});
  },
  resumeTask:(runId,request)=>{
    const run=q('SELECT * FROM runs WHERE id=?').get(runId);if(!run||run.status!=='waiting_tool')return{resumed:false,reason:'Task is no longer waiting for a tool'};
    if(q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(runId))return{resumed:false,reason:'Task contains an uncertain action'};
    if(!run.checkpoint)return{resumed:false,reason:'Task checkpoint is unavailable'};
    const state=reconcileCheckpoint(runId,JSON.parse(run.checkpoint));delete state.awaitingToolRequest;
    state.messages.push({role:'user',content:`Nimbus verified tool request ${request.id}. The native tool ${request.tool_name} is now deployed. Continue the original task with the refreshed tools. Retained completed actions are evidence; do not execute them again.`});
    checkpoint(runId,state);resumeRun(runId);return{resumed:true,runId};
  }
});
toolDevelopment.initialize();
export function startToolDevelopment(bootHash){
  applicationBootHash=bootHash;if(developmentTimer)return;
  developmentTimer=setInterval(()=>{if(!shuttingDown)toolDevelopment.pump().catch(error=>console.error('Tool-development progress failed:',redact(error.message)));},1000);developmentTimer.unref();
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
export function markTraceWaiting(runId, name, waiting) {
  const t = traces.get(Number(runId)); if (!t) return;
  const step = [...t.body.steps].reverse().find(s => s.tool === name && ['running','waiting'].includes(s.state));
  if (step) step.state = waiting ? 'waiting' : 'running';
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
export function runBot({botId,thread,prompt,depth=0,source='user',parentRun=null,quiet=false,originMessageId=null,originRequestId=null}) {
  if(shuttingDown)throw new Error('Nimbus is shutting down; submit this task after it restarts.');
  botId = Number(botId);
  if (!Number.isSafeInteger(botId) || !q('SELECT id FROM bots WHERE id=?').get(botId)) throw new Error('Unknown worker');
  if (!/^(bot|room):\d+$/.test(thread) || !String(prompt).trim()) throw new Error('A valid thread and task are required');
  if(parentRun){const parent=q('SELECT origin_message_id,origin_request_id FROM runs WHERE id=?').get(parentRun);originMessageId??=parent?.origin_message_id;originRequestId??=parent?.origin_request_id;}
  const r = q('INSERT INTO runs (bot_id,thread,prompt,status,parent_run,source,quiet,depth,origin_message_id,origin_request_id) VALUES (?,?,?,?,?,?,?,?,?,?)').run(botId,thread,redact(prompt),'queued',parentRun,source,quiet?1:0,depth,originMessageId??null,originRequestId??null);
  const id = Number(r.lastInsertRowid); event(id,'task.queued',{botId,thread,source,parentRun});
  enqueue(id,String(prompt)); return id;
}
function enqueue(runId,prompt) {
  const run = q('SELECT * FROM runs WHERE id=?').get(runId);
  if (!run) return;
  if (!botStatus.get(run.bot_id) || botStatus.get(run.bot_id).state==='idle') setStatus(run.bot_id,'queued','Queued');
  const prev = queues.get(run.bot_id)||Promise.resolve();
  const next = prev.catch(()=>{}).then(()=>execute(runId,prompt)).catch(e=>{
    q("UPDATE runs SET status='error',last_error=?,ended_at=unixepoch() WHERE id=? AND status!='stopped'").run(redact(e.message),runId);
    addMessage(run.thread,'system','error',e.message,runId); setStatus(run.bot_id,'idle','Idle');
  });
  queues.set(run.bot_id,next);
}
export function taskResult(id) {
  const run = q('SELECT id,bot_id,thread,status,actual_model,requested_model,route_reason,fallback_reason,last_error,started_at,ended_at,input_tokens,output_tokens,origin_message_id,origin_request_id,checkpoint FROM runs WHERE id=?').get(Number(id));
  if (!run) throw new Error('Unknown task');
  const reply = q("SELECT body FROM messages WHERE run_id=? AND kind IN ('text','error') ORDER BY id DESC LIMIT 1").get(Number(id));
  const {checkpoint:stored,...visible}=run;let state;try{state=stored&&JSON.parse(stored);}catch{}
  const limit=config().workers.maxSteps,attemptLimit=Math.max(64,limit*4),used=Math.max(0,Math.min(limit,Math.trunc(Number(state?.steps)||0))),attempts=Math.max(0,Math.trunc(Number(state?.toolAttempts??state?.steps)||0));
  const budget=state?{actionLimit:limit,actionsUsed:used,actionRemaining:Math.max(0,limit-used),attemptLimit,attemptsUsed:attempts,attemptRemaining:Math.max(0,attemptLimit-attempts),continuation:Number(state.resumeCount||0)}:null;
  const delegations=q('SELECT r.id,r.bot_id,b.name AS worker_name,r.status,r.started_at,r.ended_at,r.last_error FROM runs r LEFT JOIN bots b ON b.id=r.bot_id WHERE r.parent_run=? ORDER BY r.id').all(run.id);
  return {...visible,reply:reply?.body||null,budget,delegations,toolRequests:toolDevelopment.list({runId:run.id,limit:20}).requests.map(toolRequestSummary)};
}
export function resumeRun(id,options={}) {
  const invalid=message=>Object.assign(new Error(message),{statusCode:400});
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['refreshInstructions','reason','continuation'].includes(key)))throw invalid('Unsupported checkpoint resume options');
  if(options.refreshInstructions!==undefined&&typeof options.refreshInstructions!=='boolean')throw invalid('refreshInstructions must be boolean');
  if(options.reason!==undefined&&(typeof options.reason!=='string'||!options.reason.trim()||options.reason.length>1000))throw invalid('Resume reason must contain 1 to 1000 characters');
  if(options.continuation!==undefined&&(typeof options.continuation!=='string'||!options.continuation.trim()||options.continuation.length>12000))throw invalid('Continuation must contain 1 to 12000 characters');
  if((options.refreshInstructions||options.continuation)&&!options.reason)throw invalid('An explicit reason is required to refresh host instructions or append a continuation');
  const run = q('SELECT * FROM runs WHERE id=?').get(Number(id));
  if (!run || !['paused','interrupted','error','needs_review','waiting_tool'].includes(run.status)) throw new Error('This task cannot be resumed');
  if(run.status==='waiting_tool'){
    const requestId=run.checkpoint&&JSON.parse(run.checkpoint).awaitingToolRequest;
    if(requestId&&toolDevelopment.get(requestId)?.status!=='ready')throw new Error('The missing tool is not ready; inspect its tool-development request');
  }
  if (q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(run.id)) throw new Error('Inspect and resolve the uncertain action before resuming this task. It will not be replayed.');
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
    state.steps=0;state.toolAttempts=0;state.resumeCount=(state.resumeCount||0)+1;checkpoint(run.id,state);
  }
  q("UPDATE runs SET status='queued',ended_at=NULL,last_error=NULL WHERE id=?").run(run.id);
  if(recovery)event(run.id,'checkpoint.recovered',recovery);
  event(run.id,'task.resumed',{budgetReset:true,instructionsRefreshed:!!options.refreshInstructions}); enqueue(run.id,run.prompt); return run.id;
}
export function stopRun(id) {
  id=Number(id);
  const controller=controllers.get(id);
  if (controller) { controller.abort(new Error('Stopped by the user')); return true; }
  const changed=!!q("UPDATE runs SET status='stopped',ended_at=unixepoch() WHERE id=? AND status IN ('queued','paused','interrupted','waiting_tool')").run(id).changes;
  if(changed)toolDevelopment.unwatch?.(id);return changed;
}
export function recoverRuns() {
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
  q("UPDATE approvals SET status='expired',decided_at=unixepoch() WHERE status='pending'").run();
  q("UPDATE task_questions SET status='expired' WHERE status='pending'").run();
  for(const run of q("SELECT id,prompt FROM runs WHERE status='queued' ORDER BY id").all()) enqueue(run.id,run.prompt);
  for(const run of q("SELECT DISTINCT bot_id FROM runs WHERE status='waiting_tool'").all())if(!botStatus.has(run.bot_id))setStatus(run.bot_id,'waiting','Waiting for a new tool');
}
function resolveCloudModel(tier,status,c) {
  const pinned=c.cloud.models[tier];
  if (pinned && pinned!=='auto') return pinned;
  const model=status.models.find(m => new RegExp(`-${tier}(?:-|$)`,'i').test(m.model||m.id));
  if(!model) throw new Error(`The signed-in account advertises no ${tier} model`);
  return model.model||model.id;
}
function usableCloud(status,c) {
  if(!c.cloud.enabled || !status.subscription) return false;
  const limits=status.limits;
  if(limits?.ordinaryUsageAllowed===false || limits?.rateLimits?.spendControlReached || limits?.rateLimits?.rateLimitReachedType) return false;
  const r=limits?.rateLimits; return ![r?.primary,r?.secondary].some(w=>w && w.usedPercent>=100);
}
async function approval(bot,run,name,args,signal) {
  if(!requiresApproval(bot,name,args)) return;
  const r=q('INSERT INTO approvals (run_id,bot_id,thread,tool,input) VALUES (?,?,?,?,?)').run(run.id,bot.id,run.thread,name,encodeRedacted(args));
  const id=Number(r.lastInsertRowid);
  addMessage(run.thread,bot.id,'approval',{approvalId:id,tool:name,input:args,status:'pending'},run.id);
  q("UPDATE runs SET status='waiting_approval' WHERE id=?").run(run.id); markTraceWaiting(run.id,name,true); broadcast('approvals_changed',{});
  try {
    for(;;) {
      signal.throwIfAborted();
      const row=q('SELECT status,note FROM approvals WHERE id=?').get(id);
      if(row?.status==='approved') return;
      if(row?.status!=='pending') throw new Error(`Nimbus: rejected. ${row?.note||'Approval was not granted.'} Do not repeat this action.`);
      await new Promise((resolve,reject)=>{const t=setTimeout(done,config().workers.approvalPollMs);function done(){signal.removeEventListener('abort',cancel);resolve();}function cancel(){clearTimeout(t);signal.removeEventListener('abort',cancel);reject(signal.reason);}signal.addEventListener('abort',cancel,{once:true});});
    }
  } finally {markTraceWaiting(run.id,name,false);q("UPDATE runs SET status='running' WHERE id=? AND status='waiting_approval'").run(run.id);}
}

async function execute(runId,prompt) {
  const run=q('SELECT * FROM runs WHERE id=?').get(runId);
  if(!run||run.status==='stopped'||shuttingDown)return;
  const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(run.bot_id)); if(!bot)return;
  const c=config(); workerSlots.limit=c.workers.maxConcurrent;
  const controller=new AbortController(),signal=controller.signal; controllers.set(runId,controller);
  let release, timer, trace, state,parkedForTool=null,pendingToolFeedback='';
  const save=()=>{checkpoint(runId,state);};
  try {
    release=await workerSlots.acquire(signal); signal.throwIfAborted();
    const cwd=writeBotBrief(bot),isRoom=run.thread.startsWith('room:');
    const existing=run.checkpoint?JSON.parse(run.checkpoint):null;
    const keepConversation=!isRoom&&!run.parent_run&&!['schedule','tool-development','api','hermes','lumos'].includes(run.source);
    // Delegated assignments and incoming integration jobs own their checkpoints
    // and supplied context. Borrowing another conversation can mix old results
    // into a different request or redirect an upstream task's follow-up.
    const history=keepConversation?q('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(bot.id,run.thread):null;
    const memory=fs.readFileSync(path.join(cwd,'MEMORY.md'),'utf8');
    state=existing?reconcileCheckpoint(runId,existing):{messages:history?JSON.parse(history.messages):[],instructions:fs.readFileSync(path.join(cwd,'AGENTS.md'),'utf8')+'\nPrivate working memory:\n'+memory,steps:0};
    if(!existing) {
      const quiet=run.quiet?'\nThis is a quiet check. Reply ALL_CLEAR and a short status if no action is needed.':'';
      state.messages.push({role:'user',content:(isRoom?roomContext(Number(run.thread.slice(5)))+'\nCurrent task:\n':'')+prompt+quiet}); save();
    }
    q("UPDATE runs SET status='routing',started_at=COALESCE(started_at,unixepoch()),ended_at=NULL WHERE id=?").run(runId);
    const body={steps:[],status:'running',effort:bot.effort,started:Date.now(),source:run.source};
    const msg=addMessage(run.thread,bot.id,'trace',body,runId); trace={id:msg.id,body,waited:0,waitStart:null}; traces.set(runId,trace);
    timer=setInterval(()=>{const elapsed=Date.now()-body.started-trace.waited-(trace.waitStart?Date.now()-trace.waitStart:0);if(elapsed>c.workers.timeoutMinutes*60000)controller.abort(new Error('Task time limit reached; checkpoint retained'));},1000);
    setStatus(bot.id,'working','Local model choosing a route…');
    const status=await cloudStatus(); const cloudAllowed=usableCloud(status,c);
    let route;
    try{route=await chooseRoute({task:prompt,role:bot.role,preferredTier:bot.default_model||'',pinned:bot.model||bot.runtime,effort:bot.effort,signal,cloudAvailable:cloudAllowed,c});}
    catch(e){if(signal.aborted)throw e;throw Object.assign(new Error(`Could not choose an available model: ${e.message}. Task checkpoint retained.`),{pause:true});}
    state.route=route; save();
    q('UPDATE runs SET requested_model=?,route_reason=?,effort=? WHERE id=?').run(bot.model||route.tier,route.reason,route.effort,runId);
    event(runId,'route.selected',route); body.route=route; updateMessage(trace.id,body);
    if(route.fallbackReason){
      q('UPDATE runs SET fallback_reason=? WHERE id=?').run(redact(route.fallbackReason),runId);
      body.fallback=route.fallbackReason;updateMessage(trace.id,body);
      event(runId,'model.fallback',{from:route.fallbackFrom,to:route.tier,phase:'routing',reason:route.fallbackReason,completedTools:state.steps});
    }
    const available=await buildTools(bot); const allowed=new Set(available.tools.map(t=>t.function.name));
    for(const e of available.errors)event(runId,'connector.unavailable',e);
    const callTool=async(name,args,id)=>{
      signal.throwIfAborted();
      if(parkedForTool)throw Object.assign(new Error('This task has parked for tool development; no additional actions were started'),{pause:true,waitForTool:true,requestId:parkedForTool});
      const callId=id||randomUUID();
      try{chargeToolAttempt(state,name,{maxSteps:c.workers.maxSteps});}catch(error){if(error.code==='tool_budget_exhausted'){save();event(runId,'tool.budget_exhausted',{callId,name,...error.budget});}throw error;}
      const step={id:callId,tool:name,text:`${name}(${JSON.stringify(args).slice(0,120)})`,state:'running'};body.steps.push(step);updateMessage(trace.id,body);
      state.messages.push({role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}}]});save();
      const result=await journalTool({id:callId,runId,name,args,signal,execute:async()=>{
        if(!allowed.has(name))return{error:`Tool not enabled for this worker: ${name}`,gapType:coreTools.some(tool=>tool.function.name===name)?'permission_denied':'not_advertised',nextStep:bot.template==='orchestrator'?'Use team_status and delegate the investigation or execution to a capable specialist with ask_worker.':'Inspect tool_catalog and capabilities. Existing disabled tools need an assignment/permission change; request_tool is for a genuinely absent implementation.'};
        const approvalArgs=name==='run_checks'?{...args,command:specialistPolicyCommand(name,args,{workspace:cwd})}:args;
        await approval(bot,run,name,approvalArgs,signal);
        q("UPDATE runs SET status='running' WHERE id=?").run(runId);
        return executeTool(bot,name,args,{signal,bindings:available.bindings,availableTools:available.tools,connectorErrors:available.errors,runId,
          requestTool:request=>toolDevelopment.request({run,bot,args:request,availableTools:available.tools,connectorErrors:available.errors,requestKey:`${runId}:${callId}`}),
          toolRequestStatus:requestId=>{
            const connected=toolDevelopment.list({runId,botId:bot.id,limit:50}).requests;
            if(!requestId)return{requests:connected.map(toolRequestSummary)};const item=connected.find(request=>String(request.id)===String(requestId));if(!item)throw new Error('This tool-development request is not connected to your worker/task');return toolRequestSummary(item);
          },
          updatePlan:async plan=>{state.plan=plan;save();body.plan=plan;updateMessage(trace.id,body);event(runId,'plan.updated',plan);return{saved:true,...plan};},
          askUser:async questions=>{
            validateQuestions(questions);
            const questionId=Number(q('INSERT INTO task_questions (run_id,questions) VALUES (?,?)').run(runId,encodeRedacted(questions)).lastInsertRowid);
            const questionMessage=addMessage(run.thread,bot.id,'question',{questionId,questions,status:'pending'},runId);
            q("UPDATE runs SET status='waiting_input' WHERE id=?").run(runId);markTraceWaiting(runId,name,true);setStatus(bot.id,'waiting','Waiting for your answer');
            const drop=release;release=null;drop?.();
            try{
              for(;;){
                signal.throwIfAborted();const question=q('SELECT status,answers FROM task_questions WHERE id=?').get(questionId);
                if(question.status==='answered')return{questionId,answers:JSON.parse(question.answers)};
                if(question.status!=='pending')throw new Error('Question expired; ask again only if it is still needed');
                await new Promise(resolve=>setTimeout(resolve,500));
              }
            }finally{
              q("UPDATE task_questions SET status='expired' WHERE id=? AND status='pending'").run(questionId);
              const question=q('SELECT status,answers FROM task_questions WHERE id=?').get(questionId);
              updateMessage(questionMessage.id,{questionId,questions,status:question.status,answers:question.answers?JSON.parse(question.answers):null});
              markTraceWaiting(runId,name,false);
              if(!signal.aborted){release=await workerSlots.acquire(signal);q("UPDATE runs SET status='running' WHERE id=?").run(runId);setStatus(bot.id,'working','Continuing with your answer');}
            }
          },
          askWorker:async request=>askFromWorker(bot,run,request),workerResult:async id=>{
            const owned=q('SELECT id,parent_run,status FROM runs WHERE id=?').get(Number(id));
            if(!owned||owned.parent_run!==runId)throw new Error('Only collect tasks delegated by this run');
            const drop=release;release=null;drop?.();markTraceWaiting(runId,'worker_result',true);setStatus(bot.id,'waiting','Waiting for delegated work');
            try{
              const until=Date.now()+60000;
              while(Date.now()<until){signal.throwIfAborted();const child=taskResult(id);if(['done','error','stopped','paused','interrupted','needs_review','waiting_tool'].includes(child.status))return child;await new Promise(r=>setTimeout(r,500));}
              return taskResult(id);
            }finally{markTraceWaiting(runId,'worker_result',false);release=await workerSlots.acquire(signal);if(!signal.aborted)setStatus(bot.id,'working','Collecting delegated results');}
          }});
      }});
      state.messages.push({role:'tool',tool_call_id:callId,content:JSON.stringify(result)});step.state=result?.error?'error':'done';pendingToolFeedback=toolBudgetFeedback(state,{maxSteps:c.workers.maxSteps});if(pendingToolFeedback)state.messages.push({role:'user',content:'Nimbus host budget notice: '+pendingToolFeedback});save();updateMessage(trace.id,body);
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
        if(tier!=='local')model=resolveCloudModel(tier,status,c);
        q("UPDATE runs SET status='running',backend=?,actual_model=? WHERE id=?").run(tier==='local'?'local':'codex',model,runId);
        body.model=model;setStatus(bot.id,'working',`Working with ${model}`);updateMessage(trace.id,body);event(runId,'model.started',{tier,model});
        if(tier==='local') {
          for(;;) {
            signal.throwIfAborted();
            const input=prepareLocalContext(state.messages,c.local.contextTokens);
            q("UPDATE runs SET status='waiting_local' WHERE id=?").run(runId);
            const r=await localChat([{role:'system',content:state.instructions},...input],{tools:available.tools,signal,c});
            q("UPDATE runs SET status='running' WHERE id=?").run(runId);
            recordUsage(runId,r.usage,body);body.context=r.usage.prompt_tokens;body.contextWindow=r.contextTokens;
            body.model=r.model;
            q('UPDATE runs SET actual_model=? WHERE id=?').run(r.model,runId);
            const calls=r.message.tool_calls||[];
            if(!calls.length){reply=r.message.content||'';break;}
            for(const call of calls){let args;try{args=JSON.parse(call.function.arguments||'{}');}catch{throw new Error('Local model returned invalid tool arguments');}await callTool(call.function.name,args,call.id||randomUUID());}
          }
        } else {
          q("UPDATE runs SET status='waiting_cloud' WHERE id=?").run(runId);
          const r=await codexTurn({model,effort:route.effort,instructions:state.instructions,messages:state.messages,tools:available.tools,callTool,toolFeedback:()=>{const note=pendingToolFeedback;pendingToolFeedback='';return note;},cwd,signal,
            onThread:id=>{q('UPDATE runs SET session_id=? WHERE id=?').run(id,runId);event(runId,'codex.thread',{id});},
            onEvent:(name,data)=>{if(name==='provider_error')event(runId,'provider.error',data);}});
          reply=r.text;recordUsage(runId,r.usage,body);q('UPDATE runs SET actual_model=? WHERE id=?').run(r.model,runId);
        }
        break;
      } catch(e) {
        save();if(signal.aborted||e instanceof UncertainAction||e.pause)throw e;
        event(runId,'model.failed',{tier,model,error:e.message});
        const next=tier!=='local'?'local':route.fallbackTier!=='local'?route.fallbackTier:cloudFallbackTier(bot.default_model||'',c);
        if(attempted.has(next)||next==='local'&&!c.local.enabled||next!=='local'&&!cloudAllowed)throw Object.assign(e,{pause:true});
        q('UPDATE runs SET fallback_reason=? WHERE id=?').run(redact(e.message),runId);
        body.fallback=e.message;const from=tier;tier=next;event(runId,'model.fallback',{from,to:tier,phase:'execution',reason:e.message,completedTools:state.steps});
      }
    }
    if(reply==null)throw Object.assign(new Error('Model attempts exhausted; checkpoint retained.'),{pause:true});
    if(!String(reply).trim())throw Object.assign(new Error('The worker returned an empty result; checkpoint retained.'),{pause:true});
    state.messages.push({role:'assistant',content:reply});save();
    if(keepConversation)q('INSERT INTO worker_history (bot_id,thread,messages) VALUES (?,?,?) ON CONFLICT(bot_id,thread) DO UPDATE SET messages=excluded.messages,updated_at=unixepoch()').run(bot.id,run.thread,encodeRedacted(state.messages));
    q("UPDATE runs SET status='done',last_error=NULL,ended_at=unixepoch() WHERE id=?").run(runId);
    body.status='done';body.ended=Date.now();updateMessage(trace.id,body);
    const quiet=run.quiet&&/^\s*ALL_CLEAR\b/.test(reply);
    const final=addMessage(run.thread,bot.id,quiet?'quiet':'text',quiet?reply.replace(/^\s*ALL_CLEAR\b[\s:—-]*/,''):reply,runId);
    event(runId,'task.completed',{model:q('SELECT actual_model FROM runs WHERE id=?').get(runId).actual_model});
    if(isRoom&&final.kind==='text'&&run.depth<4&&q('SELECT bots_can_talk FROM rooms WHERE id=?').get(Number(run.thread.slice(5)))?.bots_can_talk) {
      for(const target of findMentions(reply,roomMembers(Number(run.thread.slice(5))),bot.id))runBot({botId:target.id,thread:run.thread,prompt:`${bot.name} said: ${reply}`,depth:run.depth+1,source:bot.name,parentRun:runId});
    }
  } catch(e) {
    const uncertain=q("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(runId);
    const outcome=e instanceof UncertainAction||e.needsReview||uncertain?'needs_review':signal.aborted?(signal.reason?.shutdown?'interrupted':'stopped'):e.waitForTool?'waiting_tool':e.pause?'paused':'error';
    q('UPDATE runs SET status=?,last_error=?,ended_at=unixepoch() WHERE id=?').run(outcome,redact(e.message),runId);
    if(trace){trace.body.status=outcome;trace.body.ended=Date.now();for(const s of trace.body.steps)if(['running','waiting'].includes(s.state))s.state=outcome==='needs_review'?'error':outcome;updateMessage(trace.id,trace.body);}
    if(outcome!=='waiting_tool')addMessage(run.thread,'system',outcome==='stopped'?'note':'error',`${outcome==='needs_review'?'Action needs review. ':outcome==='paused'?'Task paused. ':''}${e.message}`,runId);
    event(runId,'task.'+outcome,{error:outcome==='waiting_tool'?undefined:e.message,requestId:e.requestId,code:e.code,budget:e.budget});
  } finally {
    clearInterval(timer);release?.();controllers.delete(runId);traces.delete(runId);
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
  const copy=boundedInferenceMessages(messages);
  if(JSON.stringify(copy).length>contextTokens*2.5)throw new Error('Local context capacity exceeded. Completed work is retained for a larger-context model.');
  return copy;
}
export function reconcileCheckpoint(runId,state) {
  const repaired=[];
  for(let index=0;index<state.messages.length;index++){
    const message=state.messages[index];repaired.push(message);
    for(const call of message.tool_calls||[]){
      if(state.messages.some(m=>m.role==='tool'&&m.tool_call_id===call.id))continue;
      const tool=q('SELECT state,result FROM tool_calls WHERE id=?').get(`${runId}:${call.id}`);
      if(tool&&['running','uncertain'].includes(tool.state))throw new UncertainAction('A retained action requires review before this checkpoint can continue.');
      const result=tool?.result?JSON.parse(tool.result):{notExecuted:true,note:'Nimbus stopped before this action began. No action was replayed.'};
      repaired.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    }
  }
  state.messages=repaired;return state;
}
function askFromWorker(bot,run,{to,task,context=''}) {
  const matches=q('SELECT id,name FROM bots').all().filter(b=>String(b.id)===String(to).replace(/^#/,'')||b.name.toLowerCase()===String(to).toLowerCase());
  if(matches.length!==1)throw new Error('Choose a worker by its exact name or ID');
  const target=matches[0];const ancestors=new Set([bot.id]);
  for(let id=run.parent_run,n=0;id&&n<8;n++){const parent=q('SELECT bot_id,parent_run FROM runs WHERE id=?').get(id);if(!parent)break;ancestors.add(parent.bot_id);id=parent.parent_run;}
  if(ancestors.has(target.id)||run.depth>=4)throw new Error('This handoff would create a cycle or exceed the handoff depth');
  const thread='bot:'+target.id;addMessage(thread,'system','note',`${bot.name} assigned: ${task}`);
  const id=runBot({botId:target.id,thread,prompt:`Task from ${bot.name}: ${task}\nContext: ${context}\nReturn your result through Nimbus.`,source:bot.name,parentRun:run.id,depth:run.depth+1});
  return{runId:id,to:target.name,status:'queued',note:'Use worker_result to collect the result; do not claim completion before it finishes.'};
}
export function runtimeQueues(){return{workers:workerSlots.snapshot(),local:localSlots.snapshot(),cloud:cloudSlots.snapshot()};}
export async function drainRuntime(){shuttingDown=true;clearInterval(developmentTimer);for(const controller of controllers.values())controller.abort(Object.assign(new Error('Nimbus is shutting down; checkpoint retained'),{shutdown:true}));await Promise.allSettled([...queues.values()]);await toolDevelopment.close();}
