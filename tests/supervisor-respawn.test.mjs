import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

// A stub "server" that records each start and exits with the given code.
function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-supervisor-'));
  const stub=path.join(dir,'stub-server.mjs');
  fs.writeFileSync(stub,`import fs from 'node:fs';const f=${JSON.stringify(path.join(dir,'starts.txt'))};fs.appendFileSync(f,'x');
const n=fs.readFileSync(f,'utf8').length;
if(n>=3)fs.writeFileSync(${JSON.stringify(path.join(dir,'stop.request'))},'stop');
process.exit(0);`);
  return {dir,stub,starts:()=>{try{return fs.readFileSync(path.join(dir,'starts.txt'),'utf8').length;}catch{return 0;}}};
}
const run=(f,extra={})=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--no-warnings',path.join(ROOT,'scripts','supervisor.mjs')],{cwd:ROOT,env:{...process.env,NIMBUS_DATA:f.dir,NIMBUS_SERVER_SCRIPT:f.stub,...extra},windowsHide:true});
  const timer=setTimeout(()=>{child.kill();reject(new Error('supervisor did not exit'));},20000);
  child.on('close',code=>{clearTimeout(timer);resolve(code);});
});

test('a clean exit 0 is respawned until an explicit stop request',async()=>{
  const f=fixture();
  assert.equal(await run(f),0);
  assert.equal(f.starts(),3,'exit 0 twice was respawned, the third start wrote stop.request');
  assert.ok(!fs.existsSync(path.join(f.dir,'supervisor.lock')),'lock is removed on exit');
});

test('an existing stop request ends supervision after the current server exits',async()=>{
  const f=fixture();fs.writeFileSync(path.join(f.dir,'stop.request'),'stop');
  assert.equal(await run(f),0);
  assert.equal(f.starts(),1);
});
