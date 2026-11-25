import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';

const previous={data:process.env.NIMBUS_DATA,config:process.env.NIMBUS_CONFIG};
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-provider-liveness-'));
process.env.NIMBUS_DATA=path.join(directory,'data');
process.env.NIMBUS_CONFIG=path.join(directory,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{maxConcurrent:1},local:{enabled:false}}));
const {codexTurn}=await import('../runtime/codex.js');
const {cloudSlots}=await import('../runtime/slots.js');
const {journalTool}=await import('../runtime/journal.js');
const {db,q}=await import('../db.js');
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
const definition={type:'function',function:{name:'fixture',description:'Isolated host callback',parameters:{type:'object',properties:{}}}};
let failed=false;
function observe(t){t.after(()=>{if(t.passed===false)failed=true;});}
async function setup({execute=async()=>({ok:true}),startGate}={}){
  let now=0,timerId=0;const timers=new Map(),events=[],calls=[];
  const clock={now:()=>now,set:(fn,ms)=>{timers.set(++timerId,{fn,at:now+ms});return timerId;},clear:id=>timers.delete(id)};
  const bot=Number(q("INSERT INTO bots(name) VALUES('Isolated liveness fixture')").run().lastInsertRowid);
  const run=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'running','api')").run(bot,'bot:'+bot,'Isolated liveness fixture').lastInsertRowid);
  class Client extends EventEmitter{
    closed=false;requests=[];sent=[];
    async initialize(){}
    async request(method,params){
      this.requests.push({method,params});
      if(method==='account/read')return{account:{type:'chatgpt'}};
      if(method==='thread/start')return{thread:{id:'fixture-thread',ephemeral:true}};
      if(method==='turn/start'){if(startGate)await startGate.promise;return{turn:{id:'fixture-turn'}};}
      if(method==='turn/interrupt')return{};
      throw Error('Unexpected fixture RPC '+method);
    }
    send(value){this.sent.push(value);}
    close(){this.closed=true;}
  }
  const client=new Client(),controller=new AbortController();let outcome;
  const promise=codexTurn({model:'fixture',instructions:'Isolated deterministic fixture',messages:[],tools:[definition],cwd:directory,
    signal:controller.signal,clientFactory:()=>client,silenceClock:clock,
    onEvent:(name,data)=>events.push({name,data}),
    callTool:(name,args,id)=>journalTool({id,runId:run,name,args,signal:controller.signal,execute:async()=>{calls.push(id);return execute(id);}})
  }).then(value=>{outcome=value;return value;},error=>{outcome=error;return error;});
  await flush();
  const emit=(method,params={},id)=>client.emit('message',{method,params,...(id==null?{}:{id})});
  return{client,controller,events,calls,promise,run,timers,emit,get outcome(){return outcome;},
    tick:async ms=>{now+=ms;for(const [id,timer]of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}await flush();},
    tool:id=>emit('item/tool/call',{tool:'nimbus.fixture',callId:String(id),arguments:{}},id),
    finish:async()=>{emit('turn/completed',{turn:{status:'completed'}});await promise;},
    interrupted:()=>client.requests.some(r=>r.method==='turn/interrupt'),
    journals:()=>q('SELECT id,state,result FROM tool_calls WHERE run_id=? ORDER BY id').all(run)
  };
}

test('two queued host callbacks stay exempt; subsequent silence preserves both real journal outcomes',async t=>{
  observe(t);const pending=[];
  const h=await setup({execute:()=>{const d=deferred();pending.push(d);return d.promise;}});
  h.tool(1);await flush();h.tool(2);await flush();pending[0].resolve({receipt:'first'});await flush();
  assert.equal(h.calls.length,2);
  await h.tick(1800000);const wronglyInterrupted=h.interrupted();
  pending[1].resolve({receipt:'second'});await flush();
  await h.tick(600000);const result=await h.promise;
  assert.equal(wronglyInterrupted,false);
  assert.equal(result.code,'provider_inference_silence');
  assert.equal(result.pause,true);
  assert.deepEqual(h.journals().map(row=>row.state),['done','done']);
  assert.deepEqual(h.journals().map(row=>JSON.parse(row.result).receipt),['first','second']);
  assert.equal(h.calls.length,2);assert.equal(h.timers.size,0);
  assert.equal(cloudSlots.snapshot().active,0);
});

