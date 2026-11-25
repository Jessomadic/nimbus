import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import http from 'node:http';

const previous={cwd:process.cwd(),data:process.env.NIMBUS_DATA,config:process.env.NIMBUS_CONFIG};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-runner-budget-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{enabled:true,codexBin:process.execPath,maxConcurrent:1,models:{luna:'gpt-fixture-luna'}},local:{enabled:false},workers:{maxConcurrent:1,maxSteps:2,timeoutMinutes:1}}));
// A real Node child implements only the app-server RPC used by the real runner.
// Every model choice and tool request is deterministic fixture data.
// These fixtures exercise the existing unbound delegation/question protocol.
// Bound execution and completion proof have separate fresh-output regression coverage.
const fakeCLI=String.raw`const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const capture=value=>fs.appendFileSync('fixture-provider.jsonl',JSON.stringify(value)+'\n');
process.on('exit',code=>capture({kind:'exit',pid:process.pid,code}));
process.on('uncaughtExceptionMonitor',error=>capture({kind:'uncaught',pid:process.pid,error:String(error.stack||error)}));
let scenario,index=0,pending=null,stageTurn=0;
const complete=text=>{send({method:'item/completed',params:{item:{type:'agentMessage',text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});};
const invoke=(name,args)=>{index++;pending={name,index};capture({kind:'attempt',name,args,index});send({id:900+index,method:'item/tool/call',params:{tool:name,callId:(stageTurn?'stage-'+stageTurn+'-':'')+'fixture-'+index,arguments:args}});};
const plan=()=>({steps:[{step:'Retain bounded verified fixture evidence',status:'in_progress'}]});
readline.createInterface({input:process.stdin}).on('line',line=>{
  let message;try{message=JSON.parse(line);}catch{return;}
  if(message.id!=null&&!message.method){
    const items=message.result?.contentItems||[];let result;try{result=JSON.parse(items[0]?.text||'null');}catch{result=null;}
    capture({kind:'response',name:pending?.name,index:pending?.index,result,feedback:items.slice(1).map(item=>item.text)});
    if(!pending||message.error)return;
    if(scenario.mode==='provider_recovery'){complete('RECOVERY_DONE');return;}
    if(scenario.mode==='stage_finish'){complete(pending.name==='write_file'?'STAGE_FINISHED':'Partial stage; required receipt is still missing.');return;}
    if(scenario.mode==='project_status'){complete(result?.id===scenario.requestId&&result.status==='blocked'?'OWNED_RECOVERY_VERIFIED':'RECOVERY_DENIED');return;}
    if(scenario.mode==='inspection_status'){const actions=scenario.actions||['status'];if(index<actions.length){invoke('self_update',{action:actions[index],snapshotId:scenario.snapshotId});return;}complete('INSPECTION_GUARDS_CHECKED');return;}
    if(scenario.mode==='progress'){if(index>=40){complete('FORTY');return;}const next=()=>invoke('update_plan',{steps:[{step:'Milestone '+index,status:'completed'}]});if(index===1){const gate=setInterval(()=>{if(fs.existsSync('fixture-release')){clearInterval(gate);next();}},10);}else next();return;}
    if(scenario.mode==='permissions'){complete('PERMISSION_WRITE_DONE');return;}
    if(scenario.mode==='delegate'){
      if(index===1){invoke('ask_worker',{executionScope:'conversation',to:String(scenario.targetBotId),task:'Return actual CHILD_VERIFIED_WORDS=3 fixture evidence',context:'Bounded read-only fixture assignment; retain the parent request source.'});return;}
      if(index===2){invoke('worker_result',{runId:result.runId});return;}
      complete(result?.status==='done'&&result.reply==='CHILD_VERIFIED_WORDS=3'?'PARENT_COLLECTED_VERIFIED_CHILD':'PARENT_MISSING_CHILD_EVIDENCE');return;
    }
    if(scenario.mode==='held'){if(index===1){invoke('update_plan',plan());return;}invoke('ask_worker',{executionScope:'conversation',to:String(scenario.targetBotId),task:'This held assignment must never be dispatched'});return;}
    if(scenario.mode==='unsupported'){if(index===1){invoke('fixture_not_registered',{});return;}invoke('ask_worker',{executionScope:'conversation',to:String(scenario.targetBotId),task:'Unsupported tool attempts must not evade the budget'});return;}
    if(scenario.mode==='three_cycle'){invoke('update_plan',{steps:[{step:'Cycle '+(index%5),status:'completed'}]});return;}
    if(scenario.mode==='poll_loop'){invoke('worker_result',{runId:999999});return;}
    if(scenario.mode==='read_missing_loop'){invoke('read_file',{offset:0,limit:4000});return;}
    if(scenario.mode==='read_missing_corrected'){if(index===1){invoke('read_file',{path:'fixture-proof.txt'});return;}complete(result?.content==='VALID_PATH_EVIDENCE'?'CORRECTED_PATH_VERIFIED':'READ_FAILED');return;}
    return;
  }
  if(message.id==null)return;
  let result;
  if(message.method==='initialize')result={};
  else if(message.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};
  else if(message.method==='model/list')result={data:[{id:'fixture',model:'gpt-fixture-luna',displayName:'Fixture',supportedReasoningEfforts:[]}]};
  else if(message.method==='account/rateLimits/read')result={};
  else if(message.method==='thread/start'){capture({kind:'thread',instructions:message.params.baseInstructions,tools:message.params.dynamicTools[0].tools.map(tool=>tool.name),toolSchemas:message.params.dynamicTools[0].tools});result={thread:{id:'fixture-thread',ephemeral:true}};}
  else if(message.method==='turn/start'){
    scenario=JSON.parse(fs.readFileSync('fixture-scenario.json','utf8'));capture({kind:'turn',input:message.params.input[0].text});send({id:message.id,result:{turn:{id:'fixture-turn'}}});
    if(scenario.mode==='provider_activity'){send({method:'item/reasoning/textDelta',params:{itemId:'private-item',delta:'PRIVATE_PROVIDER_CONTENT'}});send({method:'item/reasoning/textDelta',params:{itemId:'private-item',delta:'PRIVATE_PROVIDER_CONTENT'}});complete('ACTIVITY_STORED');return;}
    if(scenario.mode==='provider_recovery'){send({method:'item/reasoning/textDelta',params:{itemId:'fixture-recovery',delta:'Initial fixture progress'}});if(fs.existsSync('fixture-recovery-finish'))invoke('shared_note',{key:'fixture/recovery-note.txt',content:'ONCE'});return;}
    if(scenario.mode==='stage_finish'){
      const counter='fixture-stage-turns.txt',turn=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;fs.writeFileSync(counter,String(turn));
      stageTurn=turn;
      if(turn===1)invoke('update_plan',{steps:[{step:'Verified action already retained',status:'completed'}]});
      else invoke('write_file',{path:scenario.receiptPath,content:JSON.stringify(scenario.receipt)});
      return;
    }
    if(scenario.mode==='stage_stuck'){complete('Partial stage; required receipt is still missing.');return;}
    if(scenario.mode==='project_status'){invoke('project_recovery',{action:'status',requestId:scenario.requestId});return;}
    if(scenario.mode==='inspection_status'){invoke('self_update',{action:'status'});return;}
    if(scenario.mode==='progress'){invoke('update_plan',{steps:[{step:'Start',status:'completed'}]});return;}
    if(scenario.mode==='denial'){invoke('write_file',{path:path.resolve('denied-proof.txt'),content:'MUST_NOT_EXIST'});invoke('shell',{command:'Set-Content denied-proof.txt MUST_NOT_EXIST'});}
    else if(scenario.mode==='permissions')invoke('write_file',{path:path.resolve('permission-proof.txt'),content:'PERMISSION_WRITE_DONE'});
    else if(scenario.mode==='delegate')invoke('team_status',{});
    else if(scenario.mode==='held')invoke('update_plan',plan());
    else if(scenario.mode==='unsupported')invoke('read_file',{path:path.resolve('unavailable-private-file.txt')});
    else if(scenario.mode==='three_cycle')invoke('update_plan',{steps:[{step:'Cycle 0',status:'completed'}]});
    else if(scenario.mode==='poll_loop')invoke('worker_result',{runId:999999});
    else if(['read_missing_loop','read_missing_corrected'].includes(scenario.mode))invoke('read_file',{offset:0,limit:4000});
    else if(scenario.mode==='child')setTimeout(()=>complete('CHILD_VERIFIED_WORDS=3'),150);
    else if(scenario.mode==='late_context')setTimeout(()=>complete(message.params.input[0].text.includes('LATE_CONTEXT_MARKER')?'UPDATED_FINAL_WITH_CONTEXT':'ORIGINAL_FINAL'),300);
    else complete(scenario.reply||'RESUMED_WITH_RETAINED_EVIDENCE');
    return;
  }else if(message.method==='turn/interrupt'){result={};}
  else return;
  send({id:message.id,result});
});`;
fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({type:'commonjs'}));
fs.writeFileSync(path.join(root,'app-server'),fakeCLI);process.chdir(root);
const {q,db,botDir,writeBotBrief,parseBot}=await import('../db.js');
const {runBot,taskResult,resumeRun,stopRun,drainRuntime,runtimeQueues,reconcileRunOwnership,toolDevelopment,projectContinuation,projectLifecycleOwnership,projectSuccessorHandoffs}=await import('../runner.js');
const {saveConfig}=await import('../runtime/config.js');
const {queueRunContext,consumeRunContext,contextTarget}=await import('../runtime/run-context.js');
const {addMessage}=await import('../runner.js');

