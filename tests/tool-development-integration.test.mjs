import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const previousCwd=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-development-integration-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{codexBin:process.execPath,models:{luna:'gpt-fixture-luna'}},local:{enabled:false}}));
const args={title:'Fixture capability',toolName:'fixture_missing_metrics',capability:'A distinct fixture-only inline metric capability',domain:'engineering',effects:'read',acceptanceCriteria:['Return a verified fixture metric']};
const fakeCLI=`const readline=require('node:readline');const rl=readline.createInterface({input:process.stdin});const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');rl.on('line',line=>{let m;try{m=JSON.parse(line);}catch{return;}if(m.id==null)return;let result;if(m.method==='initialize')result={};else if(m.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};else if(m.method==='model/list')result={data:[{id:'fixture',model:'gpt-fixture-luna',displayName:'Fixture',supportedReasoningEfforts:[]}]};else if(m.method==='account/rateLimits/read')result={};else if(m.method==='thread/start')result={thread:{id:'fixture-thread',ephemeral:true}};else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'fixture-turn'}}});send({id:901,method:'item/tool/call',params:{tool:'request_tool',callId:'fixture-request',arguments:${JSON.stringify(args)}}});return;}else return;send({id:m.id,result});});`;
fs.writeFileSync(path.join(root,'app-server'),fakeCLI);process.chdir(root);
const {q,db,botDir}=await import('../db.js');
const {runBot,taskResult,stopRun,recoverRuns,drainRuntime,toolDevelopment}=await import('../runner.js');
const wait=async fn=>{const until=Date.now()+10000;while(Date.now()<until){const result=fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('Fixture run did not park within ten seconds');};
function worker(name){const id=Number(q('INSERT INTO bots(name,model,tools,approval_rules,allow_rules) VALUES(?,?,?,?,?)').run(name,'luna',JSON.stringify(['request_tool','tool_request_status','tool_catalog']),'[]','[]').lastInsertRowid);fs.writeFileSync(path.join(botDir(id),'app-server'),fakeCLI);return id;}

test('provider request is journaled before parking and notifies its exact API source without a worker-slot deadlock',async()=>{
  const botId=worker('Origin fixture'),runId=runBot({botId,thread:'bot:'+botId,prompt:'Exercise fixture tool development',source:'api',originRequestId:'fixture-original-request'});
  const result=await wait(()=>{const result=taskResult(runId);if(['error','paused','needs_review'].includes(result.status))throw new Error(result.last_error);return result.status==='waiting_tool'&&result;});
  assert.equal(result.origin_request_id,'fixture-original-request');assert.equal(result.toolRequests.length,1);
  const request=toolDevelopment.get(result.toolRequests[0].id);assert.equal(request.origin.api_request_id,'fixture-original-request');assert.equal(request.requester_run_id,runId);
  const call=q("SELECT * FROM tool_calls WHERE run_id=? AND name='request_tool'").get(runId);assert.equal(call.state,'done');assert.equal(JSON.parse(call.result).requestId,request.id);
  const checkpoint=JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(runId).checkpoint);assert.equal(checkpoint.awaitingToolRequest,request.id);assert.ok(checkpoint.messages.some(message=>message.role==='tool'));
  assert.ok(q("SELECT * FROM task_events WHERE run_id=? AND type='tool.development'").all(runId).length>=1);assert.ok(q("SELECT * FROM messages WHERE thread=? AND kind='capability'").all('bot:'+botId).length>=1);
  assert.equal(stopRun(runId),true);assert.equal(taskResult(runId).status,'stopped');assert.equal(toolDevelopment.get(request.id).status,'cancelled');
});

test('restart reconciles a committed request before its tool journal completed without replaying a build',()=>{
  const botId=worker('Recovery fixture'),runId=Number(q('INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,?,?,?)').run(botId,'bot:'+botId,'Fixture recovery','running','api',JSON.stringify({steps:1,instructions:'fixture',messages:[{role:'assistant',content:null,tool_calls:[{id:'recovery-call',type:'function',function:{name:'request_tool',arguments:JSON.stringify(args)}}]}]})).lastInsertRowid);
  const run=q('SELECT * FROM runs WHERE id=?').get(runId),bot=q('SELECT * FROM bots WHERE id=?').get(botId),requestKey=runId+':recovery-call';
  q('INSERT INTO tool_calls(id,run_id,name,args,state) VALUES(?,?,?,?,?)').run(requestKey,runId,'request_tool',JSON.stringify(args),'running');
  const created=toolDevelopment.request({run,bot,args,requestKey,availableTools:[]});recoverRuns();
  const call=q('SELECT * FROM tool_calls WHERE id=?').get(requestKey),retained=q('SELECT * FROM runs WHERE id=?').get(runId);
  assert.equal(call.state,'done');assert.equal(retained.status,'waiting_tool');assert.equal(JSON.parse(retained.checkpoint).awaitingToolRequest,created.requestId);
  assert.equal(toolDevelopment.get(created.requestId).stages.length,0);assert.equal(toolDevelopment.findByRequestKey(requestKey).id,created.requestId);
  stopRun(runId);
});

