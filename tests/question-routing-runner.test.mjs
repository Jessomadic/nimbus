import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';

const before={cwd:process.cwd(),data:process.env.NIMBUS_DATA,config:process.env.NIMBUS_CONFIG};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-question-runner-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{enabled:true,codexBin:process.execPath,maxConcurrent:1,models:{luna:'gpt-fixture-luna'}},local:{enabled:false},workers:{maxConcurrent:1,executionMode:'progress',permissionMode:'rules'}}));
// Preserve legacy task-tree question continuation explicitly. New delegated
// execution gets its own pinned checker below; conversation cannot do writes.
const fakeCLI=String.raw`const fs=require('node:fs'),readline=require('node:readline');
const send=x=>process.stdout.write(JSON.stringify(x)+'\n'),record=x=>fs.appendFileSync('provider.jsonl',JSON.stringify(x)+'\n');
let scenario,pending,index=0,childId,mode,question,turn;
const finish=text=>{send({method:'item/completed',params:{item:{type:'agentMessage',text}}});send({method:'turn/completed',params:{turn:{status:'completed'}}});};
const invoke=(name,args)=>{pending=name;record({kind:'call',name,args});send({id:1000+(++index),method:'item/tool/call',params:{tool:name,callId:'turn-'+turn+'-call-'+index,arguments:args}});};
readline.createInterface({input:process.stdin}).on('line',line=>{
 let m;try{m=JSON.parse(line);}catch{return;}
 if(m.id!=null&&!m.method){let value;try{value=JSON.parse(m.result?.contentItems?.[0]?.text||'null');}catch{}record({kind:'result',name:pending,value,context:m.result?.contentItems?.slice(1)});if(m.error)return;
   if(value?.error){finish('TOOL_ERROR: '+value.error);return;}
   if(pending==='ask_worker'){childId=value.runId;invoke('worker_result',{runId:childId});return;}
   if(pending==='worker_result'){finish(mode==='coordinator'?'Premature final with unanswered worker question':'Nested child question surfaced');return;}
   if(pending==='question_inbox'){question=value.find(q=>q.status==='pending'&&q.audience==='coordinator');if(!question){finish('NO_PENDING_QUESTIONS');return;}const escalate=mode==='escalator'||mode==='sequence_attention'&&question.questions[0].question.includes('HUMAN');setTimeout(()=>invoke(escalate?'escalate_worker_question':'answer_worker_question',{questionId:question.id,expectedVersion:question.version,reason:escalate?'Owner preference is genuinely absent':'Original task explicitly authorizes the isolated implementation',...(escalate?{}:{answers:['Use the authorized isolated registry.']})}),100);return;}
   if(pending==='answer_worker_question'){finish('COORDINATOR_ANSWER_RECORDED');return;}
   if(pending==='escalate_worker_question'){finish('Human choice pending');return;}
   if(pending==='request_user_input'){if(value.status!=='answered'||!value.continuation||!value.answerActor){finish('ANSWER_PROVENANCE_MISSING');return;}if(scenario.readOnlyAnswer){finish('READ_ONLY_ANSWER_COLLECTED');return;}invoke('write_file',{path:scenario.outputPath||'continued-proof.txt',content:JSON.stringify({actor:value.answerActor,answers:value.answers,questionId:value.id})});return;}
   if(pending==='write_file'){if(scenario.completionCheck)invoke('run_checks',scenario.completionCheck);else finish('ACTUAL_WORK_CONTINUED');return;}
   if(pending==='run_checks'&&scenario.completionCheck){if(!value.pass||value.exitCode!==0){finish('REQUIRED_CHECK_FAILED');return;}invoke('read_file',{path:scenario.outputPath});return;}
   if(pending==='read_file'&&scenario.completionCheck){finish('ACTUAL_WORK_CONTINUED');return;}
 }
 if(m.id==null)return;let result;
 if(m.method==='initialize')result={};
 else if(m.method==='account/read')result={account:{type:'chatgpt',planType:'fixture'}};
 else if(m.method==='model/list')result={data:[{id:'fixture',model:'gpt-fixture-luna',displayName:'Fixture',supportedReasoningEfforts:[]}]};
 else if(m.method==='account/rateLimits/read')result={};
 else if(m.method==='thread/start'){record({kind:'tools',tools:m.params.dynamicTools[0].tools.map(t=>t.name)});result={thread:{id:'fixture',ephemeral:true}};}
 else if(m.method==='turn/start'){
   scenario=JSON.parse(fs.readFileSync('scenario.json','utf8'));mode=scenario.mode;turn=fs.existsSync('turn.txt')?Number(fs.readFileSync('turn.txt'))+1:1;fs.writeFileSync('turn.txt',String(turn));const input=m.params.input[0].text;if(input.includes('Nimbus host question-attention assignment')&&mode!=='sequence_attention')mode='attention';record({kind:'turn',input,turn});send({id:m.id,result:{turn:{id:'fixture'}}});
   if(input.includes('QUEUED_SECOND')){invoke('write_file',{path:'queued-proof.txt',content:'Queued task preserved'});return;}
   if(mode==='coordinator'&&turn===1||mode==='architect'){if(scenario.targetRun)invoke('worker_result',{runId:scenario.targetRun});else invoke('ask_worker',{executionScope:scenario.completionDescriptor?'execution':'conversation',...(scenario.completionDescriptor?{completionDescriptor:scenario.completionDescriptor}:{}),to:String(scenario.target),task:'Continue authorized isolated implementation and ask about the registry only if needed.'});return;}
   if(mode==='sequence_attention'){invoke('question_inbox',{});return;}
   if(mode==='coordinator'||mode==='attention'||mode==='escalator'){if(input.includes('Nimbus question state changed'))finish('HUMAN_ANSWER_COLLECTED');else invoke('question_inbox',{});return;}
   if(mode==='host_recovery'){invoke('request_user_input',{destination:'host',questions:[{title:'Restore migration control',question:'Confirm the saved host assignment.'}]});return;}
   if(mode==='builder'||mode==='early_builder'){const retained=input.includes('This question is resolved.');if(retained){invoke('write_file',{path:'continued-proof.txt',content:'Retained answer used without replay'});}else{invoke('request_user_input',{questions:[{question:'Which authenticated adapter should the isolated implementation use?',options:['Existing adapter','Isolated registry']}]});if(mode==='early_builder')setTimeout(()=>finish('Still awaiting the adapter selection'),40);}return;}
   if(mode==='busy'){setTimeout(()=>finish('UNRELATED_COORDINATOR_FINISHED'),300);return;}
   finish('Unchanged final without answering');return;
 }else if(m.method==='turn/interrupt')result={};else return;
 send({id:m.id,result});
});`;
fs.writeFileSync(path.join(root,'package.json'),'{}');fs.writeFileSync(path.join(root,'app-server'),fakeCLI);process.chdir(root);
const {db,q,botDir}=await import('../db.js');
const {runBot,taskResult,stopRun,resumeRun,recoverRuns,drainRuntime,questionRouter,runtimeQueues,reconcileQuestionAttention,resolveQuestionCoordinator,projectContinuation,projectLifecycleOwnership}=await import('../runner.js');
const {saveConfig}=await import('../runtime/config.js');
const coordTools=['ask_worker','team_status','task_history','question_inbox','answer_worker_question','escalate_worker_question'];
function worker(name,mode,{target,coordinator=false,tools}={}){
 const id=Number(q('INSERT INTO bots(name,model,default_model,template,tools,approval_rules,allow_rules) VALUES(?,?,?,?,?,?,?)').run(name,'luna','luna',coordinator?'orchestrator':'builder',JSON.stringify(tools|| (coordinator?coordTools:['ask_worker','request_user_input','write_file'])),'[]','[]').lastInsertRowid);
 fs.writeFileSync(path.join(botDir(id),'app-server'),fakeCLI);fs.writeFileSync(path.join(botDir(id),'scenario.json'),JSON.stringify({mode,target}));return id;
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const end=Date.now()+20000;while(Date.now()<end){const result=fn();if(result)return result;await delay(20);}throw new Error(label+'; evidence '+root+'; runs '+JSON.stringify(q('SELECT id,status,last_error FROM runs').all()));}
const done=id=>until(()=>taskResult(id).status==='done'&&taskResult(id),'task '+id+' did not finish');
const calls=id=>q('SELECT * FROM tool_calls WHERE run_id=? ORDER BY started_at,id').all(id);
const captures=id=>fs.readFileSync(path.join(botDir(id),'provider.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
function pendingFixture(ownerId,builderId,questions=[{question:'Choose the implementation'}]){
 const origin=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,parent_run,source,checkpoint) VALUES(?,?,?,'waiting_input',?,'api',?)").run(builderId,'bot:'+builderId,'Existing authorized work',ownerId,JSON.stringify({messages:[],steps:0})).lastInsertRowid),callId=origin+':retained-question';
 q("INSERT INTO tool_calls(id,run_id,name,args,state) VALUES(?,?,'request_user_input',?,'running')").run(callId,origin,JSON.stringify({questions}));
 const view=questionRouter.create({runId:origin,callId,questions});return{origin,callId,view};
}

test('root host recovery stays off the human inbox, releases capacity, and continues the same task after host repair',async()=>{
 const owner=worker('Host recovery Orchestrator','host_recovery',{coordinator:true,tools:['request_user_input','write_file']});
 const leader=runBot({botId:owner,thread:'bot:'+owner,prompt:'Continue after internal host repair.',source:'api'});
 const ticket=await until(()=>questionRouter.pendingForRun(leader)[0],'root host question absent');
 assert.equal(ticket.audience,'host');assert.equal(ticket.correlationId,null);assert.equal(questionRouter.listHuman().some(x=>x.id===ticket.id),false);
 const other=worker('Independent migration Builder','builder');
 const parallel=runBot({botId:other,thread:'bot:'+other,prompt:'QUEUED_SECOND independent authorized work',source:'api'});
 await done(parallel);assert.equal(questionRouter.get(ticket.id).status,'pending');assert.equal(taskResult(leader).status,'waiting_input');
 questionRouter.answerHuman(ticket.id,['Verified assignment restored.'],{authenticated:true,principal:'local-admin',expectedVersion:ticket.version});
 assert.equal((await done(leader)).reply,'ACTUAL_WORK_CONTINUED');
 const journal=calls(leader);assert.equal(journal.filter(x=>x.name==='request_user_input').length,1);assert.equal(journal.filter(x=>x.name==='write_file').length,1);
 assert.equal(JSON.parse(journal.find(x=>x.name==='request_user_input').args).destination,'host');
 assert.equal(JSON.parse(fs.readFileSync(path.join(botDir(owner),'continued-proof.txt'),'utf8')).actor.principal,'local-admin');
});

test('actual cloud runner routes Builder→Architect→Orchestrator, rejects premature final, continues same Builder and preserves its queue with one slot',async()=>{
 const builder=worker('Nested Builder','builder'),architect=worker('Nested Architect','architect',{target:builder}),coordinator=worker('Nested Orchestrator','coordinator',{target:architect,coordinator:true});
 const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Implement authorized isolated registry; collect actual work.',source:'api'});
 const middleRun=runBot({botId:architect,thread:'bot:'+architect,prompt:'Retained legacy nested task',source:'api',parentRun:leader});
 const childRun=runBot({botId:builder,thread:'bot:'+builder,prompt:'Retained legacy implementation',source:'api',parentRun:middleRun});
 fs.writeFileSync(path.join(botDir(coordinator),'scenario.json'),JSON.stringify({mode:'coordinator',targetRun:middleRun}));
 fs.writeFileSync(path.join(botDir(architect),'scenario.json'),JSON.stringify({mode:'architect',targetRun:childRun}));
 const ticket=await until(()=>q("SELECT * FROM task_questions WHERE status='pending' ORDER BY id DESC LIMIT 1").get(),'nested question absent');
 const queued=runBot({botId:builder,thread:'bot:'+builder,prompt:'QUEUED_SECOND independent already-authorized fixture work',source:'api'});
 const leaderResult=await done(leader),builderResult=await done(ticket.run_id);await done(queued);
 assert.equal(leaderResult.reply,'COORDINATOR_ANSWER_RECORDED');assert.equal(builderResult.reply,'ACTUAL_WORK_CONTINUED');
 const question=questionRouter.get(ticket.id),child=q('SELECT * FROM runs WHERE id=?').get(ticket.run_id),middle=q('SELECT * FROM runs WHERE id=?').get(child.parent_run);
 assert.equal(child.delegation_scope,'legacy');assert.equal(middle.delegation_scope,'legacy');assert.equal(child.id,childRun);
 assert.equal(middle.parent_run,leader);assert.equal(question.coordinatorRunId,leader);assert.equal(question.answerActor.kind,'coordinator');assert.equal(question.answerActor.runId,leader);
 assert.equal(calls(child.id).filter(c=>c.name==='request_user_input').length,1);assert.equal(calls(child.id).filter(c=>c.name==='write_file').length,1);
 assert.equal(q('SELECT count(*) AS n FROM runs WHERE parent_run=?').get(leader).n,1);
 assert.ok(captures(coordinator).filter(c=>c.kind==='turn').length>=2,'premature final must reenter the same coordinator');
 assert.ok(captures(coordinator).some(c=>c.kind==='result'&&c.name==='worker_result'&&c.value.questions.some(item=>item.id===ticket.id)),'nested question returned promptly');
 assert.equal(JSON.parse(fs.readFileSync(path.join(botDir(builder),'continued-proof.txt'))).actor.kind,'coordinator');assert.ok(fs.existsSync(path.join(botDir(builder),'queued-proof.txt')));
 const cards=q("SELECT thread,body FROM messages WHERE kind='question' AND json_extract(body,'$.questionId')=?").all(ticket.id).map(row=>({...row,value:JSON.parse(row.body)}));
 assert.equal(cards.find(c=>c.thread==='bot:'+builder).value.interactive,false);assert.equal(cards.find(c=>c.thread==='bot:'+coordinator).value.interactive,true);
 assert.equal(runtimeQueues().workers.limit,1);
});

test('new nested read-only conversations still route their question to the Orchestrator with one slot',async()=>{
 const builder=worker('Conversation Builder','builder'),architect=worker('Conversation Architect','architect',{target:builder}),coordinator=worker('Conversation Orchestrator','coordinator',{target:architect,coordinator:true});
 fs.writeFileSync(path.join(botDir(builder),'scenario.json'),JSON.stringify({mode:'builder',readOnlyAnswer:true}));
 const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Discuss the authorized registry design without implementing anything.',source:'api'});
 const ticket=await until(()=>q("SELECT question.* FROM task_questions question JOIN runs child ON child.id=question.run_id JOIN runs middle ON middle.id=child.parent_run WHERE middle.parent_run=?").get(leader),'read-only nested question absent');
 await done(leader);const result=await done(ticket.run_id),child=q('SELECT * FROM runs WHERE id=?').get(ticket.run_id),middle=q('SELECT * FROM runs WHERE id=?').get(child.parent_run);
 assert.equal(result.reply,'READ_ONLY_ANSWER_COLLECTED');assert.equal(child.delegation_scope,'conversation');assert.equal(middle.delegation_scope,'conversation');
 assert.equal(questionRouter.get(ticket.id).answerActor.runId,leader);assert.deepEqual(calls(child.id).map(row=>row.name),['request_user_input']);
 assert.equal(fs.existsSync(path.join(botDir(builder),'continued-proof.txt')),false);assert.equal(child.completion_required,0);assert.equal(runtimeQueues().workers.limit,1);
});

test('new bound execution answers its coordinator question and finishes only after its actual check and readback',async()=>{
 const builder=worker('Bound question Builder','builder',{tools:['request_user_input','write_file','run_checks','read_file']}),coordinator=worker('Bound question Orchestrator','coordinator',{target:builder,coordinator:true});
 const base=path.join(botDir(builder),'artifacts','bound-question'),outputRoot=path.join(base,'generated'),output=path.join(outputRoot,'report.json');fs.mkdirSync(base,{recursive:true});
 const input=path.join(base,'input.txt'),checker=path.join(base,'check.test.cjs');fs.writeFileSync(input,'Use the authorized isolated registry.');
 fs.writeFileSync(checker,"const fs=require('node:fs'),assert=require('node:assert/strict');require('node:test')('retained coordinator answer',()=>{const report=JSON.parse(fs.readFileSync(__dirname+'/generated/report.json'));assert.equal(report.actor.kind,'coordinator');assert.ok(report.actor.runId>0);assert.deepEqual(report.answers,[fs.readFileSync(__dirname+'/input.txt','utf8')]);assert.ok(report.questionId>0);});\n");
 const pin=file=>({path:file,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}),args={runner:'node_test',path:base,files:['check.test.cjs']};
 const descriptor={version:2,outputRoot,inputPins:[pin(input)],sourcePins:[pin(checker)],outputs:[output],steps:[{id:'answer-proof',check:{args,assertions:[{path:'pass',equals:true}]}}]};
 fs.writeFileSync(path.join(botDir(builder),'scenario.json'),JSON.stringify({mode:'builder',outputPath:output,completionCheck:args}));
 fs.writeFileSync(path.join(botDir(coordinator),'scenario.json'),JSON.stringify({mode:'coordinator',target:builder,completionDescriptor:descriptor}));
 const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Implement the authorized isolated registry and answer routine technical questions.',source:'api'});
 const ticket=await until(()=>q("SELECT question.* FROM task_questions question JOIN runs child ON child.id=question.run_id WHERE child.parent_run=?").get(leader),'bound child question absent');
 await done(leader);const result=await done(ticket.run_id),child=q('SELECT * FROM runs WHERE id=?').get(ticket.run_id);
 assert.equal(result.reply,'ACTUAL_WORK_CONTINUED');assert.equal(child.delegation_scope,'execution');assert.equal(child.completion_required,1);assert.equal(questionRouter.get(ticket.id).answerActor.runId,leader);
 const journal=q('SELECT * FROM tool_calls WHERE run_id=? ORDER BY rowid').all(child.id);assert.deepEqual(journal.map(row=>row.name),['request_user_input','write_file','run_checks','read_file']);
 const check=JSON.parse(journal[2].result);assert.equal(check.pass,true);assert.equal(check.exitCode,0);assert.equal(check.freshOutputObservation.runId,child.id);
 const capture=JSON.parse(q('SELECT evidence FROM completion_output_captures WHERE run=?').get(child.id).evidence);assert.deepEqual(capture.receipts,[journal[2].id]);assert.equal(capture.files[0][1],createHash('sha256').update(fs.readFileSync(output)).digest('hex'));
});

test('actual orphan worker gets one new question-only Orchestrator run, never revives DONE or grants lifecycle tools',async()=>{
 const coordinator=worker('Orphan Orchestrator','attention',{coordinator:true}),builder=worker('Orphan Builder','builder');
 const old=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'done','api')").run(coordinator,'bot:'+coordinator,'Authorized isolated registry').lastInsertRowid);
 const origin=runBot({botId:builder,thread:'bot:'+builder,prompt:'Continue the original authorized implementation',source:'api',parentRun:old});await done(origin);
 const ticket=questionRouter.get(q('SELECT id FROM task_questions WHERE run_id=?').get(origin).id),attention=ticket.coordinatorRunId;await done(attention);
 assert.notEqual(attention,old);assert.equal(q('SELECT status FROM runs WHERE id=?').get(old).status,'done');assert.equal(q('SELECT count(*) AS n FROM task_question_attention WHERE question_id=?').get(ticket.id).n,1);
 const task=q('SELECT * FROM runs WHERE id=?').get(attention);assert.equal(task.parent_run,null);assert.equal(task.source,'api');assert.equal(task.origin_request_id,'question-attention:'+ticket.id);
 assert.equal(q('SELECT count(*) AS n FROM project_continuations WHERE run_id=?').get(attention).n,0);
 const tools=captures(coordinator).find(c=>c.kind==='tools').tools;assert.ok(tools.includes('answer_worker_question'));for(const denied of ['ask_worker','request_tool','project_recovery','self_update','write_file'])assert.ok(!tools.includes(denied));
 assert.equal(calls(origin).filter(c=>c.name==='request_user_input').length,1);assert.equal(ticket.answerActor.runId,attention);
});