function worker(name,mode,{targetBotId,tools=['update_plan','ask_worker','team_status'],instructions='ORIGINAL_FIXTURE_INSTRUCTIONS',template=''}={}){
  const id=Number(q('INSERT INTO bots(name,model,default_model,effort,template,instructions,tools,approval_rules,allow_rules) VALUES(?,?,?,?,?,?,?,?,?)').run(name,'luna','luna','low',template,instructions,JSON.stringify(tools),'[]','[]').lastInsertRowid),directory=botDir(id);
  fs.writeFileSync(path.join(directory,'app-server'),fakeCLI);fs.writeFileSync(path.join(directory,'fixture-scenario.json'),JSON.stringify({mode,targetBotId}));return id;
}
function scenario(botId,value){fs.writeFileSync(path.join(botDir(botId),'fixture-scenario.json'),JSON.stringify(value));}
function checkpoint(runId){return JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(runId).checkpoint);}
function captures(botId){const file=path.join(botDir(botId),'fixture-provider.jsonl');return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[];}
function calls(runId){return q('SELECT id,name,args,state,result FROM tool_calls WHERE run_id=? ORDER BY started_at,id').all(runId);}
function eventRows(runId,type){return q('SELECT body FROM task_events WHERE run_id=? AND type=? ORDER BY id').all(runId,type).map(row=>JSON.parse(row.body));}

