import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-guidance-'));process.env.NIMBUS_DATA=path.join(temp,'data');process.env.NIMBUS_CONFIG=path.join(temp,'config.json');fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{enabled:false},local:{enabled:false},mcpServers:{}}));
const {executeSpecialist}=await import('../runtime/toolsets/index.js');
const {executeTool,terminals,browsers,connectors}=await import('../runtime/tools.js');const {db,botDir}=await import('../db.js');
const {readWorkerFile}=await import('../runtime/file-read.js');const {observeProgress}=await import('../runtime/progress-execution.js');const {inspectCurrentReadback}=await import('../runtime/completion-readback.js');
const h=x=>createHash('sha256').update(x).digest('hex'),worker={id:999999},dir=botDir(worker.id);
test('invalid bound preserves range and scope without entering registered history handler',async()=>{
 let entered=0;const ctx={query:()=>{entered++;throw Error('handler entered');}};
 const args={runId:11,callId:'11:synthetic',view:'events',maxChars:12000};
 await assert.rejects(executeSpecialist('task_history',args,ctx),e=>{assert.equal(e.message,'Expected an integer from 256 to 8000');assert.deepEqual(e.evidence.readGuidance.nextCall,{tool:'task_history',args:{...args,maxChars:8000}});return true;});
 for(const a of [{maxChars:12000},{runId:-1,callId:'x',maxChars:12000},{callId:'',maxChars:12000},{runId:11,view:'calls',callId:'x',maxChars:12000}]){
 await assert.rejects(executeSpecialist('task_history',a,ctx),e=>!e.evidence.readGuidance.nextCall);}
 assert.equal(entered,0);assert.equal(args.maxChars,12000);
});
test('repeated omitted offsets are deterministic and terminal cursors mean archive completion only',async()=>{
 const d=new DatabaseSync(':memory:');try{d.exec("CREATE TABLE runs(id INTEGER,bot_id INTEGER,status TEXT,source TEXT,requested_model TEXT,actual_model TEXT,last_error TEXT,input_tokens INTEGER,output_tokens INTEGER,started_at INTEGER,ended_at INTEGER);CREATE TABLE tool_calls(id TEXT,run_id INTEGER,name TEXT,args TEXT,result TEXT,state TEXT);INSERT INTO runs(id,bot_id) VALUES(11,1)");
 d.prepare('INSERT INTO tool_calls VALUES(?,?,?,?,?,?)').run('11:synthetic',11,'synthetic_read',JSON.stringify({text:'a'.repeat(17000)}),'{}','done');
 const ctx={botId:1,query:s=>d.prepare(s)},a={runId:11,callId:'11:synthetic',maxChars:8000};
 const first=await executeSpecialist('task_history',a,ctx),again=await executeSpecialist('task_history',a,ctx);assert.deepEqual(first,again);assert.equal(first.nextOffset,8000);assert.deepEqual(first.readGuidance.nextCall.args,{...a,offset:8000});
 let page=first;while(page.nextOffset!==null)page=await executeSpecialist('task_history',page.readGuidance.nextCall.args,ctx);
 assert.equal(page.readGuidance.complete,true);assert.equal(page.readGuidance.nextCall,undefined);assert.match(page.readGuidance.message,/does not mean the task/);
 const index=await executeSpecialist('task_history',{runId:11,view:'calls',limit:1},ctx);assert.equal(index.nextOffset,null);assert.equal(index.readGuidance.complete,true);
 await assert.rejects(executeSpecialist('task_history',{runId:12,callId:'11:synthetic'},ctx),/different run/);
 await assert.rejects(executeSpecialist('task_history',{callId:'not-owned'},ctx),/not owned/);
 }finally{d.close();}
});
test('exact supplied Unicode path, actual cursor, hash and budget survive pagination and change rejection',async()=>{
 const supplied='Unicode 😀 file.txt',f=path.join(dir,supplied),content='A😀B'+'\u0001'.repeat(6000)+'Z';fs.writeFileSync(f,content);
 let args={path:supplied,offset:0,limit:4000},joined='',page;
 do{page=await executeTool(worker,'read_file',args);assert.ok(JSON.stringify(page).length<=10000);joined+=page.content;
 if(page.hasMore){const next=page.readGuidance.nextCall.args;assert.equal(next.path,supplied);assert.equal(next.offset,page.nextOffset);assert.equal(next.expectedSha256,h(Buffer.from(content)));assert.equal(next.limit,4000);args=next;}
 }while(page.hasMore);
 assert.equal(joined,content);assert.equal(page.readGuidance.complete,true);
 const small=await executeTool(worker,'read_file',{path:supplied,offset:0,limit:2});assert.equal(small.content,'A');assert.equal(small.nextOffset,1);
 assert.equal((await executeTool(worker,'read_file',{path:supplied,offset:2,limit:2})).code,'invalid_offset');
 const invalid=await executeTool(worker,'read_file',{path:supplied,limit:12000});assert.equal(invalid.code,'invalid_page');assert.equal(invalid.readGuidance.nextCall.args.limit,4000);
 fs.appendFileSync(f,'changed');assert.equal((await executeTool(worker,'read_file',small.readGuidance.nextCall.args)).code,'file_changed');
});
test('missing path keeps missing_path and has no inferred target or filesystem call',async()=>{
 const orig=fs.statSync;let count=0;fs.statSync=()=>{count++;throw Error('filesystem');};try{
 for(const args of [{},{offset:0,limit:4000},{path:' '},{path:null}]){
 const r=await executeTool(worker,'read_file',args);assert.equal(r.code,'missing_path');assert.deepEqual(r.requiredFields,['path']);assert.equal(r.readGuidance.nextCall,undefined);assert.equal(r.path,undefined);
 }assert.equal(count,0);}finally{fs.statSync=orig;}
});
test('advisory guidance preserves authorization, uncertainty, completion and no-progress behavior',async()=>{
 // Source identity belongs to each release's immutable inventory and review.
 // Runtime regression tests must exercise these boundaries without freezing
 // unrelated modules to a historical release or requiring its artifact path.
 await assert.rejects(executeTool(worker,'mcp__unassigned',{}),/authorization denied/);
 db.prepare("INSERT INTO runs(id,bot_id,delegation_scope) VALUES(881,999999,'conversation')").run();
 const denied=await executeTool(worker,'shell',{command:'MUST NOT EXECUTE'},{runId:881});assert.equal(denied.code,'execution_scope_required');assert.equal(denied.knownNonexecution,true);
 const {UncertainAction}=await import('../runtime/action-error.js');const uncertain=new UncertainAction('synthetic uncertainty',{retained:true});assert.equal(uncertain.name,'UncertainAction');assert.equal(uncertain.evidence.retained,true);
 const state={};const r=await executeTool(worker,'read_file',{});observeProgress(state,'read_file',{},r);observeProgress(state,'read_file',{},r);assert.throws(()=>observeProgress(state,'read_file',{},r),e=>e.pause&&e.code==='no_progress');
 const content='abcdef',sha256=h(content),output='synthetic.txt',row=(start,end)=>({name:'read_file',state:'done',args:JSON.stringify({path:output,offset:start,limit:2}),result:JSON.stringify({path:output,bytes:6,sha256,content:content.slice(start,end),offset:start,nextOffset:end===6?null:end,hasMore:end<6,totalCharacters:6,readGuidance:{complete:true}})});
 assert.equal(inspectCurrentReadback({rows:[row(4,6)],lastCheck:-1,output,content,sha256,bytes:6}).complete,false);
 assert.equal(inspectCurrentReadback({rows:[row(0,2),row(2,4),row(4,6)],lastCheck:-1,output,content,sha256,bytes:6}).complete,true);
});
test.after(async()=>{await terminals.close();await browsers.close();await connectors.close();db.close();fs.rmSync(temp,{recursive:true,force:true});});
