import test from 'node:test';
import assert from 'node:assert/strict';
import {createConnectorCredentialResolver as create} from '../runtime/connector-credentials.js';
const enrollment = {sourceId:'fixture',ownerId:'owner',ownerSid:'S-1-5-21-123',profileId:'profile',server:'fixture-server',workerIds:[2],purpose:'fixture',transportId:'transport',destination:'stdio-env',envKey:'FIXTURE_TOKEN',revision:1,enabled:true};
const request = {ownerId:'owner',profileId:'profile',server:'fixture-server',workerId:2,purpose:'fixture',transportId:'transport',envKey:'FIXTURE_TOKEN',tool:'fixture'};
const ref = {sourceId:'fixture',destination:'stdio-env'};
function fixture(extra={}) {
 let reads=0;
 const r=create({identity:()=>enrollment,authorize:()=>true,backend:{read:async()=>{reads++;return Buffer.alloc(24,65);}},...extra});
 r.replace([enrollment]); return {r,reads:()=>reads};
}
test('private use returns no value and wipes buffer; callback errors sanitized',async()=>{
 const {r}=fixture(); let held;
 assert.equal(await r.use(ref,request,b=>{held=b;assert.equal(b.length,24);return 'not forwarded';}),undefined);
 assert.ok(held.every(n=>n===0));
 await assert.rejects(r.use(ref,request,()=>{throw Error('CANARY');}),/^Error: Protected connector credential unavailable$/);
 r.close();
});
test('unauthorized, malformed, disabled, foreign and missing refs cause zero reads',async()=>{
 const {r,reads}=fixture();
 for(const altered of [{ownerId:'foreign'},{workerId:3},{profileId:'foreign'},{server:'foreign'},{purpose:'foreign'},{envKey:'WRONG'},{transportId:''},{transportId:'different-valid-transport'}])
   await assert.rejects(r.use(ref,{...request,...altered},()=>assert.fail()));
 for(const bad of [{sourceId:'missing',destination:'stdio-env'},{...ref,extra:true},null])
   await assert.rejects(r.use(bad,request,()=>assert.fail()));
 r.replace([{...enrollment,enabled:false}]); await assert.rejects(r.use(ref,request,()=>assert.fail()));
 assert.equal(reads(),0);
});
test('foreign effective SID and unavailable native backend fail closed',async()=>{
 for(const extra of [{identity:()=>({...enrollment,ownerSid:'S-1-5-21-999'})},{backend:undefined}]) {
   const {r,reads}=fixture(extra); await assert.rejects(r.use(ref,request,()=>assert.fail())); assert.equal(reads(),0);
 }
});
test('rotation during resolution rejects late bytes and wipes them',async()=>{
 let finish; const bytes=Buffer.alloc(24,65);
 const {r}=fixture({backend:{read:()=>new Promise(resolve=>{finish=resolve;})}});
 const p=r.use(ref,request,()=>assert.fail()); await new Promise(resolve=>setImmediate(resolve));
 r.replace([{...enrollment,revision:2}]); await assert.rejects(p);
 finish(bytes); await new Promise(resolve=>setImmediate(resolve)); assert.ok(bytes.every(n=>n===0));
});
test('timeout and cancellation reject; late helper bytes are wiped',async()=>{
 for(const cancel of [false,true]) {
  let finish; const bytes=Buffer.alloc(24,65), ac=new AbortController();
  const {r}=fixture({timeoutMs:10,backend:{read:()=>new Promise(resolve=>{finish=resolve;})}});
  const p=r.use(ref,request,()=>assert.fail(),{signal:ac.signal});
  await new Promise(resolve=>setImmediate(resolve)); if(cancel)ac.abort();
  await assert.rejects(p); finish(bytes); await new Promise(resolve=>setImmediate(resolve));
  assert.ok(bytes.every(n=>n===0));
 }
});
test('strict enrollment and printable-byte validation',async()=>{
 for(const extra of [{extra:1},{workerIds:[]},{revision:0},{destination:'adapter-file-reference'},{ownerSid:''}]) {
  const {r}=fixture(); assert.throws(()=>r.replace([{...enrollment,...extra}]));
 }
 for(const bytes of [Buffer.alloc(23,65),Buffer.alloc(65537,65),Buffer.alloc(24,127),Buffer.alloc(24,32),Buffer.alloc(24,0)]) {
  const {r}=fixture({backend:{read:async()=>bytes}});
  await assert.rejects(r.use(ref,request,()=>assert.fail())); assert.ok(bytes.every(n=>n===0));
 }
});
