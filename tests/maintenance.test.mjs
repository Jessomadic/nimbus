import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Maintenance } from '../runtime/maintenance.js';
import { capture } from '../runtime/process.js';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-update-test-'));
  const write=(file,value)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),value);};
  write('server.js','export const version = 1;\n');
  write('package.json','{"type":"module"}');
  write('tests/smoke.test.mjs',"import test from 'node:test'; import assert from 'node:assert/strict'; import {version} from '../server.js'; test('real fixture behavior',()=>assert.ok(version > 0));");
  write('.env','PRIVATE=secret');write('nimbus.config.json','{"secret":true}');write('data/keep.txt','worker state');
  write('node_modules/keep.txt','dependency');write('.git/keep.txt','git metadata');
  const manager=new Maintenance({root,dataDir:path.join(root,'data')});
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-update-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return {root,write,manager};
}
test('update snapshot preserves current dirty source and excludes state, secrets and dependencies',t=>{
  const {root,manager}=fixture(t),snapshot=manager.snapshot();
  assert.deepEqual(Object.keys(snapshot.baseline.files).sort(),['package.json','server.js','tests/smoke.test.mjs']);
  assert.equal(fs.readFileSync(path.join(manager.dir,snapshot.id,'source/server.js'),'utf8'),'export const version = 1;\n');
  assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'PRIVATE=secret');
  assert.throws(()=>manager.load('../escape'),/snapshotId/);
});
test('validation executes behavior tests and rejects a syntactically valid regression',async t=>{
  const {manager,write}=fixture(t),snapshot=manager.snapshot();
  write('server.js','export const version = -1;');
  await assert.rejects(manager.validate(snapshot.id),/failed/);
  assert.equal(manager.load(snapshot.id).state,'validation_failed');
  assert.throws(()=>manager.apply(snapshot.id),/Validate/);
});
test('syntax failure and source drift cannot be applied',async t=>{
  const {manager,write}=fixture(t),snapshot=manager.snapshot();
  write('server.js','export const version = ;');
  await assert.rejects(manager.validate(snapshot.id),/failed/);
  write('server.js','export const version = 2;');
  const validated=await manager.validate(snapshot.id);assert.equal(validated.state,'validated');
  write('server.js','export const version = 3;');
  assert.throws(()=>manager.apply(snapshot.id),/Validate/);
});
test('supervised apply remains pending until a different process confirms the matching boot',async t=>{
  const {manager,write}=fixture(t),snapshot=manager.snapshot();
  write('server.js','export const version = 2;');await manager.validate(snapshot.id);
  assert.throws(()=>manager.apply(snapshot.id),/supervisor/);
  let scheduled=0;manager.supervised=()=>true;manager.requestRestart=()=>scheduled++;
  assert.equal(manager.apply(snapshot.id).state,'restart_pending');assert.equal(scheduled,1);
  assert.throws(()=>manager.apply(snapshot.id),/in progress/);
  manager.confirmBoot(manager.inventory().hash);assert.equal(manager.load(snapshot.id).state,'restart_pending');
  const pending=manager.pending();pending.oldPid=-1;fs.writeFileSync(path.join(manager.dir,'pending.json'),JSON.stringify(pending));
  manager.confirmBoot(manager.inventory().hash);
  assert.equal(manager.load(snapshot.id).state,'applied');assert.equal(manager.pending(),null);
});
test('an edit after scheduling cancels update verification without changing source',async t=>{
  const {manager,write}=fixture(t),snapshot=manager.snapshot();await manager.validate(snapshot.id);
  manager.supervised=()=>true;manager.requestRestart=()=>{};manager.apply(snapshot.id);
  write('server.js','export const version = 4;');
  assert.throws(()=>manager.assertPendingSource(),/Source changed/);
  manager.failPending('Source changed');assert.equal(manager.load(snapshot.id).state,'restart_failed');
  assert.equal(manager.pending(),null);
});
test('source recovery preserves the failed candidate, runtime data and credentials',async t=>{
  const {root,manager,write}=fixture(t),snapshot=manager.snapshot();
  write('server.js','export const version = 2;');write('runtime/added.js','export const added = true;');
  await manager.validate(snapshot.id);
  const recovered=manager.restore(snapshot.id);
  assert.equal(manager.inventory().hash,snapshot.baseline.hash);
  assert.equal(fs.existsSync(path.join(root,'runtime/added.js')),false);
  assert.equal(fs.readFileSync(path.join(manager.dir,recovered.recoverySnapshotId,'source/runtime/added.js'),'utf8'),'export const added = true;');
  assert.equal(fs.readFileSync(path.join(root,'data/keep.txt'),'utf8'),'worker state');
  assert.equal(fs.readFileSync(path.join(root,'.env'),'utf8'),'PRIVATE=secret');
});
test('recovery refuses newer edits and detects corrupted baseline before any source write',async t=>{
  const {root,manager,write}=fixture(t),snapshot=manager.snapshot();
  write('server.js','export const version = 2;');await manager.validate(snapshot.id);
  write('server.js','export const version = 3;');assert.throws(()=>manager.restore(snapshot.id),/newer edits/);
  write('server.js','export const version = 2;');
  fs.writeFileSync(path.join(manager.dir,snapshot.id,'source/server.js'),'corrupt');
  assert.throws(()=>manager.restore(snapshot.id),/Corrupt snapshot/);
  assert.equal(fs.readFileSync(path.join(root,'server.js'),'utf8'),'export const version = 2;');
});
test('frozen recovery works when candidate maintenance source and root package are broken',async t=>{
  const {root,manager,write}=fixture(t),snapshot=manager.snapshot();
  write('runtime/maintenance.js','syntax error !');write('package.json','{broken');
  await assert.rejects(manager.validate(snapshot.id));
  const output=await capture(process.execPath,[snapshot.recoveryScript],{cwd:root});
  assert.equal(JSON.parse(output).state,'source_restored');
  assert.equal(manager.inventory().hash,snapshot.baseline.hash);
});
