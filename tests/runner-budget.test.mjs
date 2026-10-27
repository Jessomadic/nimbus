import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

const previous={cwd:process.cwd(),data:process.env.NIMBUS_DATA,config:process.env.NIMBUS_CONFIG};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-runner-budget-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{enabled:true,codexBin:process.execPath,maxConcurrent:1,models:{luna:'gpt-fixture-luna'}},local:{enabled:false},workers:{maxConcurrent:1,maxSteps:2,timeoutMinutes:1}}));
// A real Node child implements only the app-server RPC used by the real runner.
// Every model choice and tool request is deterministic fixture data.
const fakeCLI=String.raw`const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const capture=value=>fs.appendFileSync('fixture-provider.jsonl',JSON.stringify(value)+'\n');
let scenario,index=0,pending=null;
const complete=text=>{send({method:'item/completed',params:{item:{type:'agentMessage',text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});};
const invoke=(name,args)=>{index++;pending={name,index};capture({kind:'attempt',name,args,index});send({id:900+index,method:'item/tool/call',params:{tool:name,callId:'fixture-'+index,arguments:args}});};
const plan=()=>({steps:[{step:'Retain bounded verified fixture evidence',status:'in_progress'}]});
readline.createInterface({input:process.stdin}).on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id!=null&&!message.method){
    const items=message.result?.contentItems||[];let result;try{result=JSON.parse(items[0]?.text||'null');}catch{result=null;}
    capture({kind:'response',name:pending?.name,index:pending?.index,result,feedback:items.slice(1).map(item=>item.text)});
    if(!pending||message.error)return;
    if(scenario.mode==='delegate'){
      if(index===1){invoke('ask_worker',{to:String(scenario.targetBotId),task:'Return actual CHILD_VERIFIED_WORDS=3 fixture evidence',context:'Bounded read-only fixture assignment; retain the parent request source.'});return;}
      if(index===2){invoke('worker_result',{runId:result.runId});return;}
      complete(result?.status==='done'&&result.reply==='CHILD_VERIFIED_WORDS=3'?'PARENT_COLLECTED_VERIFIED_CHILD':'PARENT_MISSING_CHILD_EVIDENCE');return;
    }
    if(scenario.mode==='held'){if(index===1){invoke('update_plan',plan());return;}invoke('ask_worker',{to:String(scenario.targetBotId),task:'This held assignment must never be dispatched'});return;}
    if(scenario.mode==='unsupported'){if(index===1){invoke('fixture_not_registered',{});return;}invoke('ask_worker',{to:String(scenario.targetBotId),task:'Unsupported tool attempts must not evade the budget'});return;}
    if(scenario.mode==='poll_loop'){invoke('worker_result',{runId:999999});return;}
    return;
  }
  if(message.id==null)return;
  let result;
  if(message.method==='initialize')result={};
  else if(message.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};
  else if(message.method==='model/list')result={data:[{id:'fixture',model:'gpt-fixture-luna',displayName:'Fixture',supportedReasoningEfforts:[]}]};
  else if(message.method==='account/rateLimits/read')result={};
  else if(message.method==='thread/start'){capture({kind:'thread',instructions:message.params.baseInstructions,tools:message.params.dynamicTools[0].tools.map(tool=>tool.name)});result={thread:{id:'fixture-thread',ephemeral:true}};}
  else if(message.method==='turn/start'){
    scenario=JSON.parse(fs.readFileSync('fixture-scenario.json','utf8'));capture({kind:'turn',input:message.params.input[0].text});send({id:message.id,result:{turn:{id:'fixture-turn'}}});
    if(scenario.mode==='delegate')invoke('team_status',{});
    else if(scenario.mode==='held')invoke('update_plan',plan());
    else if(scenario.mode==='unsupported')invoke('read_file',{path:path.resolve('unavailable-private-file.txt')});
    else if(scenario.mode==='poll_loop')invoke('worker_result',{runId:999999});
    else if(scenario.mode==='child')setTimeout(()=>complete('CHILD_VERIFIED_WORDS=3'),150);
    else complete(scenario.reply||'RESUMED_WITH_RETAINED_EVIDENCE');
    return;
  }else if(message.method==='turn/interrupt'){result={};}
  else return;
  send({id:message.id,result});
});`;
fs.writeFileSync(path.join(root,'app-server'),fakeCLI);process.chdir(root);
const {q,db,botDir,writeBotBrief,parseBot}=await import('../db.js');
const {runBot,taskResult,resumeRun,drainRuntime,runtimeQueues}=await import('../runner.js');