test('cloud completion waits without polling inference for escalated human answer and preserves actor/context cards',async()=>{
 const coordinator=worker('Human escalation','escalator',{coordinator:true}),builder=worker('Retained human child','builder');
 const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Resolve the actual owner preference',source:'api'}),pending=pendingFixture(leader,builder);
 await until(()=>questionRouter.get(pending.view.id).audience==='human'&&taskResult(leader).status==='waiting_input','human escalation did not park coordinator');
 const turns=captures(coordinator).filter(c=>c.kind==='turn').length;await delay(250);assert.equal(captures(coordinator).filter(c=>c.kind==='turn').length,turns);assert.equal(runtimeQueues().workers.active,0);
 const current=questionRouter.get(pending.view.id);questionRouter.answerHuman(current.id,['Owner preference supplied'],{authenticated:true,principal:'fixture-owner',expectedVersion:current.version});
 await done(leader);assert.equal(questionRouter.get(current.id).answerActor.kind,'human');assert.equal(taskResult(leader).reply,'HUMAN_ANSWER_COLLECTED');
 const card=JSON.parse(q("SELECT body FROM messages WHERE kind='question' AND thread=? AND json_extract(body,'$.questionId')=?").get('bot:'+coordinator,current.id).body);assert.equal(card.answerActor.principal,'fixture-owner');assert.equal(card.interactive,true);
 stopRun(pending.origin);
});

