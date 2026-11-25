import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOpenBubblesAdapter,validateConfig,formatText,planOutbound,OpenBubblesFixture} from '../runtime/openbubbles.js';
const c={runId:'run-old',topicId:'topic-old'};
const guid='12345678-1234-1234-1234-123456789abc';
function fixture(t,transport=async()=>({nativeGuid:guid})){
 const dir=mkdtempSync(join(tmpdir(),'nimbus-ob-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const opts={path:join(dir,'fixture.sqlite'),owner:'synthetic-owner',chat:'synthetic-chat',mockOnly:true,transport};
 return {opts,open:()=>new OpenBubblesFixture(opts)};
}
const p={operationId:'op1',kind:'text',chat:'synthetic-chat',text:'hello'};
const event={owner:'synthetic-owner',chat:'synthetic-chat',isFromMe:false,kind:'text',participants:['synthetic-owner'],sequence:1,guid};
test('disabled config rejects activation; adapter cannot call injected effects',()=>{
 let calls=0;const adapter=createOpenBubblesAdapter();assert.equal(adapter.status().state,'disabled');
 assert.throws(()=>adapter.invoke({transport:()=>calls++}),/disabled/);assert.equal(calls,0);
 for(const key of ['enabled','consumeEvents','sendEnabled','autoStart']) assert.throws(()=>validateConfig({[key]:true}),/disabled/);
 assert.throws(()=>validateConfig({credentialRef:'secret'}));
 assert.throws(()=>validateConfig({transport:()=>calls++}));
});
test('UTF8 splitting, effects, native replies and attachment manifests',()=>{
 const text='😀'.repeat(1001);assert.deepEqual(formatText(text).map(s=>Buffer.byteLength(s)),[4000,4]);
 assert.equal(formatText(text).join(''),text);
 assert.throws(()=>planOutbound({...p,replyPartIndex:0}));
 assert.throws(()=>planOutbound({...p,replyToMessageGuid:'task1'}));
 assert.equal(planOutbound({...p,effect:'INVISIBLE_INK'}).effect,'invisible ink');
 assert.throws(()=>planOutbound({...p,effect:'fake'}));
 const files=Array.from({length:4},(_,i)=>({name:i+'.png',mime:'IMAGE/PNG;charset=x',bytes:Buffer.from('abc')}));
 const plan=planOutbound({...p,kind:'attachments',files});
 assert.equal(plan.files.length,4);assert.equal(plan.files[0].mime,'image/png');
 for(const bad of [[],[...files,files[0]],[{...files[0],name:'../a'}],[{...files[0],bytes:Buffer.alloc(0)}],[{...files[0],mime:'unknown/x'}]]) assert.throws(()=>planOutbound({...p,kind:'attachments',files:bad}));
});
test('unauthorized and conflicting inbound never advances; duplicate survives restart',t=>{
 const f=fixture(t);let a=f.open();
 for(const patch of [{owner:'attacker'},{chat:'other'},{isFromMe:true},{participants:['synthetic-owner','third']},{guid:'bad'},{kind:'reaction'},{sequence:2}]){
 assert.throws(()=>a.ingest({...event,...patch},c));assert.equal(a.state.cursor,0);}
 a.ingest(event,c);assert.equal(a.ingest(event,c).duplicate,true);
 assert.throws(()=>a.ingest({...event,text:'changed'},c));a.close();a=f.open();
 assert.equal(a.ingest(event,c).duplicate,true);assert.deepEqual(a.state.inbox[0].correlation,c);a.close();
 assert.throws(()=>new OpenBubblesFixture({...f.opts,owner:'other-owner'}),/binding mismatch/);
});
test('lost response durable uncertainty blocks resend and later lane',async t=>{
 let calls=0;const f=fixture(t,async()=>{calls++;throw Error('lost after effect');});
 let a=f.open();a.prepare(p,c);assert.equal((await a.submit('op1')).state,'uncertain');a.close();
 a=f.open();assert.equal(a.status('op1').state,'uncertain');
 await assert.rejects(a.submit('op1'),/replay/);a.prepare({...p,operationId:'op2'},c);
 await assert.rejects(a.submit('op2'),/review/);assert.equal(calls,1);a.close();
});
test('crash boundary restores dispatching as uncertain, not queued',t=>{
 const f=fixture(t);let a=f.open();a.prepare(p,c);a.state.outbox.op1.state='dispatching';a.save();a.close();
 a=f.open();assert.equal(a.status('op1').state,'uncertain');a.close();
});
test('orphan/out-of-order status remains separate and immutable old-run correlated',async t=>{
 const f=fixture(t);const a=f.open();
 a.receipt({nativeGuid:guid,kind:'read',sequence:2});a.prepare(p,c);await a.submit('op1');
 a.receipt({nativeGuid:guid,kind:'delivered',sequence:1});
 a.receipt({nativeGuid:guid,kind:'read',sequence:2});
 assert.deepEqual(a.status('op1'),{state:'submitted',correlation:c,evidence:['read','delivered']});
 assert.throws(()=>a.prepare(p,{runId:'latest',topicId:'latest'}),/conflict/);
 assert.throws(()=>a.prepare({...p,text:'altered'},c),/conflict/);a.close();
});
test('owned text edits/unsends and read/reaction target checks',()=>{
 const ledger=[{guid,chat:p.chat,ownText:true},{guid:'inbound',chat:p.chat,ownText:false}];
 for(const kind of ['edit','unsend']){assert.doesNotThrow(()=>planOutbound({...p,kind,targetGuid:guid},ledger));assert.throws(()=>planOutbound({...p,kind,targetGuid:'inbound'},ledger));}
 assert.throws(()=>planOutbound({...p,kind:'read',targetGuid:guid},ledger));
 assert.doesNotThrow(()=>planOutbound({...p,kind:'read',targetGuid:'inbound'},ledger));
 for(const reaction of ['love','-love','😀']) assert.doesNotThrow(()=>planOutbound({...p,kind:'reaction',targetGuid:guid,reaction},ledger));
 assert.throws(()=>planOutbound({...p,kind:'reaction',targetGuid:guid,reaction:'-'},ledger));
});
