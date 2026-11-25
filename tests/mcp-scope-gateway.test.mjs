import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerConnectors,invokeConnector,connectorAllowed} from '../runtime/mcp.js';
function fixture(names=['read','write']){
 let calls=0,connects=0;
 const descriptors=names.map(name=>({name,inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:name==='read',idempotentHint:true,openWorldHint:false,custom:'retained'},_meta:{extension:1}}));
 const result={content:[{type:'text',text:'retained',annotations:{audience:['user']}}],structuredContent:{value:42},_meta:{custom:1}};
 const client={listTools:async()=>({tools:descriptors}),callTool:async()=>{calls++;return result;}};
 class Fake extends WorkerConnectors{async connect(owner,name,cfg){connects++;this.clients.set(this.cacheKey(owner,name,cfg),Promise.resolve(client));return client;}}
 const manager=new Fake(),c={principal:{id:22,template:'orchestrator'},mcpServers:{test:{command:'synthetic',scope:{allow:{workerIds:[22]}}}},mcpScopeGroups:{}};
 return {manager,c,current:()=>c,result,descriptors,client,calls:()=>calls,connects:()=>connects};
}
test('denied server is never connected; full schema and descriptors survive; revocation denies stale bindings',async()=>{
 const f=fixture();f.c.principal.id=3;
 assert.equal((await f.manager.tools(3,f.c.mcpServers,f.current)).available.length,0);assert.equal(f.connects(),0);
 f.c.principal.id=22;const list=await f.manager.tools(22,f.c.mcpServers,f.current),b=list.bindings.get('mcp__test__read');
 assert.deepEqual(b.descriptor,f.descriptors[0]);assert.deepEqual(list.available[0].function.parameters,f.descriptors[0].inputSchema);
 const r=await invokeConnector(b,22,{});for(const key of Object.keys(f.result))assert.deepEqual(r[key],f.result[key]);
 assert.equal(connectorAllowed(b,3),false);
 f.c.mcpServers.test.scope.allow.workerIds=[];
 await assert.rejects(invokeConnector(b,22,{}),/authorization denied/);assert.equal(f.calls(),1);
});
test('collisions including denied tools publish neither identity',async()=>{
 const f=fixture(['a.b','a_b']);f.c.mcpServers.test.scope.tools={'a.b':{deny:{workerIds:[22]}}};
 const list=await f.manager.tools(22,f.c.mcpServers,f.current);assert.equal(list.bindings.size,0);
});
test('write errors retain structured uncertainty and do not replay; close invalidates bindings',async()=>{
 const f=fixture();f.result.isError=true;
 const list=await f.manager.tools(22,f.c.mcpServers,f.current),b=list.bindings.get('mcp__test__write');
 await assert.rejects(invokeConnector(b,22,{}),e=>e.name==='UncertainAction'&&e.evidence.result.structuredContent.value===42);
 assert.equal(f.calls(),1);f.manager.clients.clear();
 await assert.rejects(invokeConnector(b,22,{}),/authorization denied/);assert.equal(f.calls(),1);
});
test('normalized denied-server alias prevents all discovery without connecting',async()=>{
 const f=fixture();f.c.mcpServers={'a.b':{command:'synthetic',scope:{allow:{}}},a_b:{command:'synthetic'}};
 const list=await f.manager.tools(22,f.c.mcpServers,f.current);assert.equal(list.available.length,0);assert.equal(f.connects(),0);
});
test('write transport timeout and cancellation remain uncertain; preflight abort submits nothing',async()=>{
 const f=fixture();let submitted=0;f.client.callTool=async()=>{submitted++;throw new Error('timeout');};
 const list=await f.manager.tools(22,f.c.mcpServers,f.current),b=list.bindings.get('mcp__test__write');
 await assert.rejects(invokeConnector(b,22,{}),e=>e.name==='UncertainAction');assert.equal(submitted,1);
 const controller=new AbortController();controller.abort(new Error('cancelled before submission'));
 await assert.rejects(invokeConnector(b,22,{},{signal:controller.signal}),/cancelled before/);assert.equal(submitted,1);
});
test('failed paginated discovery publishes no partial entries',async()=>{
 const f=fixture();let count=0;f.client.listTools=async()=>++count===1?{tools:f.descriptors,nextCursor:'repeat'}:Promise.reject(new Error('disconnected'));
 const list=await f.manager.tools(22,f.c.mcpServers,f.current);assert.equal(list.bindings.size,0);assert.equal(list.errors.length,1);
});