test('unchanged cloud final without handling owned questions becomes a no-progress hold, never DONE',async()=>{
 const coordinator=worker('No-progress coordinator','stuck',{coordinator:true}),builder=worker('Held child','builder');
 const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Handle the owned question',source:'api'}),pending=pendingFixture(leader,builder);
 await until(()=>taskResult(leader).status==='paused','no-progress completion did not hold');assert.equal(JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(leader).checkpoint).noProgress,true);
 assert.equal(captures(coordinator).filter(c=>c.kind==='turn').length,2);assert.equal(questionRouter.get(pending.view.id).status,'pending');stopRun(pending.origin);stopRun(leader);
});

test('restart delivers the exact retained answer once, continues real work, and does not clear unrelated uncertainty',async()=>{
 const coordinator=worker('Restart coordinator','attention',{coordinator:true}),builder=worker('Restart builder','builder');
 const owner=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'paused','api')").run(coordinator,'bot:'+coordinator,'Retained authorized work').lastInsertRowid),pending=pendingFixture(owner,builder);
 const providerId=pending.callId.slice(String(pending.origin).length+1),messages=[{role:'user',content:'Use the supplied answer to implement the original task.'},{role:'assistant',content:null,tool_calls:[{id:providerId,type:'function',function:{name:'request_user_input',arguments:JSON.stringify({questions:[{question:'Choose the implementation'}]})}}]}];
 q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages,steps:1}),pending.origin);
 questionRouter.answerHuman(pending.view.id,['Use the retained isolated registry'],{authenticated:true,principal:'fixture-owner',expectedVersion:pending.view.version});
 q("INSERT INTO tool_calls(id,run_id,name,args,state) VALUES(?,?,'shell','{}','uncertain')").run(pending.origin+':unrelated',pending.origin);
 recoverRuns();assert.equal(q('SELECT state FROM tool_calls WHERE id=?').get(pending.callId).state,'done');assert.throws(()=>resumeRun(pending.origin),/uncertain action/);
 q("UPDATE tool_calls SET state='done',result=? WHERE id=?").run(JSON.stringify({reviewed:true,noReplay:true}),pending.origin+':unrelated');resumeRun(pending.origin);await done(pending.origin);
 assert.equal(calls(pending.origin).filter(c=>c.name==='request_user_input').length,1);assert.equal(q('SELECT count(*) AS n FROM task_questions WHERE run_id=?').get(pending.origin).n,1);assert.equal(questionRouter.get(pending.view.id).answerActor.kind,'human');assert.ok(fs.existsSync(path.join(botDir(builder),'continued-proof.txt')));
 stopRun(owner);
});

