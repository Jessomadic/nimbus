import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPersistedWindowsConnectorHost as create} from '../runtime/connector-host-windows.js';
import {readApprovalMapping} from '../runtime/connector-approval-registry.js';
import {transportHash} from '../runtime/mcp-scope.js';
test('persisted native factory remains disabled without explicit enrollment',async()=>{
 const h=await create({directory:'not-an-enrolled-directory'});
 await h.close();
});
const directory=process.env.NIMBUS_SYNTHETIC_REGISTRY_DIRECTORY;
test('persisted native -> host -> actual SDK synthetic positive, policy and revoke',{skip:!directory},async()=>{
 const m=readApprovalMapping(directory),r=m.records[0];
 const definition={url:'https://fixture.invalid/mcp',scope:{allow:{workerIds:[2]}},reviewedTools:['echo'],credentialBinding:{sourceId:r.sourceId,destination:'http-bearer'}};
 const entry={sourceId:r.sourceId,ownerId:'synthetic-owner',profileId:'logical-profile',ownerSid:r.ownerSid,server:'fixture',workerIds:[2],purpose:'mcp',transportId:transportHash(definition),destination:'http-bearer',origin:'https://fixture.invalid',revision:r.revision,enabled:true};
 let allowed=true,requests=0;const events=[];
 for(const bad of [{...entry,revision:r.revision+1},{...entry,ownerSid:'S-1-5-18'},{...entry,sourceId:'not-enrolled'}])
  await assert.rejects(create({directory,enrollment:[bad],identity:()=>entry,authorize:()=>true}),/Protected connector/);
 const h=await create({directory,enrollment:[entry],identity:()=>entry,authorize:q=>allowed&&q.tool==='echo',diagnostics:e=>events.push(e)});
 const previous=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  requests++;assert.equal(new Headers(init.headers).get('authorization'),'Bearer NIMBUS-SYNTHETIC-NATIVE-ONLY-000001');
  const b=JSON.parse(init.body);
  if(b.id===undefined)return new Response(null,{status:202});
  return new Response(JSON.stringify({jsonrpc:'2.0',id:b.id,result:b.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{content:[{type:'text',text:'ok'}]}}),{headers:{'content-type':'application/json'}});
 };
 try {
  const c=await h.connectors.connect(2,'fixture',definition);
  assert.equal((await c.callTool({name:'echo',arguments:{}})).content[0].text,'ok');
  assert.equal(events.filter(e=>e==='EXECUTED').length,1);assert.equal(events.at(-1),'DRAINED');assert.ok(requests>0);
  const count=requests;
  allowed=false;await assert.rejects(c.callTool({name:'echo',arguments:{}}));assert.equal(requests,count);
  allowed=true;await h.revoke();await assert.rejects(c.callTool({name:'echo',arguments:{}}));assert.equal(requests,count);
 }finally{globalThis.fetch=previous;await h.close();await h.close();}
});
