import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyEdits, inspectImage, imageData, retainedImages, listSkills } from '../runtime/workbench.js';
import { Terminals } from '../runtime/terminals.js';
import { requiresApproval } from '../runtime/policy.js';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-workbench-test-'));t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-workbench-test-/);fs.rmSync(root,{recursive:true,force:true});});return root;}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('exact patches reject stale and ambiguous context before modifying any file',t=>{
  const root=fixture(t);fs.writeFileSync(path.join(root,'a.txt'),'alpha\nbeta\nalpha\n');
  assert.throws(()=>applyEdits([{operation:'add',path:'new.txt',newText:'new'},{operation:'update',path:'a.txt',oldText:'alpha',newText:'changed'}],root),/exactly once/);
  assert.equal(fs.existsSync(path.join(root,'new.txt')),false);
  applyEdits([{operation:'update',path:'a.txt',oldText:'beta',newText:'updated'}],root);
  assert.equal(fs.readFileSync(path.join(root,'a.txt'),'utf8'),'alpha\nupdated\nalpha\n');
  assert.throws(()=>applyEdits([{operation:'delete',path:'a.txt',oldText:'wrong'}],root),/complete current file/);
});
test('image pixels are retained by hash and stale image substitution is refused',t=>{
  const root=fixture(t),file=path.join(root,'pixel.png');
  fs.writeFileSync(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=','base64'));
  const result=inspectImage(file);assert.equal(result.image.mimeType,'image/png');assert.match(imageData(result),/^data:image\/png;base64,/);
  assert.equal(retainedImages([{role:'tool',content:JSON.stringify(result)}])[0].image.sha256,result.image.sha256);
  fs.appendFileSync(file,'changed');assert.throws(()=>imageData(result),/changed/);
  fs.writeFileSync(file,'not an image');assert.throws(()=>inspectImage(file),/Unsupported/);
});
test('skills discovery returns real instruction paths without treating other files as skills',t=>{
  const root=fixture(t);fs.mkdirSync(path.join(root,'real'));fs.mkdirSync(path.join(root,'empty'));
  fs.writeFileSync(path.join(root,'real','SKILL.md'),'---\nname: real\ndescription: Read actual instructions\n---\n# Steps\n');
  const result=listSkills([root]);assert.equal(result.skills.length,1);assert.equal(result.skills[0].description,'Read actual instructions');assert.equal(result.skills[0].path,path.join(root,'real','SKILL.md'));
});
test('new terminal operations honor existing shell approval patterns',()=>{
  const bot={approval_rules:['shell(*git push*)'],allow_rules:[]};
  assert.equal(requiresApproval(bot,'exec_command',{command:'git push origin main'}),true);
  assert.equal(requiresApproval(bot,'write_stdin',{chars:'git push origin main\n'}),true);
  assert.equal(requiresApproval(bot,'write_stdin',{sessionId:'x'}),false);
});
test('terminal sessions return ongoing work, capture its exit and survive a host-object restart as evidence',async t=>{
  const root=fixture(t),manager=new Terminals(root);t.after(()=>manager.close());
  const command=process.platform==='win32'?"Write-Output 'START'; Start-Sleep -Milliseconds 800; Write-Output 'FINISHED'":"printf 'START\\n'; sleep 0.8; printf 'FINISHED\\n'";
  let result=await manager.execute(1,{command,yieldMs:0},{cwd:root});assert.equal(result.status,'running');
  assert.equal(manager.active().length,1);
  assert.throws(()=>manager.read(2,{sessionId:result.sessionId}),/another worker/);
  const until=Date.now()+10000;while(result.status==='running'&&Date.now()<until){await sleep(100);result=await manager.write(1,{sessionId:result.sessionId,yieldMs:100});}
  assert.equal(result.status,'done');assert.equal(result.exitCode,0);assert.match(result.output,/FINISHED/);
  assert.equal(manager.active().length,0);
  const reloaded=new Terminals(root).read(1,{sessionId:result.sessionId});assert.equal(reloaded.status,'done');assert.match(reloaded.output,/START/);
  assert.equal(manager.read(1,{sessionId:result.sessionId,offset:result.nextOffset}).output,'');
});
test('terminal input and graceful host shutdown retain interrupted process evidence',async t=>{
  const root=fixture(t),manager=new Terminals(root);t.after(()=>manager.close());
  const result=await manager.execute(1,{command:process.platform==='win32'?"$value=[Console]::ReadLine(); Write-Output $value; Start-Sleep -Seconds 30":"read value; echo \"$value\"; sleep 30",yieldMs:0},{cwd:root});
  const echo=await manager.write(1,{sessionId:result.sessionId,chars:'INPUT_OK\n',yieldMs:500});assert.match(echo.output,/INPUT_OK/);
  const unknown=new Terminals(root).read(1,{sessionId:result.sessionId});assert.equal(unknown.status,'unknown_after_restart');
  await manager.close();const stopped=manager.read(1,{sessionId:result.sessionId});assert.equal(stopped.status,'interrupted');assert.ok(stopped.endedAt);
});