let retainedFailure=false;
const terminalStatuses=['done','paused','error','needs_review','stopped'];
function retainFailure(id,label){
 retainedFailure=true;
 const run=q('SELECT * FROM runs WHERE id=?').get(id);
 fs.writeFileSync(path.join(root,'failure-'+id+'.json'),JSON.stringify({label,run,calls:calls(id),events:q('SELECT * FROM task_events WHERE run_id=? ORDER BY id').all(id)},null,2));
 return Error(label+'; retained fixture '+root+'; '+JSON.stringify({id,status:run?.status,calls:calls(id).length,checkpoint:run?.checkpoint}));
}
async function waitFor(id,status){const until=performance.now()+15000;while(performance.now()<until){const r=taskResult(id);if(r.status===status)return r;if(terminalStatuses.includes(r.status))throw retainFailure(id,'unexpected terminal; expected '+status);await new Promise(r=>setTimeout(r,25));}throw retainFailure(id,'timeout; expected '+status);}
async function firstCall(id){const until=performance.now()+10000;while(calls(id).length<1){if(terminalStatuses.includes(taskResult(id).status))throw retainFailure(id,'terminal before first action');if(performance.now()>=until)throw retainFailure(id,'first action timeout');await new Promise(r=>setTimeout(r,10));}}
test('real runner: forty actions beyond elapsed cap and bounded control',async()=>{
 const now=Date.now;
 for(const mode of ['progress','bounded']){
 saveConfig({workers:{executionMode:mode,maxSteps:32,timeoutMinutes:1}});
 const b=worker('Elapsed '+mode,'progress',{tools:['update_plan']}),id=runBot({botId:b,thread:'bot:'+b,prompt:'Forty milestones',source:'api'});
 try{await firstCall(id);
 Date.now=()=>now()+120000;
 // Parent acknowledges the elapsed-cap trigger before releasing further actions.
 // Bounded control stays at the first acknowledgement until its real watchdog stops it.
 if(mode==='progress')fs.writeFileSync(path.join(botDir(b),'fixture-release'),'release');
 const r=await waitFor(id,mode==='progress'?'done':'paused');
 if(mode==='progress'){assert.equal(calls(id).length,40);assert.equal(checkpoint(id).totalActionSteps,40);assert.equal(r.reply,'FORTY');assert.equal(r.budget.actionsUsed,40);assert.equal(r.budget.actionRemaining,null);}
 else {assert.match(r.last_error,/time limit/);assert.ok(calls(id).length<32);}
 }catch(error){retainFailure(id,'elapsed '+mode+': '+String(error.stack||error));throw error;}finally{Date.now=now;saveConfig({workers:{executionMode:'bounded',maxSteps:2}});}
 }
});
test('real runner loop stops',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{const b=worker('Loop','poll_loop'),id=runBot({botId:b,thread:'bot:'+b,prompt:'No progress',source:'api'});await waitFor(id,'paused');assert.equal(calls(id).length,16);assert.equal(checkpoint(id).noProgress,true);}
 finally{saveConfig({workers:{executionMode:'bounded'}});}
});
test('real runner retains a malformed-path checkpoint after exactly three requests',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{const b=worker('Missing path loop','read_missing_loop',{tools:['read_file']}),id=runBot({botId:b,thread:'bot:'+b,prompt:'Read explicit evidence',source:'api'});
 await waitFor(id,'paused');const rows=calls(id),state=checkpoint(id);assert.equal(rows.length,3);assert.ok(rows.every(r=>r.state==='done'&&JSON.parse(r.result).code==='missing_path'));assert.equal(state.noProgress,true);assert.equal(state.malformedReadStreak.count,3);assert.match(state.repairReason,/explicit valid file path/);}
 finally{saveConfig({workers:{executionMode:'bounded'}});}
});

