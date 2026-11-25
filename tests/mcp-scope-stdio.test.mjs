import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {WorkerConnectors,invokeConnector} from '../runtime/mcp.js';
test('real SDK stdio scope, metadata, uncertain write and reconnect generation',{timeout:20000},async()=>{
 const manager=new WorkerConnectors(),cfg={command:process.execPath,args:[fileURLToPath(new URL('./helpers/scope-connector.mjs',import.meta.url))],scope:{allow:{groups:['operators']}}};
 const state={principal:{id:22,template:'orchestrator'},mcpScopeGroups:{operators:{workerIds:[22]}},mcpServers:{fixture:cfg}},current=()=>state;
 try{
 const first=await manager.tools(22,state.mcpServers,current);assert.deepEqual(first.errors,[]);
 const read=first.bindings.get('mcp__fixture__read');assert.equal(read.descriptor.annotations.openWorldHint,false);
 const result=await invokeConnector(read,22,{value:4});assert.equal(result.structuredContent.value,4);assert.equal(result._meta.fixture,true);
 await assert.rejects(invokeConnector(first.bindings.get('mcp__fixture__write'),22,{value:5}),e=>e.name==='UncertainAction'&&e.evidence.result.structuredContent.value===5);
 await manager.close();await manager.tools(22,state.mcpServers,current);
 await assert.rejects(invokeConnector(read,22,{}),/authorization denied/);
 state.mcpScopeGroups.operators.workerIds=[];const denied=await manager.tools(22,state.mcpServers,current);assert.equal(denied.available.length,0);
 }finally{await manager.close();}
});
