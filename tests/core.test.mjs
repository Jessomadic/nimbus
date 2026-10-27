import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import {EventEmitter} from 'node:events';
import vm from 'node:vm';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-tests-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
const {Slots}=await import('../runtime/slots.js');
const {parseRoute,chooseRoute}=await import('../runtime/router.js');
const {config,saveConfig}=await import('../runtime/config.js');
const {localChat}=await import('../runtime/local.js');
const {encodeRedacted}=await import('../redact.js');
const {journalTool,UncertainAction}=await import('../runtime/journal.js');
const {q,db,writeBotBrief,parseBot}=await import('../db.js');
const {executeTool}=await import('../runtime/tools.js');
const {requiresApproval}=await import('../runtime/policy.js');
const {createBackup,restoreBackup}=await import('../runtime/backup.js');
const {BrowserGroups}=await import('../runtime/browser.js');
const {codexTurn,dynamicToolNames}=await import('../runtime/codex.js');
const {ROLE_PROFILES}=await import('../runtime/roles.js');
const {buildWorkerBrief}=await import('../runtime/prompts.js');
const {inspectImage}=await import('../runtime/workbench.js');
const {validateQuestions,answerQuestion}=await import('../runtime/questions.js');
const {validateParentLink}=await import('../runtime/hierarchy.js');
const {hierarchyRows}=await import('../public/team-tree.js');
const {directLocal,secureRequest,requestIp,sameOriginRequest}=await import('../runtime/network.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('user question answers are validated, durable and cannot be submitted twice',()=>{
  assert.throws(()=>validateQuestions([]),/1 to 3/);
  const questions=validateQuestions([{question:'Choose the known fixture answer',options:['YES','NO']}]);
  const id=Number(q('INSERT INTO task_questions (run_id,questions) VALUES (?,?)').run(1,JSON.stringify(questions)).lastInsertRowid);
  assert.throws(()=>answerQuestion(id,[]),/each question/);
  answerQuestion(id,['YES']);assert.deepEqual(JSON.parse(q('SELECT answers FROM task_questions WHERE id=?').get(id).answers),['YES']);
  assert.throws(()=>answerQuestion(id,['NO']),/no longer pending/);
});

test('Codex dynamic image tools deliver actual pixels and retain image context across turns',async()=>{
  const file=path.join(root,'fixture.png');fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=','base64'));
  const result=inspectImage(file);let delivered=false,rehydrated=false;
  const factory=()=>{
    const client=new EventEmitter();client.initialize=async()=>client;client.close=()=>{client.closed=true;};
    client.request=async(method,params)=>{
      if(method==='account/read')return{account:{type:'chatgpt'}};
      if(method==='thread/start'){assert.equal(params.dynamicTools[0].tools[0].name,'view_image');return{thread:{id:'visual-fixture',ephemeral:true}};}
      if(method==='turn/start'){
        rehydrated=params.input.some(i=>i.type==='localImage'&&i.path===file);
        setImmediate(()=>client.emit('message',{id:42,method:'item/tool/call',params:{tool:'view_image',arguments:{path:file}}}));return{turn:{id:'visual-turn'}};
      }
      throw new Error('Unexpected '+method);
    };
    client.send=message=>{
      if(message.id!==42)return;
      const image=message.result.contentItems.find(i=>i.type==='inputImage');assert.ok(image);assert.match(image.imageUrl,/^data:image\/png;base64,/);delivered=true;
      setImmediate(()=>{client.emit('message',{method:'item/completed',params:{item:{type:'agentMessage',text:'VISUAL_OK'}}});client.emit('message',{method:'turn/completed',params:{turn:{status:'completed'}}});});
    };return client;
  };
  await codexTurn({model:'fixture',effort:'low',instructions:'fixture',messages:[{role:'tool',content:JSON.stringify(result)}],tools:[{function:{name:'view_image',description:'fixture',parameters:{type:'object'}}}],callTool:async()=>result,cwd:root,clientFactory:factory});
  assert.equal(delivered,true);assert.equal(rehydrated,true);
});