test('explicit restart continuation reattaches a pending local wait without replay, and user stop expires another wait without losing its queue',async()=>{
 const coordinator=worker('Pending restart coordinator','attention',{coordinator:true}),builder=worker('Pending restart builder','builder');
 const owner=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'paused','api')").run(coordinator,'bot:'+coordinator,'Retained authorized work').lastInsertRowid),pending=pendingFixture(owner,builder);
 const id=pending.callId.split(':')[1],messages=[{role:'user',content:'Resume original authorized work'},{role:'assistant',content:null,tool_calls:[{id,type:'function',function:{name:'request_user_input',arguments:JSON.stringify({questions:[{question:'Choose the implementation'}]})}}]}];
 q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({messages,steps:1}),pending.origin);recoverRuns();resumeRun(pending.origin);
 await until(()=>taskResult(pending.origin).status==='waiting_input','pending wait did not reattach');const current=questionRouter.get(pending.view.id);questionRouter.answerHuman(current.id,['Retained reply'],{authenticated:true,principal:'fixture-owner',expectedVersion:current.version});await done(pending.origin);
 assert.equal(calls(pending.origin).filter(c=>c.name==='request_user_input').length,1);assert.equal(q('SELECT count(*) AS n FROM task_questions WHERE run_id=?').get(pending.origin).n,1);
 const stoppedBuilder=worker('Cancelled wait builder','builder'),stopped=runBot({botId:stoppedBuilder,thread:'bot:'+stoppedBuilder,prompt:'Cancel this wait',source:'api',parentRun:owner});
 await until(()=>taskResult(stopped).status==='waiting_input','cancel wait missing');const queued=runBot({botId:stoppedBuilder,thread:'bot:'+stoppedBuilder,prompt:'QUEUED_SECOND preserved after stop',source:'api'});stopRun(stopped);
 await until(()=>taskResult(stopped).status==='stopped','cancel wait did not stop safely');await done(queued);assert.equal(questionRouter.pendingForRun(stopped).length,0);assert.equal(calls(stopped).filter(c=>c.state==='uncertain').length,0);stopRun(owner);
});