test('real runner continues when the model supplies the missing filename',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{const b=worker('Corrected path','read_missing_corrected',{tools:['read_file']});fs.writeFileSync(path.join(botDir(b),'fixture-proof.txt'),'VALID_PATH_EVIDENCE');
 const id=runBot({botId:b,thread:'bot:'+b,prompt:'Correct the filename from available evidence',source:'api'}),result=await waitFor(id,'done');
 assert.equal(result.reply,'CORRECTED_PATH_VERIFIED');assert.equal(calls(id).length,2);assert.notEqual(checkpoint(id).noProgress,true);assert.equal(checkpoint(id).malformedReadStreak,undefined);}
 finally{saveConfig({workers:{executionMode:'bounded'}});}
});

test('real runner unchanged five-action cycle stops',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{const b=worker('Three cycle','three_cycle',{tools:['update_plan']}),id=runBot({botId:b,thread:'bot:'+b,prompt:'Cycle',source:'api'});await waitFor(id,'paused');assert.equal(checkpoint(id).noProgress,true);assert.ok(checkpoint(id).toolAttempts<=20);}
 finally{saveConfig({workers:{executionMode:'bounded'}});}
});
test('real runner owned child completes and parent cancellation remains effective',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{
  const child=worker('Owned fixture child','child'),parent=worker('Owned fixture parent','delegate',{targetBotId:child});
  const id=runBot({botId:parent,thread:'bot:'+parent,prompt:'Collect owned fixture child',source:'api'});
  assert.equal((await waitFor(id,'done')).reply,'PARENT_COLLECTED_VERIFIED_CHILD');
  assert.notEqual(checkpoint(id).noProgress,true);
  const cancelChild=worker('Cancel child','child'),cancelParent=worker('Cancel parent','delegate',{targetBotId:cancelChild});
  const cancelId=runBot({botId:cancelParent,thread:'bot:'+cancelParent,prompt:'Cancel owned wait',source:'api'});
  const until=Date.now()+10000;
  while(!calls(cancelId).some(c=>c.name==='worker_result')){assert.ok(Date.now()<until);await new Promise(r=>setTimeout(r,5));}
  stopRun(cancelId);
  // An interrupted in-flight journal is conservatively retained for review,
  // rather than replayed or silently marked complete on owner cancellation.
  const cancelled=await waitFor(cancelId,'needs_review');assert.match(cancelled.last_error,/Stopped by the user/);
  assert.notEqual(checkpoint(cancelId).noProgress,true);
 }finally{saveConfig({workers:{executionMode:'bounded'}});}
});
test('durable policy reconstruction, dedup, owner stop and uncertain protection',async()=>{
 const {ProjectContinuation}=await import('../runtime/project-continuation.js');
 const b=worker('Durable','finish',{template:'orchestrator'});
 const id=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'interrupted','api',?)").run(b,'bot:'+b,'Durable',JSON.stringify({messages:[],steps:0})).lastInsertRowid);
 const options={db,query:q,resume:resumeRun,owned:new Set(),event:()=>{}};
 let p=new ProjectContinuation(options);const policy={project:'fixture',checkpointRef:'fixture.md',mode:'until_complete'};
 p.arm(id,policy);p.arm(id,policy);p=new ProjectContinuation(options);
 q("INSERT INTO tool_calls(id,run_id,name,args,state) VALUES(?,?,'write_file','{}','uncertain')").run(id+':uncertain',id);
 assert.deepEqual(p.pump(),[]);q("UPDATE tool_calls SET state='done',result='{}' WHERE run_id=?").run(id);
 assert.deepEqual(p.pump(),[id]);assert.deepEqual(p.pump(),[]);await waitFor(id,'done');assert.equal(p.get(id).remaining,-1);assert.deepEqual(p.pump(),[]);
 q("UPDATE runs SET status='interrupted' WHERE id=?").run(id);p.stop(id);p.arm(id,policy);assert.deepEqual(p.pump(),[]);assert.equal(p.get(id).stopped,1);
});
test('recoverRuns parent and safe child: leader reconciles retained evidence without child replay',async()=>{
 const {recoverRuns,projectContinuation:p}=await import('../runner.js');
 for(const childStatus of ['running','paused']){
  const b=worker('Restart leader '+childStatus,'finish',{template:'orchestrator'});
  const cb=worker('Retained child '+childStatus,'child');
  const state={messages:[{role:'user',content:'Retain completed evidence; do not replay.'}],steps:0};
  const id=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'running','api',?)").run(b,'bot:'+b,'Restart reconciliation',JSON.stringify(state)).lastInsertRowid);
  const childState=JSON.stringify({...state,projectLimit:childStatus==='paused'});
  const cid=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint,parent_run) VALUES(?,?,?,?,?,?,?)").run(cb,'bot:'+cb,'Retained child',childStatus,'delegation',childState,id).lastInsertRowid);
  q("INSERT INTO tool_calls(id,run_id,name,args,state,result) VALUES(?,?,'write_file','{}','done',?)").run(cid+':completed',cid,JSON.stringify({saved:true,receipt:'RETAINED_ONLY'}));
  const receipts=calls(cid);
  const delegated={runId:cid,status:'running'};
  q("INSERT INTO tool_calls(id,run_id,name,args,state,result) VALUES(?,?,'ask_worker','{}','done',?)").run(id+':delegated',id,JSON.stringify(delegated));
  state.messages.push({role:'assistant',content:'Existing delegated run '+cid+'; reconcile its retained evidence, do not create another child.'});
  q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(state),id);
  const parentReceipts=calls(id);
  p.arm(id,{project:'restart fixture',checkpointRef:'safe.md',mode:'until_complete'});
  recoverRuns();
  assert.equal(taskResult(id).status,'interrupted');
  assert.equal(taskResult(cid).status,childStatus==='running'?'interrupted':'paused');
  assert.deepEqual(p.pump(),[id]);
  assert.deepEqual(p.pump(),[]);
  await waitFor(id,'done');
  assert.equal(eventRows(id,'project.continued').length,1);
  assert.deepEqual(calls(cid),receipts);
  assert.deepEqual(calls(id),parentReceipts);
  assert.equal(q('SELECT checkpoint FROM runs WHERE id=?').get(cid).checkpoint,childState);
  assert.equal(captures(cb).length,0);
  assert.match(captures(b).find(r=>r.kind==='turn').input,/Reconcile retained/);
  assert.equal(q('SELECT count(*) AS n FROM runs WHERE parent_run=?').get(id).n,1);
 }
});
test('safe-child gate preserves descendant safety and owner stop',async()=>{
 const {ProjectContinuation}=await import('../runtime/project-continuation.js');
 for(const guard of ['owned','running','uncertain','noProgress','paused','badCheckpoint','needs_review','queued','ownerStop','grandchild']){
  const b=worker('Guard '+guard,'finish',{template:'orchestrator'});
  const state=JSON.stringify({messages:[],steps:0});
  const id=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'interrupted','api',?)").run(b,'bot:'+b,'Guard',state).lastInsertRowid);
  const cid=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint,parent_run) VALUES(?,?,?,'interrupted','delegation',?,?)").run(b,'bot:'+b,'Child',state,id).lastInsertRowid);
  const owned=new Set(),resumed=[];
  const p=new ProjectContinuation({db,query:q,resume:id=>resumed.push(id),owned,event:()=>{}});
  p.arm(id,{project:'guard',checkpointRef:'safe.md',mode:'until_complete'});
  if(guard==='owned')owned.add(cid);
  if(['running','uncertain'].includes(guard))q("INSERT INTO tool_calls(id,run_id,name,args,state) VALUES(?,?,'write_file','{}',?)").run(cid+':effect',cid,guard);
  if(guard==='noProgress')q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[],noProgress:true}),cid);
  if(guard==='badCheckpoint')q("UPDATE runs SET checkpoint='invalid' WHERE id=?").run(cid);
  if(['paused','needs_review','queued'].includes(guard))q('UPDATE runs SET status=? WHERE id=?').run(guard,cid);
  if(guard==='ownerStop')p.stop(id);
  if(guard==='grandchild')q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint,parent_run) VALUES(?,?,?,'running','delegation',?,?)").run(b,'bot:'+b,'Grandchild',state,cid);
  assert.deepEqual(p.pump(),[],guard);assert.deepEqual(resumed,[],guard);
  assert.equal(p.get(id).remaining,-1);
  p.stop(id); // isolate the next synthetic policy; production DB is never opened
 }
});
test('actual runner continues incomplete QA in the same checkpoint and preserves completed calls',async()=>{
 const originalMaintenance=toolDevelopment.maintenance,hash='a'.repeat(64);
 saveConfig({workers:{executionMode:'progress'}});toolDevelopment.maintenance={status:()=>({sourceHash:hash,pending:null})};
 try{
  for(const mode of ['stage_finish','stage_stuck']){
   const b=worker('Lifecycle '+mode,mode,{tools:['update_plan','write_file']}),requestId=randomUUID();
   const parent=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'done','user')").run(b,'bot:'+b,'Retained owner').lastInsertRowid);
   const artifact=path.join(botDir(b),'testing.json');
   q("INSERT INTO tool_development_requests(id,tool_name,title,capability,domain,acceptance_json,effects,gap_type,fingerprint,status,phase,message,origin_run_id,requester_run_id,origin_json) VALUES(?,?,?,?,?,'[]','read','missing_tool',?,'testing','testing','Fixture stage',?,?, '{}')").run(requestId,'fixture_'+mode,'Fixture','Fixture','engineering',requestId,parent,parent);
   scenario(b,{mode,receiptPath:artifact,receipt:{requestId,phase:'testing',approved:true,summary:'Synthetic independent checks complete',sourceHash:hash,verification:{args:{},assertions:[{path:'ok',equals:true}]}}});
   const id=runBot({botId:b,thread:'bot:'+b,prompt:'Complete required synthetic QA receipt',source:'tool-development',parentRun:parent});
   q("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES(?,'testing',2,?,?,'running',?)").run(requestId,b,id,artifact);
   await waitFor(id,mode==='stage_finish'?'done':'paused');
   const turns=captures(b).filter(c=>c.kind==='turn');assert.equal(turns.length,2);
   assert.match(turns[1].input,/Lifecycle completion check/);
   assert.equal(eventRows(id,'stage.completion_incomplete').length,1);
   if(mode==='stage_finish'){
    assert.equal(taskResult(id).reply,'STAGE_FINISHED');assert.equal(calls(id).filter(c=>c.name==='update_plan').length,1);
    assert.equal(calls(id).filter(c=>c.name==='write_file').length,1);assert.equal(JSON.parse(fs.readFileSync(artifact,'utf8')).sourceHash,hash);
    assert.ok(checkpoint(id).messages.some(m=>m.role==='assistant'&&m.content?.startsWith('Partial stage')));
   }else {assert.equal(checkpoint(id).noProgress,true);assert.equal(calls(id).length,0);assert.equal(fs.existsSync(artifact),false);}
  }
 }finally{toolDevelopment.maintenance=originalMaintenance;saveConfig({workers:{executionMode:'bounded'}});}
});