test('Windows model-list parser handles empty, single and multiple native CLI results',{skip:process.platform!=='win32'},async()=>{
  const {capture}=await import('../runtime/process.js');
  const modulePath=path.resolve('scripts/LocalModelHelpers.psm1').replaceAll("'","''");
  const result=JSON.parse(await capture('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Import-Module '${modulePath}'; @( '[]','[{"identifier":"one"}]','[{"identifier":"one"},{"identifier":"two"}]') | ForEach-Object { @(ConvertFrom-NimbusModelJson $_).Count } | ConvertTo-Json -Compress`]));
  assert.deepEqual(result,[0,1,2]);
});

test('shared local slots serialize requests and release a cancelled queue entry',async()=>{
  const slots=new Slots(1),abort=new AbortController();let active=0,peak=0;
  const first=slots.use(null,async()=>{active++;peak=Math.max(peak,active);await sleep(25);active--;});
  const cancelled=slots.acquire(abort.signal);abort.abort(new Error('cancelled'));
  await assert.rejects(cancelled,/cancelled/);
  const second=slots.use(null,async()=>{active++;peak=Math.max(peak,active);active--;});
  await Promise.all([first,second]);assert.equal(peak,1);assert.deepEqual(slots.snapshot(),{active:0,queued:0,limit:1});
});
test('configuration refuses extra local instances and resource-limit bypass',()=>{
  assert.throws(()=>saveConfig({local:{maxConcurrent:2}}),/concurrency/);
  assert.throws(()=>saveConfig({local:{resourceCeiling:91}}),/resource ceiling/);
  assert.equal(config().local.maxConcurrent,1);
});
test('JSON redaction preserves numeric usage, braces and action IDs',()=>{
  const object={input_tokens:123456,output_tokens:987654,total_tokens:1111110,access_token:'private-token-value',content:'Receipt abc',id:'3:tool-one'};
  const read=JSON.parse(encodeRedacted(object));assert.equal(read.input_tokens,123456);assert.equal(read.id,object.id);assert.equal(read.access_token,'[REDACTED]');
});
test('local router decision is model-authored and validated',async()=>{
  let request;
  const route=await chooseRoute({task:'implement parser',role:'Builder',classify:async(messages)=>{request=messages;return{model:'shared-model',message:{content:JSON.stringify({tier:'terra',effort:'high',reason:'Implementation requires structured coding.',fallbackTier:'local'})}};}});
  assert.equal(route.tier,'terra');assert.equal(route.router,'shared-model');assert.match(request[1].content,/implement parser/);
  assert.throws(()=>parseRoute('{"tier":"invented"}'),/invalid/);
});
test('OpenAI exhaustion selects local capacity without calling a cloud router',async()=>{
  const result=await chooseRoute({task:'task',cloudAvailable:false,classify:async()=>{throw new Error('must not run');}});
  assert.equal(result.tier,'local');
});
test('explicit model override is recorded independently of automatic routing',async()=>{
  const result=await chooseRoute({task:'task',pinned:'astra',effort:'xhigh',classify:async()=>{throw new Error('must not run');}});
  assert.equal(result.tier,'astra');assert.equal(result.router,'explicit');
});
test('VRAM admission failure in the local router falls back to the role cloud preference',async()=>{
  const result=await chooseRoute({task:'Create an artifact',preferredTier:'sol',effort:'high',classify:async()=>{throw new Error('The projected load would exceed the configured RAM or VRAM ceiling.');}});
  assert.equal(result.tier,'sol');assert.equal(result.router,'availability');assert.equal(result.fallbackFrom,'local');assert.equal(result.effort,'high');assert.match(result.fallbackReason,/VRAM ceiling/);
});
test('local role preference and local overrides retain an available subscription escape route',async()=>{
  const unavailable=async()=>{throw new Error('Local inference failed (503): insufficient VRAM');};
  const automatic=await chooseRoute({task:'Curate a note',preferredTier:'local',classify:unavailable});
  assert.equal(automatic.tier,'luna');assert.match(automatic.fallbackReason,/insufficient VRAM/);
  const explicit=await chooseRoute({task:'task',pinned:'local',preferredTier:'astra',classify:unavailable});
  assert.equal(explicit.tier,'local');assert.equal(explicit.fallbackTier,'astra');
  const c=config();c.routing.cloudFallbackTier='terra';
  assert.equal((await chooseRoute({task:'task',preferredTier:'local',c,classify:unavailable})).tier,'terra');
  assert.throws(()=>saveConfig({routing:{cloudFallbackTier:'local'}}),/cloud fallback/);
});
test('a local-only classifier fallback cannot strand execution while OpenAI is available',async()=>{
  const route=await chooseRoute({task:'task',preferredTier:'sol',classify:async()=>({model:'fixture',message:{content:JSON.stringify({tier:'local',fallbackTier:'local',effort:'low',reason:'Simple task'})}})});
  assert.equal(route.tier,'local');assert.equal(route.fallbackTier,'sol');
});
test('cancellation and disabled cloud execution never turn into a cloud fallback',async()=>{
  const abort=new AbortController();
  await assert.rejects(chooseRoute({task:'task',signal:abort.signal,classify:async()=>{abort.abort(new Error('User cancelled'));throw new Error('Local inference stopped');}}),/User cancelled/);
  const c=config();c.cloud.enabled=false;
  const route=await chooseRoute({task:'task',pinned:'astra',c,classify:async()=>{throw new Error('Must not classify');}});
  assert.equal(route.tier,'local');assert.equal(route.fallbackTier,'local');
});
test('role preference reaches the local router while task-fit selection and explicit overrides remain authoritative',async()=>{
  const result=await chooseRoute({task:'Extract a short title from supplied text',role:'Technical Writer',preferredTier:'astra',classify:async messages=>{
    const input=JSON.parse(messages[1].content);assert.equal(input.preferredTier,'astra');assert.match(input.task,/Extract/);
    return{model:'fixture-router',message:{content:JSON.stringify({tier:'local',effort:'low',reason:'The bounded extraction is suitable for the shared local model.',fallbackTier:'luna'})}};
  }});
  assert.equal(result.tier,'local');assert.equal(result.preferredTier,'astra');
  const override=await chooseRoute({task:'task',preferredTier:'astra',pinned:'terra',classify:async()=>{throw new Error('Explicit override must bypass routing');}});
  assert.equal(override.tier,'terra');
  assert.equal((await chooseRoute({task:'task',preferredTier:'astra',cloudAvailable:false})).tier,'local');
});
test('Codex worker sessions require ephemeral mode and cannot silently persist into the app history',async()=>{
  function factory(confirm){return()=>{
    const client=new EventEmitter();client.initialize=async()=>client;client.close=()=>{client.closed=true;};
    client.request=async(method,params)=>{
      if(method==='account/read')return{account:{type:'chatgpt'}};
      if(method==='thread/start'){assert.equal(params.ephemeral,true);return{thread:{id:'temporary-fixture',ephemeral:confirm}};}
      if(method==='turn/start'){
        setImmediate(()=>{client.emit('message',{method:'item/completed',params:{item:{type:'agentMessage',text:'TEMPORARY_OK'}}});client.emit('message',{method:'turn/completed',params:{turn:{status:'completed'}}});});
        return{turn:{id:'fixture-turn'}};
      }
      throw new Error('Unexpected protocol method '+method);
    };return client;
  };}
  const request={model:'fixture-luna',effort:'low',instructions:'fixture',messages:[],tools:[],callTool:async()=>{throw new Error('No tool expected');},cwd:root};
  const result=await codexTurn({...request,clientFactory:factory(true)});assert.equal(result.text,'TEMPORARY_OK');
  await assert.rejects(codexTurn({...request,clientFactory:factory(false)}),/ephemeral/);
});
test('connector tools use stable bounded non-reserved Codex names while preserving canonical policy names',()=>{
  const tool={type:'function',function:{name:'mcp__github__add_comment_to_pending_review',description:'GitHub review comment',parameters:{type:'object'}}};
  const first=dynamicToolNames([tool]),again=dynamicToolNames([tool]),alias=first.definitions[0].name;
  assert.ok(!alias.startsWith('mcp__'));assert.ok(alias.length<=64);assert.equal(again.definitions[0].name,alias);assert.equal(first.aliases.get(alias),tool.function.name);assert.match(first.definitions[0].description,/mcp__github__/);
});
test('specialist briefs carry role defaults and preserve private memory when regenerated',()=>{
  assert.equal(new Set(ROLE_PROFILES.map(r=>r.id)).size,21);
  for(const profile of ROLE_PROFILES){
    assert.ok(['local','luna','terra','sol','astra'].includes(profile.default_model));
    const brief=buildWorkerBrief({bot:{...profile,name:profile.name,tools:JSON.stringify(profile.tools)},team:[{id:42,name:'Teammate',role:'fixture'}],workspace:root});
    assert.ok(brief.includes(profile.instructions));assert.match(brief,/Teammate \(#42\)/);assert.match(brief,/Never automatically repeat an uncertain/);
  }
  const id=Number(q('INSERT INTO bots (name,instructions,default_model) VALUES (?,?,?)').run('Prompt fixture','User-specific requirement: retain OEM edition references.','astra').lastInsertRowid);
  const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(id)),dir=writeBotBrief(bot),memory=path.join(dir,'MEMORY.md');
  fs.writeFileSync(memory,'Existing durable note');writeBotBrief(bot);
  assert.equal(fs.readFileSync(memory,'utf8'),'Existing durable note');assert.match(fs.readFileSync(path.join(dir,'AGENTS.md'),'utf8'),/retain OEM edition references/);
});
test('worker parent relationships reject self, descendant cycles and missing parents',()=>{
  const bots=[{id:1,parent_bot_id:null},{id:2,parent_bot_id:1},{id:3,parent_bot_id:2}];
  assert.doesNotThrow(()=>validateParentLink(4,3,bots));assert.throws(()=>validateParentLink(1,1,bots),/cycle/);
  assert.throws(()=>validateParentLink(1,3,bots),/cycle/);assert.throws(()=>validateParentLink(4,99,bots),/not found/);
  const rows=hierarchyRows([{key:'child',parent:'root'},{key:'other'},{key:'root'}]);
  assert.equal(rows.find(r=>r.key==='child').depth,1);assert.ok(rows.findIndex(r=>r.key==='child')>rows.findIndex(r=>r.key==='root'));
  assert.equal(ROLE_PROFILES.filter(p=>p.parent_profile==='github-coordinator').length,5);
});
test('Cloudflare forwarding is trusted only from loopback and cannot enable local administration',()=>{
  const forwarded={socket:{remoteAddress:'127.0.0.1'},headers:{host:'nimbus.example.com','x-forwarded-proto':'https','cf-connecting-ip':'203.0.113.7',origin:'https://nimbus.example.com'}};
  assert.equal(secureRequest(forwarded),true);assert.equal(directLocal(forwarded),false);assert.equal(requestIp(forwarded),'203.0.113.7');assert.equal(sameOriginRequest(forwarded),true);
  assert.equal(sameOriginRequest({...forwarded,headers:{...forwarded.headers,origin:'https://unrelated.example'}}),false);
  const external={...forwarded,socket:{remoteAddress:'198.51.100.2'}};assert.equal(secureRequest(external),false);assert.equal(requestIp(external),'198.51.100.2');
  assert.equal(directLocal({socket:{remoteAddress:'127.0.0.1'},headers:{}}),true);
});
test('mobile offline worker never caches private APIs or queues instruction writes',async()=>{
  const handlers={},lookups=[];
  vm.runInNewContext(fs.readFileSync(path.resolve('public/sw.js'),'utf8'),{URL,self:{location:{origin:'https://nimbus.example.com'},addEventListener:(name,fn)=>handlers[name]=fn},fetch:async()=>{throw new Error('offline');},caches:{match:async p=>{lookups.push(p);return'offline-notice';}}});
  for(const [method,url] of [['GET','/api/state'],['GET','/api/events'],['POST','/api/tasks'],['POST','/api/login']]){
    let intercepted=false;handlers.fetch({request:{method,url:'https://nimbus.example.com'+url,mode:'cors'},respondWith:()=>intercepted=true});assert.equal(intercepted,false);
  }
  let response;handlers.fetch({request:{method:'GET',url:'https://nimbus.example.com/',mode:'navigate'},respondWith:p=>response=p});
  assert.equal(await response,'offline-notice');assert.deepEqual(lookups,['/offline.html']);
});
test('real HTTP local adapter forwards the common tool schema and history',async()=>{
  let received;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify({models:[{key:'test-local',loaded_instances:[{id:'one'}],max_context_length:8192}]}));return;}
    let body='';for await(const c of req)body+=c;received=JSON.parse(body);
    res.end(JSON.stringify({model:'test-local',choices:[{finish_reason:'stop',message:{role:'assistant',content:'ready'}}],usage:{prompt_tokens:8,completion_tokens:1}}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const c=config();c.local.baseUrl=`http://127.0.0.1:${server.address().port}/v1`;c.local.model='test-local';c.local.approvedModels=['test-local'];c.local.tokenDpapiFile='';c.local.tokenEnv='NIMBUS_TEST_EMPTY';
    const tools=[{type:'function',function:{name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}}}];
    const result=await localChat([{role:'user',content:'test history'}],{tools,c,guard:async()=>{}});
    assert.equal(result.model,'test-local');assert.deepEqual(received.tools,tools);assert.equal(received.messages[0].content,'test history');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('Nimbus tool execution writes and reads a real workspace file',async()=>{
  const id=Number(q('INSERT INTO bots (name) VALUES (?)').run('Fixture worker').lastInsertRowid);
  const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(id));writeBotBrief(bot);
  const wrote=await executeTool(bot,'write_file',{path:'receipt.txt',content:'actual-file-receipt'});
  assert.equal(fs.readFileSync(wrote.path,'utf8'),'actual-file-receipt');
  assert.equal((await executeTool(bot,'read_file',{path:'receipt.txt'})).content,'actual-file-receipt');
});
test('journal returns a completed result without replaying its side effect',async()=>{
  let calls=0;const invoke=()=>journalTool({id:'same',runId:1,name:'write_file',args:{path:'one'},execute:async()=>{calls++;return{receipt:'one'};}});
  assert.deepEqual(await invoke(),{receipt:'one'});assert.deepEqual(await invoke(),{receipt:'one'});assert.equal(calls,1);
  await assert.rejects(journalTool({id:'same',runId:1,name:'write_file',args:{path:'different'},execute:async()=>{calls++;}}),UncertainAction);
});
test('uncertain action prevents an automatic replay',async()=>{
  let calls=0;const invoke=()=>journalTool({id:'uncertain',runId:2,name:'shell',args:{command:'example'},execute:async()=>{calls++;throw new UncertainAction('connection broke after execution');}});
  await assert.rejects(invoke(),UncertainAction);await assert.rejects(invoke(),UncertainAction);assert.equal(calls,1);
});
test('worker rules apply to the common local and cloud tool names',()=>{
  const bot={approval_rules:['shell(*git push*)','mcp__*send*'],allow_rules:['shell(git status)']};
  assert.equal(requiresApproval(bot,'shell',{command:'git push origin main'}),true);
  assert.equal(requiresApproval(bot,'shell',{command:'git status'}),false);
  assert.equal(requiresApproval(bot,'mcp__mail__send',{to:'somebody'}),true);
});
test('restart recovery retains checkpoints and requires action review',async()=>{
  const {recoverRuns,resumeRun}=await import('../runner.js');
  const botId=q('SELECT id FROM bots LIMIT 1').get().id;
  const id=Number(q('INSERT INTO runs (bot_id,thread,prompt,status,checkpoint) VALUES (?,?,?,?,?)').run(botId,'bot:'+botId,'task','running',JSON.stringify({messages:[{role:'user',content:'retained'}],steps:0})).lastInsertRowid);
  q('INSERT INTO tool_calls (id,run_id,name,args,state) VALUES (?,?,?,?,?)').run(id+':started',id,'shell','{}','running');
  recoverRuns();assert.equal(q('SELECT status FROM runs WHERE id=?').get(id).status,'interrupted');
  assert.match(q('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint,/retained/);
  assert.throws(()=>resumeRun(id),/uncertain/);
});
test('checkpoint recovery uses the committed tool receipt without repeating execution',async()=>{
  const {reconcileCheckpoint}=await import('../runner.js');
  const runId=991,callId='saved';let executed=0;
  await journalTool({id:callId,runId,name:'write_file',args:{path:'saved'},execute:async()=>{executed++;return{saved:true};}});
  const state={messages:[{role:'assistant',content:null,tool_calls:[{id:callId,type:'function',function:{name:'write_file',arguments:'{}'}}]}]};
  const result=reconcileCheckpoint(runId,state);
  assert.equal(executed,1);assert.deepEqual(JSON.parse(result.messages[1].content),{saved:true});
  assert.equal(reconcileCheckpoint(runId,result).messages.length,2);
});
test('cancelling a running host tool retains an uncertain action and blocks replay',async()=>{
  const bot=parseBot(q('SELECT * FROM bots LIMIT 1').get()),abort=new AbortController();
  const command=process.platform==='win32'?"Write-Output started; Start-Sleep -Seconds 20":'echo started; sleep 20';
  const args={command,timeoutSeconds:30};let calls=0;
  const timer=setTimeout(()=>abort.abort(new Error('Cancellation fixture')),800);
  try{
    await assert.rejects(journalTool({id:'cancel-host',runId:992,name:'shell',args,signal:abort.signal,execute:async()=>{calls++;return executeTool(bot,'shell',args,{signal:abort.signal});}}),UncertainAction);
    await assert.rejects(journalTool({id:'cancel-host',runId:992,name:'shell',args,execute:async()=>{calls++;}}),UncertainAction);
    assert.equal(calls,1);assert.equal(q('SELECT state FROM tool_calls WHERE id=?').get('992:cancel-host').state,'uncertain');
  }finally{clearTimeout(timer);}
});
test('encrypted backup restores durable state and rejects tampering before extraction',async()=>{
  const key=randomBytes(32),dataDir=process.env.NIMBUS_DATA;
  fs.writeFileSync(path.join(dataDir,'artifact.txt'),'backup artifact');
  const backup=await createBackup({dataDir,key,includeCredentials:false});
  const destination=path.join(root,'restore');
  await restoreBackup({file:backup.file,destination,key,protectCredential:async s=>s});
  assert.equal(fs.readFileSync(path.join(destination,'data','artifact.txt'),'utf8'),'backup artifact');
  const restored=new (await import('node:sqlite')).DatabaseSync(path.join(destination,'data','nimbus.db'),{readOnly:true});
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM runs').get().n,q('SELECT COUNT(*) AS n FROM runs').get().n);restored.close();
  const corrupt=path.join(root,'corrupt.nbak'),bytes=fs.readFileSync(backup.file);bytes[25]^=1;fs.writeFileSync(corrupt,bytes);
  const never=path.join(root,'never-extracted');await assert.rejects(restoreBackup({file:corrupt,destination:never,key}));assert.equal(fs.existsSync(never),false);
});
test('browser groups isolate tabs and cookies, reject other owners, and preserve group state',async()=>{
  const previousLimit=config().browser.maxGroups;saveConfig({browser:{maxGroups:2}});
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<html><body><h1>Group fixture</h1><button onclick="document.cookie=\'group=owner-a;path=/\';document.querySelector(\'h1\').textContent=\'Clicked\'">Change</button></body></html>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  const opts={dataDir:path.join(root,'browser-fixture'),protectState:async s=>s,unprotectState:async s=>s};
  let manager=new BrowserGroups(opts);
  try{
    const [a,b]=await Promise.all([manager.perform(11,{action:'open',url}),manager.perform(12,{action:'open',url})]);
    await assert.rejects(manager.perform(13,{action:'open',url}),/group limit/);
    assert.notEqual(a.tabId,b.tabId);
    await manager.perform(11,{action:'click',tabId:a.tabId,role:'button',name:'Change'});
    const snapshot=await manager.perform(11,{action:'snapshot',tabId:a.tabId});assert.match(snapshot.snapshot,/Clicked/);
    assert.equal((await (await manager.group(11)).context.cookies()).find(c=>c.name==='group').value,'owner-a');
    assert.equal((await (await manager.group(12)).context.cookies()).some(c=>c.name==='group'),false);
    await assert.rejects(manager.perform(12,{action:'snapshot',tabId:a.tabId}),/does not belong/);
    await manager.close();manager=new BrowserGroups(opts);
    const restored=await manager.group(11);assert.equal((await restored.context.cookies()).find(c=>c.name==='group').value,'owner-a');
  }finally{await manager.close();server.closeAllConnections();await new Promise(r=>server.close(r));saveConfig({browser:{maxGroups:previousLimit}});}
});
test.after(()=>{db.close();const resolved=path.resolve(root);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('nimbus-tests-'))throw new Error('Unexpected test cleanup path');fs.rmSync(resolved,{recursive:true,force:true});});
