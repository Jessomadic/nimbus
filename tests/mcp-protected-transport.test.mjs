import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {WorkerConnectors,invokeConnector} from '../runtime/mcp.js';
import {transportHash,effectTransportHash,validateMcpScopes} from '../runtime/mcp-scope.js';
import {createConnectorCredentialResolver} from '../runtime/connector-credentials.js';
const secret='SYNTHETIC_CREDENTIAL_123456789';
function fixture(def){
 let reads=0;
 const e={sourceId:'fixture',ownerId:'owner',ownerSid:'S-1-5-21-123',profileId:'profile',server:'fixture',workerIds:[2],purpose:'mcp',transportId:transportHash(def),destination:def.credentialBinding.destination,revision:1,enabled:true,...(def.url?{origin:new URL(def.url).origin}:{envKey:'FIXTURE_TOKEN'})};
 const resolver=createConnectorCredentialResolver({identity:()=>e,authorize:()=>true,backend:{read:async()=>{reads++;return Buffer.from(secret);}}});
 resolver.replace([e]);
 const manager=new WorkerConnectors({credentialResolver:resolver,credentialContext:()=>e});
 return {manager,resolver,e,reads:()=>reads};
}
function authorized(def){
 def.scope={allow:{workerIds:[2]}};
 def.reviewedTools=['echo'];
 // Private credential echo is not approved for read-only replay safety.
 def.reviewedEffects={echo:{effect:'unknown',transportHash:effectTransportHash('fixture',def)}};
 return def;
}
const stdio=()=>authorized({command:process.execPath,args:[fileURLToPath(new URL('./helpers/credential-connector.mjs',import.meta.url))],credentialBinding:{sourceId:'fixture',destination:'stdio-env',envKey:'FIXTURE_TOKEN'}});
test('real stdio private injection, echo redaction, disable and worker denial, rotate/revoke',{timeout:20000},async()=>{
 const def=stdio();def.scope={allow:{groups:['operators']}};
 const f=fixture(def),state={principal:{id:2},mcpScopeGroups:{operators:{workerIds:[2]}},mcpServers:{fixture:def}};
 assert.throws(()=>validateMcpScopes(state),/resolver unavailable/);
 await assert.rejects(new WorkerConnectors().connect(2,'fixture',def),/resolver unavailable/);
 try{
  const found=await f.manager.tools(2,state.mcpServers,()=>state);assert.deepEqual(found.errors,[]);
  const binding=found.bindings.get('mcp__fixture__echo');
  const result=await invokeConnector(binding,2,{});assert.equal(result.content[0].text,'[REDACTED]');
  assert.ok(!JSON.stringify([...f.manager.clients.keys()]).includes(secret));
  const before=f.reads();def.enabled=false;
  assert.equal((await f.manager.tools(2,state.mcpServers,()=>state)).available.length,0);assert.equal(f.reads(),before);
  delete def.enabled;
  await assert.rejects((await f.manager.connect(3,'fixture',def,{mcpScopeGroups:state.mcpScopeGroups})).listTools({}));assert.equal(f.reads(),before);
  f.resolver.replace([{...f.e,revision:2}]);
  assert.equal((await invokeConnector(binding,2,{})).content[0].text,'[REDACTED]');
  f.resolver.replace([]);await assert.rejects(invokeConnector(binding,2,{}));
 }finally{await f.manager.close();f.resolver.close();}
});
test('actual SDK HTTP transport receives private bearer; echo redacted',{timeout:10000},async()=>{
 const def=authorized({url:'https://fixture.invalid/mcp',credentialBinding:{sourceId:'fixture',destination:'http-bearer'}}),f=fixture(def);
 const previous=globalThis.fetch;let received=false;
 globalThis.fetch=async(input,init)=>{
  const headers=new Headers(init?.headers);
  assert.equal(headers.get('authorization'),'Bearer '+secret);received=true;
  const body=JSON.parse(init.body);
  if(body.id===undefined)return new Response(null,{status:202});
  const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:body.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:secret}]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result}),{headers:{'content-type':'application/json'}});
 };
 try{const c=await f.manager.connect(2,'fixture',def);const r=await c.callTool({name:'echo',arguments:{}});assert.equal(r.content[0].text,'[REDACTED]');assert.equal(received,true);}
 finally{globalThis.fetch=previous;await f.manager.close();f.resolver.close();}
});