test('actual advertised project recovery uses trusted owner identity and its journalled call',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{
  const b=worker('Owner recovery','project_status',{tools:['project_recovery'],template:'orchestrator'}),requestId=randomUUID();
  const origin=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'done','user')").run(b,'bot:'+b,'Historical owner').lastInsertRowid);
  q("INSERT INTO tool_development_requests(id,tool_name,title,capability,domain,acceptance_json,effects,gap_type,fingerprint,status,phase,message,origin_run_id,requester_run_id,origin_json) VALUES(?,'fixture_owned','Fixture','Fixture','engineering','[]','read','missing_tool',?,'blocked','blocked','Retained',?,?, '{}')").run(requestId,requestId,origin,origin);
  scenario(b,{mode:'project_status',requestId});
  const id=runBot({botId:b,thread:'bot:'+b,prompt:'Recover adopted fixture',source:'user'});
  q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages:[{role:'user',content:'Inspect adopted fixture'}],instructions:'Use only the advertised project recovery tool.',steps:0}),id);
  projectContinuation.arm(id,{project:'fixture',checkpointRef:'fixture/checkpoint.md',mode:'until_complete'});
  projectLifecycleOwnership.adopt(requestId,{leaderRunId:id,project:'fixture',reason:'Explicit fixture owner assignment'},{authenticated:true,principal:'fixture-owner'});
  await waitFor(id,'done');assert.equal(taskResult(id).reply,'OWNED_RECOVERY_VERIFIED');
  assert.ok(captures(b).find(c=>c.kind==='thread').tools.includes('project_recovery'));
  const journal=calls(id);assert.equal(journal.length,1);assert.equal(journal[0].name,'project_recovery');assert.equal(journal[0].state,'done');
  assert.equal(JSON.parse(journal[0].result).origin_run_id,origin);
  const other=worker('Unassigned recovery','project_status',{tools:['project_recovery'],template:'orchestrator'});scenario(other,{mode:'project_status',requestId});
  const denied=runBot({botId:other,thread:'bot:'+other,prompt:'Unassigned request must deny',source:'user'});await waitFor(denied,'done');
  assert.equal(taskResult(denied).reply,'RECOVERY_DENIED');assert.equal(calls(denied)[0].state,'error');
  assert.equal(q('SELECT origin_run_id FROM tool_development_requests WHERE id=?').get(requestId).origin_run_id,origin);
 }finally{saveConfig({workers:{executionMode:'bounded'}});}
});

