import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
process.env.NIMBUS_CONFIG=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'toggle-dispatch-')),'config.json');
const {config,saveConfig}=await import('../runtime/config.js');
const {localChat}=await import('../runtime/local.js');
const {localSlots}=await import('../runtime/slots.js');
test('stale task configuration cannot dispatch after persisted disable',async()=>{
  const c=config();assert.equal(c.local.enabled,true);
  saveConfig({local:{enabled:false}});
  let guards=0;
  await assert.rejects(localChat([],{c,guard:()=>{guards++;throw Error('provider boundary');}}),/disabled/);
  assert.equal(guards,0);
});
test('queued inference rechecks persisted toggle after slot acquisition',async()=>{
  saveConfig({local:{enabled:true}});const c=config();
  const release=await localSlots.acquire();
  let guards=0;
  const pending=localChat([],{c,guard:()=>{guards++;throw Error('provider boundary');}});
  const checked=assert.rejects(pending,/disabled/);
  assert.equal(localSlots.snapshot().queued,1);
  saveConfig({local:{enabled:false}});release();
  await checked;assert.equal(guards,0);assert.equal(localSlots.snapshot().active,0);
});
test('disable during resource admission prevents provider access; enabling restores eligibility',async()=>{
  saveConfig({local:{enabled:true}});
  await assert.rejects(localChat([],{guard:()=>saveConfig({local:{enabled:false}})}),/disabled/);
  saveConfig({local:{enabled:true}});
  await assert.rejects(localChat([],{guard:()=>{throw Error('admitted without provider');}}),/admitted without provider/);
});