test('actual local runner reenters its completion boundary, answers owned question, then accepts a legitimate final without extra action',async()=>{
 const {resources}=await import('../runtime/resources.js'),telemetry=await resources({fresh:true});telemetry.ram.percent=0;telemetry.gpu=[{percent:0}];
 const requests=[];let ticket;
 const server=http.createServer(async(req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/api/v1/models'){res.end(JSON.stringify({models:[{key:'question-local',tool_capable:true,max_context_length:131072,loaded_instances:[{id:'fixture'}]}]}));return;}
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);requests.push(input);
   const count=requests.length,message=count===1?{role:'assistant',content:'Premature local final'}:count===2?{role:'assistant',content:null,tool_calls:[{id:'local-inbox',type:'function',function:{name:'question_inbox',arguments:'{}'}}]}:count===3?{role:'assistant',content:null,tool_calls:[{id:'local-answer',type:'function',function:{name:'answer_worker_question',arguments:JSON.stringify({questionId:ticket.id,expectedVersion:ticket.version,answers:['Use the authorized local fixture'],reason:'Existing task decision'})}}]}:{role:'assistant',content:'LOCAL_ANSWER_HANDLED'};
   res.end(JSON.stringify({model:'question-local',choices:[{message,finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3}}));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 saveConfig({local:{enabled:true,baseUrl:'http://127.0.0.1:'+server.address().port+'/v1',model:'question-local',approvedModels:['question-local']}});
 let pending;
 try{const coordinator=worker('Local coordinator','unused',{coordinator:true}),builder=worker('Local held child','builder');q("UPDATE bots SET model='local' WHERE id=?").run(coordinator);
   const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Resolve owned question from evidence',source:'api'});pending=pendingFixture(leader,builder);ticket=pending.view;
   await done(leader);assert.equal(taskResult(leader).reply,'LOCAL_ANSWER_HANDLED');assert.equal(requests.length,4);assert.ok(requests[1].messages.some(m=>String(m.content).includes('Nimbus completion gate')));assert.equal(questionRouter.get(ticket.id).answerActor.kind,'coordinator');assert.equal(calls(leader).length,2);
 }finally{if(pending)stopRun(pending.origin);saveConfig({local:{enabled:false}});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('a protected earlier question cannot starve busy→idle orphan attention; only one scoped task is created',async()=>{
 const protectedBot=worker('Protected coordinator','attention',{coordinator:true}),builder=worker('Protected origin','builder');
 const protectedOwner=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'paused','api')").run(protectedBot,'bot:'+protectedBot,'Protected task').lastInsertRowid),protectedQuestion=pendingFixture(protectedOwner,builder);
 q("UPDATE runs SET status='stopped' WHERE id=?").run(protectedOwner);
 const coordinator=worker('Busy coordinator','busy',{coordinator:true}),old=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'done','api')").run(coordinator,'bot:'+coordinator,'Historical authorized isolated work').lastInsertRowid);
 const busy=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Finish unrelated safe coordination',source:'api'}),pending=pendingFixture(old,builder);
 reconcileQuestionAttention();assert.equal(questionRouter.get(pending.view.id).status,'pending');assert.equal(q('SELECT count(*) AS n FROM task_question_attention WHERE question_id=?').get(pending.view.id).n,0);
 await done(busy);await until(()=>questionRouter.get(pending.view.id).status==='answered','busy orphan was stranded');const ticket=questionRouter.get(pending.view.id);await done(ticket.coordinatorRunId);
 assert.notEqual(ticket.coordinatorRunId,busy);assert.notEqual(ticket.coordinatorRunId,old);assert.equal(q('SELECT count(*) AS n FROM task_question_attention WHERE question_id=?').get(ticket.id).n,1);assert.equal(questionRouter.get(protectedQuestion.view.id).status,'pending');
 const eventsBefore=q("SELECT count(*) AS n FROM task_events WHERE type='question.attention_held' AND run_id=?").get(protectedQuestion.origin).n;reconcileQuestionAttention();reconcileQuestionAttention();assert.equal(q("SELECT count(*) AS n FROM task_events WHERE type='question.attention_held' AND run_id=?").get(protectedQuestion.origin).n,eventsBefore);
 questionRouter.cancelRun(protectedQuestion.origin);questionRouter.cancelRun(pending.origin);
});

test('actual coordinator answer still honors host approval rejection',async()=>{
 const coordinator=worker('Approval constrained coordinator','attention',{coordinator:true}),builder=worker('Approval child','builder');q('UPDATE bots SET approval_rules=? WHERE id=?').run(JSON.stringify(['answer_worker_question']),coordinator);
 const leader=runBot({botId:coordinator,thread:'bot:'+coordinator,prompt:'Handle owned question under approval rules',source:'api'}),pending=pendingFixture(leader,builder);
 const approval=await until(()=>q("SELECT * FROM approvals WHERE run_id=? AND status='pending'").get(leader),'answer approval not requested');q("UPDATE approvals SET status='rejected',note='Fixture owner rejected this answer' WHERE id=?").run(approval.id);
 await until(()=>taskResult(leader).status==='paused','rejected answer did not pause');assert.equal(questionRouter.get(pending.view.id).status,'pending');assert.equal(questionRouter.get(pending.view.id).answers,null);assert.equal(calls(leader).find(c=>c.name==='answer_worker_question').state,'error');questionRouter.cancelRun(pending.origin);stopRun(leader);
});

test('provider final before question reply cannot publish stale DONE; same Builder consumes retained answer in fresh inference without replay',async()=>{
 const coordinator=worker('Early-final coordinator','attention',{coordinator:true}),builder=worker('Early-final Builder','early_builder');
 const old=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'done','api')").run(coordinator,'bot:'+coordinator,'Authorized isolated work').lastInsertRowid),origin=runBot({botId:builder,thread:'bot:'+builder,prompt:'Implement after the recorded answer',source:'api',parentRun:old});
 await done(origin);assert.equal(taskResult(origin).reply,'ACTUAL_WORK_CONTINUED');assert.equal(calls(origin).filter(c=>c.name==='request_user_input').length,1);assert.equal(calls(origin).filter(c=>c.name==='write_file').length,1);assert.equal(captures(builder).filter(c=>c.kind==='turn').length,2);assert.equal(q("SELECT count(*) AS n FROM task_events WHERE run_id=? AND type='model.results_unconsumed'").get(origin).n,1);
 assert.equal(q("SELECT count(*) AS n FROM messages WHERE run_id=? AND kind='text' AND body='Still awaiting the adapter selection'").get(origin).n,0);
});

test('canonical stage question uses current adopted owner; a safely parked lifecycle leader gets question-only attention without changing lifecycle ownership',async()=>{
 const coordinator=worker('Adopted parked coordinator','attention',{coordinator:true}),builder=worker('Adopted stage child','builder'),requestId='question-fixture-adopted';
 const historical=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'done','api',?)").run(coordinator,'bot:'+coordinator,'Original authorized project',JSON.stringify({messages:[],steps:0})).lastInsertRowid);
 const ownerState={messages:[{role:'user',content:'Continue the authorized isolated project'}],steps:0,awaitingToolRequest:requestId};
 const owner=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,'waiting_tool','api',?)").run(coordinator,'bot:'+coordinator,'Current adopted project leader',JSON.stringify(ownerState)).lastInsertRowid);
 q("INSERT INTO tool_development_requests(id,tool_name,title,capability,domain,acceptance_json,effects,gap_type,fingerprint,status,phase,message,origin_run_id,requester_run_id,origin_json) VALUES(?,?,?,?,?,?,?,?,?,'blocked','building','fixture',?,?,?)").run(requestId,'fixture_question_capability','Fixture','Fixture','engineering','["fixture"]','local_write','missing_tool','fixture-fingerprint',historical,historical,'{}');
 projectContinuation.arm(owner,{project:'question-fixture',checkpointRef:'fixture/checkpoint.md',mode:'until_complete'});
 projectLifecycleOwnership.adopt(requestId,{leaderRunId:owner,project:'question-fixture',reason:'Fixture host adopted current leader'},{authenticated:true,principal:'fixture-owner'});
 const stage=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,parent_run,checkpoint) VALUES(?,?,?,'paused','tool-development',?,?)").run(builder,'bot:'+builder,'Retained canonical stage',historical,JSON.stringify({messages:[],steps:0})).lastInsertRowid);
 q("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES(?,'building',1,?,?,'running',?)").run(requestId,builder,stage,path.join(root,'fixture-stage-report.json'));
 q("UPDATE tool_development_requests SET status='building' WHERE id=?").run(requestId);
 const origin=runBot({botId:builder,thread:'bot:'+builder,prompt:'Complete the current stage delegated implementation after answering',source:'api',parentRun:stage});
 const binding=resolveQuestionCoordinator(origin);assert.equal(binding.runId,owner);assert.equal(binding.requestId,requestId);assert.equal(binding.attentionOnly,true);
 await done(origin);const ticket=questionRouter.get(q('SELECT id FROM task_questions WHERE run_id=?').get(origin).id);await done(ticket.coordinatorRunId);
 assert.notEqual(ticket.coordinatorRunId,owner);assert.notEqual(ticket.coordinatorRunId,historical);assert.equal(taskResult(owner).status,'waiting_tool');assert.equal(JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(owner).checkpoint).awaitingToolRequest,requestId);assert.equal(projectLifecycleOwnership.get(requestId).leader_run_id,owner);assert.equal(q('SELECT count(*) AS n FROM project_continuations WHERE run_id=?').get(ticket.coordinatorRunId).n,0);
 assert.equal(calls(origin).filter(c=>c.name==='request_user_input').length,1);assert.equal(calls(origin).filter(c=>c.name==='write_file').length,1);assert.equal(questionRouter.attentionForRun(ticket.coordinatorRunId).original_coordinator_run_id,owner);
 projectLifecycleOwnership.revoke(requestId,{reason:'Fixture stop preserves explicit revocation'},{authenticated:true,principal:'fixture-owner'});assert.equal(resolveQuestionCoordinator(origin).authorized,false);stopRun(owner);
});

