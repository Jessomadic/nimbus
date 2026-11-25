import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorHost} from '../runtime/connector-host.js';
import {transportHash} from '../runtime/mcp-scope.js';
const definition={url:'https://fixture.invalid/mcp',scope:{allow:{workerIds:[2]}},reviewedTools:['echo'],credentialBinding:{sourceId:'fixture',destination:'http-bearer'}};
const entry={sourceId:'fixture',ownerId:'owner',profileId:'profile',ownerSid:'S-1-5-21-123',server:'fixture',workerIds:[2],purpose:'mcp',transportId:transportHash(definition),destination:'http-bearer',origin:'https://fixture.invalid',revision:1,enabled:true};
test('missing enrollment denies protected read without invoking supplied backend',async()=>{
 let reads=0;
 const h=createConnectorHost({backend:{read(){reads++;throw Error();}}});
 try {const c=await h.connectors.connect(2,'fixture',definition);await assert.rejects(c.listTools({}));assert.equal(reads,0);}
 finally{await h.close();}
});
test('invalid enrollment dependencies fail before backend use',()=>{
 assert.throws(()=>createConnectorHost({enrollment:[entry]}));
});
test('host composition uses actual SDK; current policy and revocation gate every read',async()=>{
 let reads=0,allowed=true,held;
 const h=createConnectorHost({enrollment:[entry],identity:()=>entry,authorize:r=>allowed&&r.tool==='echo',backend:{async read(){reads++;held=Buffer.alloc(32,65);return held;}}});
 const previous=globalThis.fetch;
 globalThis.fetch=async(input,init)=>{
  assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+ 'A'.repeat(32));
  const b=JSON.parse(init.body);
  if(b.id===undefined)return new Response(null,{status:202});
  return new Response(JSON.stringify({jsonrpc:'2.0',id:b.id,result:b.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{content:[{type:'text',text:'ok'}]}}),{headers:{'content-type':'application/json'}});
 };
 try{
  const c=await h.connectors.connect(2,'fixture',definition);
  assert.equal((await c.callTool({name:'echo',arguments:{}})).content[0].text,'ok');
  assert.equal(reads,1);assert.ok(held.every(v=>v===0));
  allowed=false;await assert.rejects(c.callTool({name:'echo',arguments:{}}));assert.equal(reads,1);
  allowed=true;await h.revoke();await assert.rejects(c.callTool({name:'echo',arguments:{}}));assert.equal(reads,1);
 }finally{globalThis.fetch=previous;await h.close();await h.close();}
});
test('cancellation revokes in-flight fixture work and wipes late bytes',async()=>{
 let complete, observedSignal;
 const late=Buffer.alloc(32,65);
 const h=createConnectorHost({enrollment:[entry],identity:()=>entry,authorize:()=>true,backend:{read(e,{signal}){observedSignal=signal;return new Promise(resolve=>{complete=resolve;});}}});
 try{
  const c=await h.connectors.connect(2,'fixture',definition);
  const abort=new AbortController();
  const operation=c.callTool({name:'echo',arguments:{}},undefined,{signal:abort.signal});
  await new Promise(resolve=>setImmediate(resolve));
  abort.abort();
  await assert.rejects(operation);
  assert.equal(observedSignal.aborted,true);
  complete(late);
  await new Promise(resolve=>setImmediate(resolve));
  assert.ok(late.every(v=>v===0));
 }finally{await h.close();}
});
test('truthy async host authorization is not approval',async()=>{
 let reads=0;
 const h=createConnectorHost({enrollment:[entry],identity:()=>entry,authorize:()=>Promise.resolve(true),backend:{read(){reads++;}}});
 try{const c=await h.connectors.connect(2,'fixture',definition);await assert.rejects(c.callTool({name:'echo',arguments:{}}));assert.equal(reads,0);}
 finally{await h.close();}
});

test('rejecting synchronous capabilities deny and survive strict rejection policy',async()=>{
 const {spawnSync}=await import('node:child_process');
 const moduleUrl=new URL('../runtime/connector-host.js',import.meta.url).href;
 for(const mode of ['authorize','identity','context','thenable','throw','identity-thenable','identity-getter','identity-throw']){
  const script=`
   import {createConnectorHost} from ${JSON.stringify(moduleUrl)};
   const entry=${JSON.stringify(entry)}, definition=${JSON.stringify(definition)};
   let reads=0,identities=0;
   const reject=()=>Promise.reject(Error('SYNTHETIC_POLICY_FAILURE'));
   const badIdentity=()=>{
    if(mode==='identity-thenable')return {then(resolve,reject){reject(Error('SYNTHETIC'));}};
    if(mode==='identity-getter')return Object.defineProperty({},'then',{get(){throw Error('SYNTHETIC');}});
    if(mode==='identity-throw')throw Error('SYNTHETIC');
    return reject();
   };
   const h=createConnectorHost({enrollment:[entry],identity:mode.startsWith('identity')?badIdentity:mode==='context'?()=>++identities===1?entry:reject():()=>entry,
    authorize:mode==='thenable'?()=>({then(resolve,reject){reject(Error('SYNTHETIC'));}}):mode==='throw'?()=>{throw Error('SYNTHETIC');}:reject,
    backend:{read(){reads++;throw Error('READ');}}});
   try { const c=await h.connectors.connect(2,'fixture',definition);await c.callTool({name:'echo',arguments:{}});process.exitCode=2; }catch(e){if(e.message!=='Protected connector credential unavailable')throw e;}
   await h.close();await new Promise(r=>setImmediate(r));
   if(reads)process.exitCode=3;
   console.log('SURVIVED');
  `;
  const result=spawnSync(process.execPath,['--unhandled-rejections=strict','--input-type=module','-e', 'const mode='+JSON.stringify(mode)+';'+script],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SURVIVED/);
 }
});
test('host close awaits backend finalization exactly once',async()=>{
 let closes=0,release;
 const h=createConnectorHost({enrollment:[entry],identity:()=>entry,authorize:()=>true,
 backend:{read(){throw Error();},close(){closes++;return new Promise(r=>{release=r;});}}});
 const first=h.close();const second=h.close();
 await new Promise(r=>setImmediate(r));assert.equal(closes,1);
 let done=false;first.then(()=>{done=true;});await new Promise(r=>setImmediate(r));assert.equal(done,false);
 release();await Promise.all([first,second]);assert.equal(closes,1);
});
