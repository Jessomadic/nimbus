import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'legacy-secret-'));
process.env.NIMBUS_DATA=tmp;
const {WorkerConnectors,invokeConnector,cleanConnectorError}=await import('../runtime/mcp.js');
const {effectTransportHash}=await import('../runtime/mcp-scope.js');
const {journalTool}=await import('../runtime/journal.js');
const {db,q}=await import('../db.js');
test('real SDK legacy exceptions/results redact credentials in output and canonical journal; no replay',async()=>{
 const secret='SYNTHETIC_LEGACY_7382abcdef',m=new WorkerConnectors();
 const cfg={command:process.execPath,args:[fileURLToPath(new URL('./helpers/legacy-secret-connector.mjs',import.meta.url))],env:{FIXTURE_SECRET:secret},reviewedTools:['read','write','ok','result'],reviewedEffects:{}};
 cfg.reviewedEffects.read={effect:'read',transportHash:effectTransportHash('fixture',cfg)};
 const state={principal:{id:22},mcpServers:{fixture:cfg},mcpScopeGroups:{}};
 try{
 const list=await m.tools(22,state.mcpServers,()=>state);assert.deepEqual(list.errors,[]);
 for(const name of ['read','write','result','ok']){
 const binding=list.bindings.get('mcp__fixture__'+name);assert.ok(binding);
 let output;try{output=await journalTool({id:name,runId:1,name,args:{},execute:()=>invokeConnector(binding,22,{})});}catch(e){output={message:e.message,evidence:e.evidence};assert.equal(e.name,'UncertainAction');}
 assert.equal(JSON.stringify(output).includes(secret),false);
 const row=q('SELECT * FROM tool_calls WHERE id=?').get('1:'+name);
 assert.equal(row.result.includes(secret),false);
 assert.equal(row.state,name==='read'?'error':name==='ok'?'done':'uncertain');
 if(name==='ok')assert.equal(output._meta.safe,42);
 if(name==='write')await assert.rejects(journalTool({id:name,runId:1,name,args:{},execute:()=>{throw Error('replayed');}}),/not been replayed/);
 }
 // Loopback HTTP JSON-RPC peer exercises the real SDK HTTP transport with literal headers.
 const {createServer}=await import('node:http');
 const headerSecret='SYNTHETIC_HTTP_7832abc';
 const http=createServer(async(req,res)=>{
  if(req.method!=='POST'){res.writeHead(405);res.end();return;}
  let body='';for await(const chunk of req)body+=chunk;
  const rpc=JSON.parse(body);
  if(rpc.id===undefined){res.writeHead(202);res.end();return;}
  const result=rpc.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:rpc.method==='tools/list'?{tools:[{name:'write',inputSchema:{type:'object'}}]}:null;
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,...(result?{result}:{error:{code:-32603,message:'safe upstream '+req.headers['x-fixture-secret']}})}));
 });
 await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
 try{
 const hcfg={url:'http://127.0.0.1:'+http.address().port+'/mcp',headers:{'X-Fixture-Secret':headerSecret}};
 const hs={principal:{id:22},mcpServers:{http:hcfg},mcpScopeGroups:{}};
 const listed=await m.tools(22,hs.mcpServers,()=>hs);assert.deepEqual(listed.errors,[]);
 await assert.rejects(journalTool({id:'http',runId:1,name:'http',args:{},execute:()=>invokeConnector(listed.bindings.get('mcp__http__write'),22,{})}),e=>{
  assert.equal(JSON.stringify({message:e.message,evidence:e.evidence}).includes(headerSecret),false);
  assert.match(e.evidence.error,/safe upstream/);return e.name==='UncertainAction';
 });
 assert.equal(q('SELECT result FROM tool_calls WHERE id=?').get('1:http').result.includes(headerSecret),false);
 assert.equal(JSON.stringify(q('SELECT * FROM task_events').all()).includes(headerSecret),false);
 }finally{await m.close();await new Promise(resolve=>http.close(resolve));}
 assert.equal(JSON.stringify(q('SELECT * FROM task_events').all()).includes(secret),false);
 }finally{await m.close();db.close();fs.rmSync(tmp,{recursive:true,force:true});}
});
test('legacy header/url and escaped credentials redact without erasing safe diagnostics',()=>{
 const secret='HEADER_SENTINEL_984abc';
 const result=cleanConnectorError('safe '+secret,{headers:{Authorization:'Bearer '+secret}});
 assert.equal(result.includes(secret),false);assert.match(result,/safe/);
 assert.equal(cleanConnectorError('safe passSentinel',{url:'https://u:passSentinel@example.test/?token=tokenSentinel'}).includes('passSentinel'),false);
});