test('real source-review runner exposes only maintenance status and denies fabricated mutation actions at execution',async()=>{
 saveConfig({workers:{executionMode:'progress'}});
 try{
  for(const [kind,actions] of [['source_review',['status','status']],['investigation',['status']],...['snapshot','validate','apply'].map(action=>['source_review',['status',action]])]){
   const b=worker('Readonly '+kind,'inspection_status',{tools:['self_update','read_file','write_file']}),requestId=randomUUID(),updates=path.join(process.env.NIMBUS_DATA,'updates');
   scenario(b,{mode:'inspection_status',actions});
   const before=fs.existsSync(updates)?fs.readdirSync(updates).sort():[];
   const id=runBot({botId:b,thread:'bot:'+b,prompt:'Inspect without mutation, including adversarial maintenance requests',source:'tool-development-investigation'});
   q('INSERT INTO tool_development_recoveries(request_id,kind,phase,run_id,attempt,reason,artifact_path,task_id,status) VALUES(?,?,?,?,1,?,?,?,?)').run(requestId,kind,'reviewing',id,'fixture:'+kind,path.join(botDir(b),'report.json'),id,'queued');
   const denied=actions.some(action=>action!=='status');await waitFor(id,denied?'paused':'done');if(!denied)assert.equal(taskResult(id).reply,'INSPECTION_GUARDS_CHECKED');
   const advertised=captures(b).find(c=>c.kind==='thread'),journal=calls(id).map(c=>({args:JSON.parse(c.args),result:JSON.parse(c.result)}));assert.equal(journal.length,actions.length);
   assert.equal(advertised.tools.includes('self_update'),kind==='source_review');
   if(kind==='source_review'){
    const schema=advertised.toolSchemas.find(t=>t.name==='self_update');assert.deepEqual((schema.inputSchema||schema.parameters).properties.action.enum,['status']);
    assert.match(journal[0].result.sourceHash,/^[a-f0-9]{64}$/);
    if(denied){assert.equal(journal[1].result.denied,true);assert.match(journal[1].result.error,/maintenance mutations are prohibited/);}else assert.equal(journal[1].result.sourceHash,journal[0].result.sourceHash);
   }else for(const action of journal)assert.match(action.result.error,/not enabled/);
   assert.deepEqual(fs.existsSync(updates)?fs.readdirSync(updates).sort():[],before,'no snapshot, validation or apply receipt was created');
  }
 }finally{saveConfig({workers:{executionMode:'bounded'}});}
});

