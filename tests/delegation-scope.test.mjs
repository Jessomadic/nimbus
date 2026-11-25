import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-delegation-scope-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
const toolUrl=new URL('../runtime/tools.js',import.meta.url).href;
registerHooks({load(url,ctx,next){if(url!==toolUrl)return next(url,ctx);return {format:'module',source:fs.readFileSync(fileURLToPath(url),'utf8')+'\nexport {connectors as fixtureConnectors};\n',shortCircuit:true};}});
const {db,q}=await import('../db.js');
const {insertQueuedRun}=await import('../runtime/run-create.js');
const {buildTools,executeTool,coreTools,fixtureConnectors}=await import('../runtime/tools.js');
const {ensureDelegationScopeSchema}=await import('../runtime/delegation-scope.js');
const names=['read_file','list_files','shared_note','write_file','shell','exec_command','write_stdin','apply_patch','run_checks','browser','request_user_input','self_update','ask_worker','request_tool','project_recovery','tool_catalog'];
const botId=Number(q('INSERT INTO bots(name,template,tools) VALUES(?,?,?)').run('scope fixture','builder',JSON.stringify(names)).lastInsertRowid);
const bot={id:botId,name:'scope fixture',template:'builder',tools:JSON.stringify(names)};
const parent=Number(q("INSERT INTO runs(bot_id,thread,prompt,status) VALUES(?,'bot:1','parent','running')").run(botId).lastInsertRowid);
const create=extra=>insertQueuedRun(db,{botId,thread:'bot:'+botId,prompt:'private fixture',parentRun:parent,...extra});
const conversation=create({delegationScope:'conversation'});

test('pre-scope migration adds only the legacy marker and preserves existing task state exactly',()=>{
 const legacy=new DatabaseSync(':memory:');
 try{
  legacy.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,prompt TEXT,checkpoint TEXT,parent_run INTEGER,completion_required INTEGER)');
  const insert=legacy.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?)');
  for(const [id,status] of [[1,'running'],[2,'done'],[3,'waiting_input'],[4,'needs_review'],[5,'paused']])insert.run(id,status,'Retain '+id,JSON.stringify({messages:[{role:'assistant',content:'Existing evidence '+id}]}),id===1?null:1,id%2);
  const plain=value=>JSON.parse(JSON.stringify(value));
  const before=plain(legacy.prepare('SELECT * FROM runs ORDER BY id').all());
  ensureDelegationScopeSchema(legacy);
  const expected=before.map(row=>({...row,delegation_scope:'legacy'}));
  assert.deepEqual(plain(legacy.prepare('SELECT * FROM runs ORDER BY id').all()),expected);
  ensureDelegationScopeSchema(legacy);
  assert.deepEqual(plain(legacy.prepare('SELECT * FROM runs ORDER BY id').all()),expected);
  assert.throws(()=>legacy.prepare("UPDATE runs SET delegation_scope='conversation' WHERE id=1").run(),/immutable delegation scope/);
  legacy.prepare("UPDATE runs SET status='done' WHERE id=1").run();
  assert.deepEqual(plain(legacy.prepare('SELECT * FROM runs ORDER BY id').all()),expected.map(row=>row.id===1?{...row,status:'done'}:row));
 }finally{legacy.close();}
});

test('new conversation scope is durable and immutable while legacy entry points remain explicit',()=>{
 assert.equal(q('SELECT delegation_scope FROM runs WHERE id=?').get(parent).delegation_scope,'legacy');
 assert.equal(q('SELECT delegation_scope FROM runs WHERE id=?').get(conversation).delegation_scope,'conversation');
 assert.equal(q('SELECT completion_required FROM runs WHERE id=?').get(conversation).completion_required,0);
 assert.throws(()=>q("UPDATE runs SET delegation_scope='legacy' WHERE id=?").run(conversation),/immutable delegation scope/);
 assert.throws(()=>q("UPDATE runs SET delegation_scope='execution' WHERE id=?").run(conversation),/immutable delegation scope/);
 ensureDelegationScopeSchema(db);assert.equal(q('SELECT delegation_scope FROM runs WHERE id=?').get(conversation).delegation_scope,'conversation');
 assert.throws(()=>create({delegationScope:'execution'}),/descriptor disagree/);
 assert.throws(()=>create({delegationScope:'legacy'}),/Invalid delegated/);
 assert.throws(()=>create({delegationScope:'conversation',parentRun:null}),/active parent/);
 const direct=create({parentRun:null});assert.equal(q('SELECT delegation_scope FROM runs WHERE id=?').get(direct).delegation_scope,'legacy');
});