test('meaningful stream progress survives indefinitely and emits bounded metadata; replay and empty input expire',async t=>{
  observe(t);const h=await setup();
  for(let i=0;i<80;i++){await h.tick(590000);h.emit('item/reasoning/textDelta',{itemId:'private-id',delta:'private-content',sequence:i});}
  assert.equal(h.outcome,undefined);assert.equal(h.interrupted(),false);
  for(let i=80;i<180;i++){await h.tick(1000);h.emit('item/reasoning/textDelta',{itemId:'private-id',delta:'private-content',sequence:i});}
  const progress=h.events.filter(e=>e.name==='provider_activity'&&e.data.kind==='meaningful_inbound');
  assert.equal(progress.length,83);assert.doesNotMatch(JSON.stringify(progress),/private-content|private-id/);
  await h.tick(500000);h.emit('item/reasoning/textDelta',{itemId:'private-id',delta:'private-content',sequence:179});
  h.emit('item/reasoning/textDelta',{});h.emit('item/agentMessage/delta',{delta:' '});h.emit('thread/tokenUsage/updated',{});
  await h.tick(100000);assert.equal((await h.promise).code,'provider_inference_silence');
  assert.equal(h.timers.size,0);
});

test('real cloud-capacity wait is exempt and cancellation drains the callback without leaking a slot',async t=>{
  observe(t);let releaseOther;
  const h=await setup({execute:async()=>{releaseOther=await cloudSlots.acquire();return{receipt:'capacity-wait'};}});
  h.tool(1);await flush();assert.equal(cloudSlots.snapshot().queued,1);
  await h.tick(3600000);assert.equal(h.interrupted(),false);assert.equal(h.outcome,undefined);
  h.controller.abort(new Error('Fixture cancellation'));await h.promise;releaseOther();
  assert.deepEqual(h.journals().map(row=>row.state),['done']);
  assert.equal(cloudSlots.snapshot().active,0);assert.equal(cloudSlots.snapshot().queued,0);
  assert.equal(h.timers.size,0);
});

test('silence during pending turn-start interrupts the returned turn and admits no late host callback',async t=>{
  observe(t);const gate=deferred(),h=await setup({startGate:gate});
  await h.tick(600000);h.tool(1);gate.resolve();
  const result=await h.promise;assert.equal(result.code,'provider_inference_silence');
  assert.equal(h.interrupted(),true);assert.equal(h.calls.length,0);assert.equal(h.journals().length,0);
  assert.ok(h.client.sent.some(value=>value.id===1&&value.error));assert.equal(h.timers.size,0);
});

test('provider completion drains an executing callback and rejects queued actions after completion',async t=>{
  observe(t);const gate=deferred(),h=await setup({execute:()=>gate.promise});
  h.tool(1);await flush();h.tool(2);h.emit('turn/completed',{turn:{status:'completed'}});h.tool(3);
  await h.tick(1800000);assert.equal(h.interrupted(),false);assert.equal(h.client.closed,false);
  gate.resolve({receipt:'retained'});const result=await h.promise;
  assert.equal(h.calls.length,1);assert.deepEqual(h.journals().map(row=>row.state),['done']);
  assert.equal(result.unconsumedToolResults.length,1);assert.equal(h.client.closed,true);assert.equal(h.timers.size,0);
  assert.ok(h.client.sent.some(value=>value.id===2&&value.error));assert.ok(h.client.sent.some(value=>value.id===3&&value.error));
});

test.after(()=>{
  db.close();
  for(const [key,value]of [['NIMBUS_DATA',previous.data],['NIMBUS_CONFIG',previous.config]]){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  const resolved=path.resolve(directory),parent=path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved),parent);assert.ok(path.basename(resolved).startsWith('nimbus-provider-liveness-'));
  if(!failed)fs.rmSync(resolved,{recursive:true,force:true});else console.error('Retained fixture '+resolved);
});