test('independent development stages neither read nor replace stale worker conversation history',async()=>{
  const botId=worker('Isolated review fixture'),thread='bot:'+botId;
  const stale=JSON.stringify([{role:'user',content:'STALE_REJECTED_QA_HASH_FROM_PRIOR_ATTEMPT'}]);
  q('INSERT INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(botId,thread,stale);
  const requestCall=`send({id:901,method:'item/tool/call',params:{tool:'request_tool',callId:'fixture-request',arguments:${JSON.stringify(args)}}});return;`;
  const completion=`send({method:'item/completed',params:{item:{type:'agentMessage',text:m.params.input[0].text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});return;`;
  const cli=fakeCLI.replace(requestCall,completion);assert.notEqual(cli,fakeCLI);fs.writeFileSync(path.join(botDir(botId),'app-server'),cli);
  const runId=runBot({botId,thread,prompt:'Read the current replacement QA receipt independently.',source:'tool-development'});
  const done=await wait(()=>{const run=taskResult(runId);if(['error','paused','needs_review'].includes(run.status))throw new Error(run.last_error);return run.status==='done'&&run;});
  assert.doesNotMatch(done.reply,/STALE_REJECTED_QA_HASH/);assert.match(done.reply,/current replacement QA receipt/);
  const checkpoint=JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(runId).checkpoint);assert.equal(checkpoint.messages.filter(m=>m.role==='user').length,1);
  assert.equal(q('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(botId,thread).messages,stale);
});

test('Orchestrator handoffs use independent checkpoints without borrowing or replacing a specialist conversation',async()=>{
  const botId=worker('Independent delegated fixture'),thread='bot:'+botId,stale=JSON.stringify([{role:'user',content:'UNRELATED_HUMAN_CONVERSATION_PRIVATE_RESULT'}]);
  q('INSERT INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(botId,thread,stale);
  const parent=Number(q('INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,?,?)').run(botId,thread,'Synthetic parent','done','api').lastInsertRowid);
  const requestCall=`send({id:901,method:'item/tool/call',params:{tool:'request_tool',callId:'fixture-request',arguments:${JSON.stringify(args)}}});return;`,completion=`send({method:'item/completed',params:{item:{type:'agentMessage',text:m.params.input[0].text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});return;`;
  fs.writeFileSync(path.join(botDir(botId),'app-server'),fakeCLI.replace(requestCall,completion));
  const runId=runBot({botId,thread,parentRun:parent,prompt:'Only this independent delegated assignment and supplied context.',source:'Orchestrator'});
  const done=await wait(()=>{const run=taskResult(runId);if(['error','paused','needs_review'].includes(run.status))throw new Error(run.last_error);return run.status==='done'&&run;});
  assert.doesNotMatch(done.reply,/UNRELATED_HUMAN_CONVERSATION/);assert.match(done.reply,/independent delegated assignment/);
  assert.equal(q('SELECT parent_run FROM runs WHERE id=?').get(runId).parent_run,parent);
  assert.equal(q('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(botId,thread).messages,stale);
});

test('new API, Hermes and Lumos jobs cannot inherit a prior coordinator conversation or its completed assignments',async()=>{
  for(const source of ['api','hermes','lumos']){
    const botId=worker('Intake isolation '+source),thread='bot:'+botId,stale=JSON.stringify([{role:'user',content:'PRIOR_OWNING_TASK_RESULTS_MUST_NOT_BECOME_THIS_REQUEST_CHECKPOINT'}]);
    q('INSERT INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(botId,thread,stale);
    const requestCall=`send({id:901,method:'item/tool/call',params:{tool:'request_tool',callId:'fixture-request',arguments:${JSON.stringify(args)}}});return;`,completion=`send({method:'item/completed',params:{item:{type:'agentMessage',text:m.params.input[0].text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});return;`;
    fs.writeFileSync(path.join(botDir(botId),'app-server'),fakeCLI.replace(requestCall,completion));
    const runId=runBot({botId,thread,prompt:'New owning task with its own supplied context.',source,originRequestId:'isolated-'+source});
    const done=await wait(()=>{const run=taskResult(runId);if(['error','paused','needs_review'].includes(run.status))throw new Error(run.last_error);return run.status==='done'&&run;});
    assert.doesNotMatch(done.reply,/PRIOR_OWNING_TASK_RESULTS/);assert.match(done.reply,/New owning task/);assert.equal(done.origin_request_id,'isolated-'+source);
    assert.equal(q('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(botId,thread).messages,stale);
  }
});

test('ordinary human chat retains its conversation while independent intake jobs stay isolated',async()=>{
  const botId=worker('Human continuity fixture'),thread='bot:'+botId,prior=JSON.stringify([{role:'user',content:'HUMAN_CHAT_CONTEXT_TO_RETAIN'}]);
  q('INSERT INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(botId,thread,prior);
  const requestCall=`send({id:901,method:'item/tool/call',params:{tool:'request_tool',callId:'fixture-request',arguments:${JSON.stringify(args)}}});return;`,completion=`send({method:'item/completed',params:{item:{type:'agentMessage',text:m.params.input[0].text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});return;`;
  fs.writeFileSync(path.join(botDir(botId),'app-server'),fakeCLI.replace(requestCall,completion));const runId=runBot({botId,thread,prompt:'Continue the same human chat.'});
  const done=await wait(()=>{const run=taskResult(runId);if(['error','paused','needs_review'].includes(run.status))throw new Error(run.last_error);return run.status==='done'&&run;});assert.match(done.reply,/HUMAN_CHAT_CONTEXT_TO_RETAIN/);assert.match(done.reply,/Continue the same human chat/);
  assert.notEqual(q('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(botId,thread).messages,prior);
});

test.after(async()=>{await drainRuntime();db.close();process.chdir(previousCwd);assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-development-integration-/);fs.rmSync(root,{recursive:true,force:true});});