test('conversation tool discovery never initializes connectors or advertises execution',async()=>{
 const original=fixtureConnectors.tools;let calls=0;fixtureConnectors.tools=async()=>{calls++;throw Error('Connector discovery must not run');};
 try{
  const available=await buildTools(bot,{conversationOnly:true});assert.equal(calls,0);assert.equal(available.bindings.size,0);assert.deepEqual(available.errors,[]);
  const enabled=new Map(available.tools.map(tool=>[tool.function.name,tool]));
  for(const name of ['read_file','list_files','shared_note','request_user_input','self_update','tool_catalog','ask_worker'])assert.ok(enabled.has(name));
  for(const name of ['write_file','shell','exec_command','write_stdin','apply_patch','run_checks','browser','request_tool','project_recovery'])assert.equal(enabled.has(name),false,name);
  assert.equal(Object.hasOwn(enabled.get('shared_note').function.parameters.properties,'content'),false);
  assert.deepEqual(enabled.get('self_update').function.parameters.properties.action.enum,['status']);
  assert.deepEqual(enabled.get('ask_worker').function.parameters.properties.executionScope.enum,['conversation']);
  assert.equal(Object.hasOwn(enabled.get('ask_worker').function.parameters.properties,'completionDescriptor'),false);
  assert.ok(Object.hasOwn(coreTools.find(t=>t.function.name==='shared_note').function.parameters.properties,'content'),'other workers keep their original schema');
 }finally{fixtureConnectors.tools=original;}
});

test('forced execution calls are rejected before handlers, callbacks, connectors or file effects',async()=>{
 const output=path.join(root,'must-not-exist.txt');let callbacks=0;
 const attempts=[['write_file',{path:output,content:'no'}],['shared_note',{key:'forbidden.txt',content:'no'}],['shared_note',{key:'forbidden.txt',content:null}],['shell',{command:'not executed'}],['exec_command',{command:'not executed'}],['write_stdin',{sessionId:'none'}],['run_checks',{runner:'node_test',path:root,files:['none.mjs']}],['apply_patch',{edits:[]}],['browser',{action:'navigate',url:'https://example.invalid'}],['self_update',{action:'snapshot'}],['self_update',{action:'validate'}],['self_update',{action:'apply'}],['ask_worker',{to:String(botId),task:'execute',executionScope:'execution'}],['request_tool',{name:'missing'}],['project_recovery',{action:'resume'}],['mcp__fixture__write',{}],['nimbus__connector_write',{}]];
 for(const [name,args] of attempts){const result=await executeTool(bot,name,args,{runId:conversation,bindings:new Map([['mcp__fixture__write',{invoke:()=>callbacks++}]]),askWorker:()=>callbacks++,requestTool:()=>callbacks++,projectRecovery:()=>callbacks++});assert.equal(result.code,'execution_scope_required',name);assert.equal(result.knownNonexecution,true,name);}
 assert.equal(callbacks,0);assert.equal(fs.existsSync(output),false);assert.equal(fs.existsSync(path.join(root,'data/shared/forbidden.txt')),false);
});

test('read tools return real metadata and checkpoint text cannot upgrade scope',async()=>{
 const file=path.join(root,'existing.txt'),content='retained \u00e9\r\n';fs.writeFileSync(file,content);
 q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({delegation_scope:'execution',conversationOnly:false}),conversation);
 const read=await executeTool(bot,'read_file',{path:file},{runId:conversation});assert.equal(read.content,content);assert.equal(read.bytes,Buffer.byteLength(content));assert.equal(read.sha256,createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
 const denied=await executeTool(bot,'write_file',{path:file,content:'changed'},{runId:conversation});assert.equal(denied.knownNonexecution,true);assert.equal(fs.readFileSync(file,'utf8'),content);
 const missing=await executeTool(bot,'shared_note',{key:'missing.txt'},{runId:conversation});assert.equal(missing.exists,false);assert.equal(missing.sha256,null);
 let delegated=0;const reply=await executeTool(bot,'ask_worker',{to:'4',task:'planning only',executionScope:'conversation'},{runId:conversation,askWorker:()=>({readOnlyConversation:++delegated})});assert.equal(reply.readOnlyConversation,1);
});

test('legacy direct tool execution preserves existing behavior',async()=>{
 const id=create({parentRun:null}),file=path.join(root,'legacy-output.txt');
 const result=await executeTool(bot,'write_file',{path:file,content:'legacy owned fixture'},{runId:id});assert.equal(fs.readFileSync(file,'utf8'),'legacy owned fixture');assert.ok(result.sha256);
});

test('read-only conversation can request a hash-pinned tail without command tools',async()=>{
 const file=path.join(root,'long-readonly.txt'),content='x'.repeat(9000)+'tail evidence';fs.writeFileSync(file,content);
 const tools=await buildTools(bot,{conversationOnly:true}),schema=tools.tools.find(t=>t.function.name==='read_file').function.parameters.properties;
 assert.ok(schema.offset&&schema.limit&&schema.expectedSha256);
 const first=await executeTool(bot,'read_file',{path:file,offset:0,limit:4000},{runId:conversation});assert.equal(first.hasMore,true);assert.equal(first.nextOffset,4000);
 const tail=await executeTool(bot,'read_file',{path:file,offset:9000,limit:4000,expectedSha256:first.sha256},{runId:conversation});assert.equal(tail.content,'tail evidence');assert.equal(tail.hasMore,false);assert.equal(tail.sha256,first.sha256);assert.equal(fs.readFileSync(file,'utf8'),content);
});

test.after(()=>{db.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^nimbus-delegation-scope-/);fs.rmSync(root,{recursive:true,force:true});});