test('same-scope orphan questions join existing attention while it awaits a human, waking that same coordinator without a queue cycle',async()=>{
 const coordinator=worker('Multi-question coordinator','sequence_attention',{coordinator:true}),builder=worker('Multi-question origin','builder'),old=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'done','api')").run(coordinator,'bot:'+coordinator,'Original project scope').lastInsertRowid);
 const first=pendingFixture(old,builder,[{question:'HUMAN owner preference is absent'}]);await until(()=>questionRouter.get(first.view.id).audience==='human','first attention did not escalate');const attention=questionRouter.get(first.view.id).coordinatorRunId;
 await until(()=>taskResult(attention).status==='waiting_input','attention did not release its human wait');
 const second=pendingFixture(old,builder);await until(()=>questionRouter.get(second.view.id).status==='answered','second same-scope question did not wake existing attention');assert.equal(questionRouter.get(second.view.id).coordinatorRunId,attention);assert.equal(q('SELECT count(*) AS n FROM runs WHERE bot_id=?').get(coordinator).n,2);assert.deepEqual(questionRouter.attentionForRun(attention).questionIds.sort((a,b)=>a-b),[first.view.id,second.view.id]);
 const waiting=questionRouter.get(first.view.id);questionRouter.answerHuman(waiting.id,['Owner preference supplied'],{authenticated:true,principal:'fixture-owner',expectedVersion:waiting.version});await done(attention);assert.equal(q('SELECT status FROM runs WHERE id=?').get(old).status,'done');
});

test.after(async()=>{await drainRuntime();db.close();process.chdir(before.cwd);if(before.data===undefined)delete process.env.NIMBUS_DATA;else process.env.NIMBUS_DATA=before.data;if(before.config===undefined)delete process.env.NIMBUS_CONFIG;else process.env.NIMBUS_CONFIG=before.config;console.log('Question runner evidence: '+root);});