test('actual runner withholds explicit, waiting-tool and automatic leader recovery for committed handoff',async()=>{
 const b=worker('Handoff interlock','finish',{template:'orchestrator'});
 const requestId=randomUUID(),reservationId=randomUUID();
 const state=JSON.stringify({messages:[{role:'user',content:'Retained current work'}],instructions:'Keep authoritative instructions',steps:0,awaitingToolRequest:requestId,projectLimit:true});
 const id=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'waiting_tool','api',?)").run(b,'bot:'+b,'Handoff fixture',state).lastInsertRowid);
 projectContinuation.arm(id,{project:'handoff-fixture',checkpointRef:'shared/handoff.md',mode:'until_complete'});
 const bytes=Buffer.from('Pinned current fixture work'),ref='shared/'+reservationId+'.md';
 fs.mkdirSync(path.join(process.env.NIMBUS_DATA,'shared'),{recursive:true});fs.writeFileSync(path.join(process.env.NIMBUS_DATA,ref),bytes);
 const hash=createHash('sha256').update(bytes).digest('hex'),principal={kind:'named-owner',id:'fixture-owner'};
 const intent={reservationId,project:'handoff-fixture',leaderRunId:id,checkpointRef:ref,checkpointSha256:hash,successorRequestId:'successor-'+reservationId,taskSummary:'Continue pinned fixture',deployment:{snapshotId:randomUUID(),validatedHash:hash,oldPid:process.pid},continuationPolicy:'none'};
 // Only the authorization resolver is substituted: all reservation storage and
 // three production recovery call paths below are the real imported host code.
 const authority=projectSuccessorHandoffs.authority;
 try{
  projectSuccessorHandoffs.authority=()=>({leader:{id,bot_id:b,parent_run:null,template:'orchestrator',status:'waiting_tool'},project:intent.project,ownerArmed:true});
  projectSuccessorHandoffs.authorize(intent,principal);
  projectSuccessorHandoffs.command({action:'reserve',reservationId,expectedCheckpointHash:hash},{runId:id,botId:b,requestKey:id+':reserve'});
 }finally{projectSuccessorHandoffs.authority=authority;}
 const before=q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint;
 assert.throws(()=>resumeRun(id),/handoff owns leader recovery/);
 assert.deepEqual(toolDevelopment.resumeTask(id,{id:requestId,tool_name:'fixture'}),{resumed:false,reason:'Durable successor handoff owns leader recovery'});
 assert.equal(q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint,before);
 q("UPDATE runs SET status='interrupted' WHERE id=?").run(id);
 assert.deepEqual(projectContinuation.pump(),[]);
 assert.equal(taskResult(id).status,'interrupted');assert.equal(captures(b).length,0);
 assert.equal(q("SELECT count(*) n FROM runs WHERE origin_request_id=?").get(intent.successorRequestId).n,0);
 projectSuccessorHandoffs.command({action:'cancel',reservationId},null,{principal});
 assert.equal(projectSuccessorHandoffs.holdsLeader(id),false);
 assert.deepEqual(projectContinuation.pump(),[id]);await waitFor(id,'done');
 assert.equal(projectContinuation.get(id).remaining,-1);
 assert.deepEqual(projectContinuation.pump(),[]);
});


