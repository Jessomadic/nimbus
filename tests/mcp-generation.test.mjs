import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerConnectors,invokeConnector,connectorAllowed} from '../runtime/mcp.js';
test('missing generation fails closed; replacement and close revoke old bindings',async()=>{
 let calls=0;
 const client={listTools:async()=>({tools:[{name:'write',inputSchema:{type:'object'}}]}),callTool:async()=>{calls++;return {content:[]};},close:async()=>{}};
 class Fake extends WorkerConnectors{
  registered=false;
  async connect(owner,name,cfg){if(this.registered)this.clients.set(this.cacheKey(owner,name,cfg),Promise.resolve(client));return client;}
 }
 const manager=new Fake(),servers={test:{command:'synthetic',scope:{allow:{workerIds:[22]}}}};
 assert.equal((await manager.tools(22,servers)).bindings.size,0);
 manager.registered=true;
 const first=(await manager.tools(22,servers)).bindings.get('mcp__test__write');
 assert.ok(first);await invokeConnector(first,22,{});assert.equal(calls,1);
 const second=(await manager.tools(22,servers)).bindings.get('mcp__test__write');
 assert.ok(second);assert.equal(connectorAllowed(first,22),false);
 await assert.rejects(invokeConnector(first,22,{}),/authorization denied/);assert.equal(calls,1);
 await invokeConnector(second,22,{});assert.equal(calls,2);
 await manager.close();
 await assert.rejects(invokeConnector(second,22,{}),/authorization denied/);assert.equal(calls,2);
});
