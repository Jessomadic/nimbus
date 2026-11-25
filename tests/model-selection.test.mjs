import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCloudModel} from '../runtime/model-selection.js';
import {newestCodexRuntime,codexRuntime} from '../runtime/codex-runtime.js';
import {traceWaitingLabel} from '../public/trace-state.js';

const config={cloud:{models:{sol:'auto',terra:'auto',luna:'auto',astra:'auto'}}};
const catalog=models=>({models:models.map(model=>({id:model,model}))});
test('automatic family selection uses numeric versions independent of catalog order',()=>{
  const models=['gpt-5.6-sol','gpt-6-sol','gpt-6.1-sol','gpt-6.1-terra','gpt-6-astra','gpt-5.6-luna','gpt-6-luna'];
  for (const order of [models,[...models].reverse()]) {
    assert.equal(resolveCloudModel('sol',catalog(order),config),'gpt-6.1-sol');
    assert.equal(resolveCloudModel('terra',catalog(order),config),'gpt-6.1-terra');
    assert.equal(resolveCloudModel('luna',catalog(order),config),'gpt-6-luna');
    assert.equal(resolveCloudModel('astra',catalog(order),config),'gpt-6-astra');
  }
  assert.equal(resolveCloudModel('sol',catalog(['gpt-6.9-sol','gpt-6.10-sol','gpt-7-sol-preview']),config),'gpt-6.10-sol');
  assert.equal(resolveCloudModel('sol',catalog(['gpt-6.1-sol-2026-10-27','gpt-6.1-sol']),config),'gpt-6.1-sol');
  assert.equal(resolveCloudModel('sol',{models:[{id:'gpt-8-sol'}]},config),'gpt-8-sol');
});
test('unavailable families fail clearly and intentional model pins remain explicit',()=>{
  assert.throws(()=>resolveCloudModel('sol',catalog(['gpt-6-astra','other-sol']),config),/no sol model/);
  assert.equal(resolveCloudModel('sol',catalog(['gpt-6.1-sol']),{cloud:{models:{sol:'gpt-pinned-sol'}}}),'gpt-pinned-sol');
});
test('automatic runtime selection compares CLI versions and keeps explicit paths',()=>{
  const runtimes=[{bin:'old',version:'codex-cli 0.154.0'},{bin:'new',version:'codex-cli 0.164.0-alpha.11.1'},{bin:'bad',version:'desktop 999.0.0'},{bin:'older-alpha',version:'codex-cli 0.164.0-alpha.9.1'}];
  assert.equal(newestCodexRuntime(runtimes).bin,'new');
  assert.equal(newestCodexRuntime([...runtimes,{bin:'stable',version:'codex-cli 0.164.0'}]).bin,'stable');
  assert.throws(()=>newestCodexRuntime([{bin:'bad',version:'unknown'}]),/No working Codex/);
  assert.equal(codexRuntime('explicit-fixture-path').bin,'explicit-fixture-path');
});
test('delegated work is distinct from user input and actual approval waits, including old traces',()=>{
  const waiting=(tool,waitReason)=>({tool,state:'waiting',...(waitReason?{waitReason}:{})});
  assert.equal(traceWaitingLabel([waiting('worker_result','delegated')]),'Waiting for delegated work');
  assert.equal(traceWaitingLabel([waiting('worker_result')]),'Waiting for delegated work');
  assert.equal(traceWaitingLabel([waiting('request_user_input')]),'Waiting for your answer');
  assert.equal(traceWaitingLabel([waiting('shell')]),'Waiting for your approval');
  assert.equal(traceWaitingLabel([waiting('worker_result','approval')]),'Waiting for your approval');
  assert.equal(traceWaitingLabel([waiting('worker_result','delegated'),waiting('shell','approval')]),'Waiting for your approval');
  assert.equal(traceWaitingLabel([{tool:'worker_result',state:'done'}]),null);
});