test('actual runner persists bounded provider activity without provider text',async()=>{
  const b=worker('Provider activity','provider_activity',{tools:[]});
  const id=runBot({botId:b,thread:'bot:'+b,prompt:'Run the isolated provider activity fixture',source:'api'});
  await waitFor(id,'done');
  const rows=eventRows(id,'provider.activity');
  assert.ok(rows.some(row=>row.phase==='model_inference'));
  const progress=rows.filter(row=>row.kind==='meaningful_inbound');
  assert.equal(progress.length,1);
  assert.equal(progress[0].activitySequence,1);
  assert.ok(Number.isFinite(progress[0].activityAtMs));
  assert.doesNotMatch(JSON.stringify(rows),/PRIVATE_PROVIDER_CONTENT|private-item/);
});


test('actual runner automatically recovers provider silence once without replaying a completed effect',async t=>{
  const actualNow=Date.now,actualDelay=setTimeout;
  const until=async predicate=>{const limit=actualNow()+15000;while(!predicate()){if(actualNow()>limit)throw Error('Recovery fixture did not settle');await new Promise(resolve=>actualDelay(resolve,10));}};
  saveConfig({workers:{executionMode:'progress'}});
  t.mock.timers.enable({apis:['Date','setTimeout'],now:actualNow()});
  try{
    const b=worker('Provider recovery','provider_recovery',{tools:['shared_note'],template:'orchestrator'});
    const id=runBot({botId:b,thread:'bot:'+b,prompt:'Retain the original effect and recover the silent inference',source:'api'});
    await until(()=>eventRows(id,'provider.activity').some(row=>row.kind==='meaningful_inbound'));
    projectContinuation.arm(id,{project:'provider-fixture',checkpointRef:'provider-fixture.md',mode:'until_complete'});
    const target=path.join(process.env.NIMBUS_DATA,'shared','fixture','recovery-note.txt');
    fs.mkdirSync(path.dirname(target),{recursive:true});
    const {journalTool}=await import('../runtime/journal.js');
    const args={key:'fixture/recovery-note.txt',content:'ONCE'};
    await journalTool({id:'fixture-1',runId:id,name:'shared_note',args,execute:async()=>{fs.writeFileSync(target,'ONCE');return{saved:true,path:target};}});
    fs.writeFileSync(target,'RETAIN_THIS_AFTER_THE_COMPLETED_EFFECT');
    const before={...q('SELECT * FROM tool_calls WHERE id=?').get(id+':fixture-1')};
    t.mock.timers.tick(600001);
    await until(()=>taskResult(id).status==='paused');
    assert.equal(checkpoint(id).providerRecovery.backend,'codex');assert.equal(checkpoint(id).providerRecovery.provider,'openai');
    const model=taskResult(id).actual_model;
    t.mock.timers.reset();
    fs.writeFileSync(path.join(botDir(b),'fixture-recovery-finish'),'ready');
    await until(()=>projectContinuation.pump().includes(id));
    const result=await waitFor(id,'done');
    assert.equal(result.reply,'RECOVERY_DONE');assert.equal(result.actual_model,model);
    assert.equal(fs.readFileSync(target,'utf8'),'RETAIN_THIS_AFTER_THE_COMPLETED_EFFECT');
    assert.deepEqual({...q('SELECT * FROM tool_calls WHERE id=?').get(id+':fixture-1')},before);
    assert.equal(calls(id).length,1);assert.equal(eventRows(id,'project.continued').length,1);
    assert.equal(projectContinuation.get(id).remaining,-1);assert.equal(projectContinuation.get(id).expires,0);
    projectContinuation.stop(id);
  }finally{t.mock.timers.reset();saveConfig({workers:{executionMode:'bounded'}});}
});

test.after(async()=>{await drainRuntime();db.close();process.chdir(previous.cwd);for(const [k,v]of [['NIMBUS_DATA',previous.data],['NIMBUS_CONFIG',previous.config]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!retainedFailure)fs.rmSync(root,{recursive:true,force:true});else console.error('Retained runner fixture: '+root);});