function worker(name,mode,{targetBotId,tools=['update_plan','ask_worker','team_status'],instructions='ORIGINAL_FIXTURE_INSTRUCTIONS',template=''}={}){
  const id=Number(q('INSERT INTO bots(name,model,default_model,effort,template,instructions,tools,approval_rules,allow_rules) VALUES(?,?,?,?,?,?,?,?,?)').run(name,'luna','luna','low',template,instructions,JSON.stringify(tools),'[]','[]').lastInsertRowid),directory=botDir(id);
  fs.writeFileSync(path.join(directory,'app-server'),fakeCLI);fs.writeFileSync(path.join(directory,'fixture-scenario.json'),JSON.stringify({mode,targetBotId}));return id;
}
function scenario(botId,value){fs.writeFileSync(path.join(botDir(botId),'fixture-scenario.json'),JSON.stringify(value));}
function checkpoint(runId){return JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(runId).checkpoint);}
function captures(botId){const file=path.join(botDir(botId),'fixture-provider.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];}
function calls(runId){return q('SELECT id,name,args,state,result FROM tool_calls WHERE run_id=? ORDER BY started_at,id').all(runId);}
function eventRows(runId,type){return q('SELECT body FROM task_events WHERE run_id=? AND type=? ORDER BY id').all(runId,type).map(row=>JSON.parse(row.body));}
async function waitFor(runId,expected){const until=Date.now()+15000;while(Date.now()<until){const run=taskResult(runId);if(run.status===expected)return run;if(['done','error','paused','needs_review','stopped'].includes(run.status))throw new Error('Expected '+expected+', got '+run.status+': '+run.last_error);await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Fixture run '+runId+' did not reach '+expected+' within fifteen seconds; '+JSON.stringify(runtimeQueues()));}
async function pausedFixture(name,mode='held'){
  const targetBotId=worker(name+' child','child'),botId=worker(name,mode,{targetBotId,template:'orchestrator'}),runId=runBot({botId,thread:'bot:'+botId,prompt:'Retain exact bounded fixture progress',source:'api',originRequestId:'source-'+name});await waitFor(runId,'paused');return{botId,targetBotId,runId};
}

test('Two action slots permit team inspection, actual delegation and result collection with one worker/cloud slot',async()=>{
  const childId=worker('Single-slot fixture child','child'),botId=worker('Single-slot Orchestrator','delegate',{targetBotId:childId,template:'orchestrator'}),runId=runBot({botId,thread:'bot:'+botId,prompt:'Delegate and collect actual fixture evidence',source:'lumos',originRequestId:'single-slot-source',originMessageId:321});
  const done=await waitFor(runId,'done');assert.equal(done.reply,'PARENT_COLLECTED_VERIFIED_CHILD');assert.equal(done.budget.actionsUsed,2);assert.equal(done.budget.attemptsUsed,3);assert.equal(done.budget.actionRemaining,0);assert.equal(done.checkpoint,undefined);assert.equal(done.delegations.length,1);
  const child=q('SELECT * FROM runs WHERE parent_run=?').get(runId);assert.equal(child.bot_id,childId);assert.equal(child.status,'done');assert.equal(child.origin_request_id,'single-slot-source');assert.equal(child.origin_message_id,321);assert.equal(done.delegations[0].id,child.id);assert.equal(done.delegations[0].status,'done');
  assert.deepEqual(calls(runId).map(call=>call.name),['team_status','ask_worker','worker_result']);assert.ok(calls(runId).every(call=>call.state==='done'));assert.equal(checkpoint(runId).totalActionSteps,2);assert.equal(checkpoint(runId).totalToolAttempts,3);
  const parent=captures(botId),childCapture=captures(childId);assert.ok(parent.find(row=>row.kind==='thread').tools.includes('worker_result'));assert.ok(childCapture.some(row=>row.kind==='turn'));const response=parent.find(row=>row.kind==='response'&&row.name==='worker_result');assert.equal(response.result.status,'done');assert.equal(response.result.reply,'CHILD_VERIFIED_WORDS=3');assert.ok(parent.filter(row=>row.kind==='response').some(row=>row.feedback.some(text=>/0 of 2 action slots/.test(text))));assert.equal(runtimeQueues().workers.limit,1);assert.equal(runtimeQueues().cloud.limit,1);
});

test('A held ask_worker attempt has an explicit non-execution event, no action journal row and no child',async()=>{
  const f=await pausedFixture('Held handoff'),run=taskResult(f.runId);assert.equal(run.budget.actionsUsed,2);assert.equal(run.budget.attemptsUsed,3);assert.equal(run.delegations.length,0);assert.equal(calls(f.runId).length,2);assert.ok(calls(f.runId).every(call=>call.name==='update_plan'));assert.equal(q('SELECT COUNT(*) n FROM runs WHERE parent_run=?').get(f.runId).n,0);
  const held=eventRows(f.runId,'tool.budget_exhausted');assert.equal(held.length,1);assert.equal(held[0].name,'ask_worker');assert.equal(held[0].notExecuted,true);assert.equal(held[0].actionsUsed,2);assert.equal(held[0].attemptsUsed,3);assert.match(run.last_error,/before ask_worker/);assert.equal(checkpoint(f.runId).messages.some(message=>message.tool_calls?.some(call=>call.function.name==='ask_worker')),false);
});

test('Disabled and unknown tool attempts are journaled, charged and cannot evade the action cap',async()=>{
  const f=await pausedFixture('Unsupported attempts','unsupported'),journal=calls(f.runId);assert.equal(journal.length,2);assert.deepEqual(journal.map(call=>call.name),['read_file','fixture_not_registered']);const results=journal.map(call=>JSON.parse(call.result));assert.deepEqual(results.map(result=>result.gapType),['permission_denied','not_advertised']);assert.ok(results.every(result=>/Tool not enabled/.test(result.error)));assert.match(results[0].nextStep,/delegate/);assert.equal(taskResult(f.runId).budget.actionsUsed,2);assert.equal(taskResult(f.runId).budget.attemptsUsed,3);assert.equal(taskResult(f.runId).delegations.length,0);
  assert.equal(eventRows(f.runId,'tool.budget_exhausted')[0].name,'ask_worker');assert.equal(checkpoint(f.runId).totalActionSteps,2);
});

test('Collection errors consume attempts and stop at the separate attempt cap without consuming actions',async()=>{
  const botId=worker('Bounded collection errors','poll_loop'),runId=runBot({botId,thread:'bot:'+botId,prompt:'Bound repeated invalid collection requests',source:'api'}),paused=await waitFor(runId,'paused'),journal=calls(runId);assert.equal(journal.length,64);assert.ok(journal.every(call=>call.name==='worker_result'&&call.state==='error'));assert.ok(journal.every(call=>/Only collect tasks delegated by this run/.test(JSON.parse(call.result).error)));assert.equal(paused.budget.actionsUsed,0);assert.equal(paused.budget.attemptsUsed,65);assert.equal(paused.budget.attemptRemaining,0);assert.equal(paused.delegations.length,0);assert.equal(eventRows(runId,'tool.budget_exhausted')[0].notExecuted,true);assert.equal(checkpoint(runId).totalActionSteps,0);
});

test('Explicit checkpoint refresh backs up exact evidence, loads the current brief/private memory and never replays old calls',async()=>{
  const f=await pausedFixture('Audited refresh'),journalBefore=calls(f.runId),legacy=checkpoint(f.runId);delete legacy.totalActionSteps;delete legacy.totalToolAttempts;q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(legacy),f.runId);
  const before=q('SELECT checkpoint FROM runs WHERE id=?').get(f.runId).checkpoint;q('UPDATE bots SET instructions=? WHERE id=?').run('CURRENT_AUTHORIZED_COORDINATION_INSTRUCTIONS',f.botId);writeBotBrief(parseBot(q('SELECT * FROM bots WHERE id=?').get(f.botId)));fs.writeFileSync(path.join(botDir(f.botId),'MEMORY.md'),'CURRENT_PRIVATE_MEMORY_ONLY');scenario(f.botId,{mode:'finish'});
  assert.equal(resumeRun(f.runId,{refreshInstructions:true,reason:'Repair the standing coordinator workflow while preserving completed work',continuation:'Delegate only remaining work; preserve prior completed receipts.'}),f.runId);
  const reset=checkpoint(f.runId);assert.equal(reset.steps,0);assert.equal(reset.toolAttempts,0);assert.equal(reset.totalActionSteps,2);assert.equal(reset.totalToolAttempts,3);assert.equal(reset.resumeCount,1);assert.deepEqual(reset.messages.slice(0,legacy.messages.length),legacy.messages);assert.match(reset.messages.at(-1).content,/Delegate only remaining work/);
  const recovered=eventRows(f.runId,'checkpoint.recovered');assert.equal(recovered.length,1);assert.equal(recovered[0].instructionsRefreshed,true);assert.equal(recovered[0].completedToolReceipts,2);assert.equal(recovered[0].oldInstructionsHash,createHash('sha256').update(legacy.instructions).digest('hex'));assert.equal(path.dirname(recovered[0].backup),path.join(process.env.NIMBUS_DATA,'checkpoints',String(f.runId)));assert.match(path.basename(recovered[0].backup),/^before-resume-[a-f0-9-]+\.json$/);assert.equal(fs.readFileSync(recovered[0].backup,'utf8'),before);
  const done=await waitFor(f.runId,'done');assert.equal(done.reply,'RESUMED_WITH_RETAINED_EVIDENCE');assert.equal(done.budget.actionsUsed,0);assert.equal(done.budget.attemptsUsed,0);assert.equal(done.budget.continuation,1);assert.deepEqual(calls(f.runId),journalBefore);const thread=captures(f.botId).filter(row=>row.kind==='thread').at(-1);assert.match(thread.instructions,/CURRENT_AUTHORIZED_COORDINATION_INSTRUCTIONS/);assert.match(thread.instructions,/CURRENT_PRIVATE_MEMORY_ONLY/);assert.equal(checkpoint(f.runId).instructions.includes('ORIGINAL_FIXTURE_INSTRUCTIONS'),false);assert.equal(recovered[0].newInstructionsHash,createHash('sha256').update(checkpoint(f.runId).instructions).digest('hex'));
});

test('Default resume retains checkpoint instructions and receipts rather than silently changing the task brief',async()=>{
  const f=await pausedFixture('Default retained instructions'),before=checkpoint(f.runId),journal=calls(f.runId);q('UPDATE bots SET instructions=? WHERE id=?').run('UNREQUESTED_REFRESH_MUST_NOT_APPEAR',f.botId);scenario(f.botId,{mode:'finish',reply:'DEFAULT_RESUME_DONE'});resumeRun(f.runId);const done=await waitFor(f.runId,'done');assert.equal(done.reply,'DEFAULT_RESUME_DONE');assert.equal(checkpoint(f.runId).instructions,before.instructions);assert.deepEqual(calls(f.runId),journal);assert.equal(eventRows(f.runId,'checkpoint.recovered').length,0);assert.equal(fs.existsSync(path.join(process.env.NIMBUS_DATA,'checkpoints',String(f.runId))),false);const thread=captures(f.botId).filter(row=>row.kind==='thread').at(-1);assert.doesNotMatch(thread.instructions,/UNREQUESTED_REFRESH_MUST_NOT_APPEAR/);
});

test('Stopped/uncertain runs and unaudited refresh requests cannot be resumed',()=>{
  const botId=worker('Non-replay boundary','finish'),state=JSON.stringify({instructions:'Retained authoritative instructions',messages:[{role:'user',content:'Preserve this source'}],steps:0});
  const stopped=Number(q('INSERT INTO runs(bot_id,thread,prompt,status,checkpoint) VALUES(?,?,?,?,?)').run(botId,'bot:'+botId,'Stopped fixture','stopped',state).lastInsertRowid);assert.throws(()=>resumeRun(stopped,{refreshInstructions:true,reason:'Do not revive stopped work'}),/cannot be resumed/);
  const uncertain=Number(q('INSERT INTO runs(bot_id,thread,prompt,status,checkpoint) VALUES(?,?,?,?,?)').run(botId,'bot:'+botId,'Uncertain fixture','needs_review',state).lastInsertRowid);q('INSERT INTO tool_calls(id,run_id,name,args,state) VALUES(?,?,?,?,?)').run(uncertain+':submitted-action',uncertain,'write_file','{}','uncertain');assert.throws(()=>resumeRun(uncertain,{refreshInstructions:true,reason:'Never replay an uncertain action'}),/resolve the uncertain action/);assert.equal(q('SELECT status FROM runs WHERE id=?').get(uncertain).status,'needs_review');
  assert.throws(()=>resumeRun(uncertain,{refreshInstructions:true}),/explicit reason/);assert.throws(()=>resumeRun(uncertain,{refreshInstructions:'true',reason:'Fixture'}),/must be boolean/);assert.throws(()=>resumeRun(uncertain,{unknown:true}),/Unsupported/);assert.equal(captures(botId).length,0);
});

test.after(async()=>{await drainRuntime();db.close();process.chdir(previous.cwd);for(const [key,value]of [['NIMBUS_DATA',previous.data],['NIMBUS_CONFIG',previous.config]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-runner-budget-/);fs.rmSync(root,{recursive:true,force:true});});
