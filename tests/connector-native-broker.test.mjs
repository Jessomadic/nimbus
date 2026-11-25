import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createWindowsConnectorStore as create} from '../runtime/connector-store-windows.js';
const file=process.env.NIMBUS_SYNTHETIC_BROKER_FIXTURE;
const fixture=file?JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')):null;
const options={skip:!fixture};
function store(approval=fixture.approval,record=fixture.record,hook=()=>{}){
 const events=[];const backend=create({approval,records:[record],diagnostics:e=>{events.push(e);hook(e);}});
 return {backend,events};
}
async function positive(){
 const {backend,events}=store();
 try{const b=await backend.read(fixture.record);
 try{assert.equal(b.toString(),'NIMBUS-SYNTHETIC-NATIVE-ONLY-000001');}finally{b.fill(0);}
 assert.equal(events.filter(e=>e==='EXECUTED').length,1);assert.equal(events.at(-1),'DRAINED');
 }finally{await backend.close();}
}
test('public store -> independent verifier -> real isolated CurrentUser native positive',options,positive);
for(const [name,change] of [
 ['digest',a=>({...a,sha256:'0'.repeat(64)})],
 ['path',a=>({...a,artifact:'F:\\Nimbus\\unsafe.exe'})],
 ['chain',a=>({...a,chain:a.chain+'changed'})],
 ['import closure',a=>({...a,imports:'kernel32.dll'})],
 ['stale revision',a=>({...a,revision:2})]
]){
 test(name+' denies with zero candidate execution',options,async()=>{
  await positive();
  const {backend,events}=store(change(fixture.approval));
  try{await assert.rejects(backend.read(fixture.record),{message:'Protected connector credential unavailable'});
  assert.equal(events.includes('EXECUTED'),false);}finally{await backend.close();}
 });
}
test('missing independent approval never executes candidate',options,async()=>{
 const {backend,events}=store(null);
 await assert.rejects(backend.read(fixture.record));assert.deepEqual(events,[]);await backend.close();
});
test('changed artifact bytes denied before candidate execution',options,async()=>{
 await positive();const p=fixture.approval.artifact;const original=readFileSync(p);
 try{const b=Buffer.from(original);b[b.length-1]^=1;writeFileSync(p,b);
 const {backend,events}=store();
 try{await assert.rejects(backend.read(fixture.record));assert.equal(events.includes('EXECUTED'),false);}finally{await backend.close();}
 }finally{writeFileSync(p,original);}
});
test('abort after actual candidate start drains before rejection',options,async()=>{
 const controller=new AbortController();const {backend,events}=store(fixture.approval,fixture.record,e=>{if(e==='EXECUTED')controller.abort();});
 await assert.rejects(backend.read(fixture.record,{signal:controller.signal}));
 assert.ok(events.includes('EXECUTED'));assert.equal(events.at(-1),'DRAINED');
 await backend.close();await backend.close();
});
test('close after actual start awaits cleanup and denies use after close',options,async()=>{
 let closing;const {backend,events}=store(fixture.approval,fixture.record,e=>{if(e==='EXECUTED')closing=backend.close();});
 await assert.rejects(backend.read(fixture.record));await closing;
 assert.ok(events.includes('EXECUTED'));assert.equal(events.at(-1),'DRAINED');
 await backend.close();await assert.rejects(backend.read(fixture.record));
});

test('abort during verifier startup prevents native execution and drains',options,async()=>{
 const controller=new AbortController();const {backend,events}=store();
 const pending=backend.read(fixture.record,{signal:controller.signal});controller.abort();
 await assert.rejects(pending);assert.equal(events.includes('EXECUTED'),false);
 assert.equal(events.at(-1),'DRAINED');await backend.close();
});
test('artifact exclusive write succeeds after close (held file released)',options,async()=>{
 await positive();const p=fixture.approval.artifact;const b=readFileSync(p);writeFileSync(p,b);
});
