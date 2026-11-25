import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

for(const status of [200,409])test('update CLI preserves a single delayed authenticated request and HTTP '+status,async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-update-client-'));fs.writeFileSync(path.join(root,'admin.token'),'fixture-admin-only');
  const preload=path.join(root,'no-fetch.mjs');fs.writeFileSync(preload,"globalThis.fetch=()=>{throw Error('fetch header-timeout path must not be used')};");
  const requests=[];const server=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{requests.push({method:req.method,body:JSON.parse(body),admin:req.headers['x-nimbus-admin']});setTimeout(()=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify({state:status===200?'validated':'validation_failed'}));},80);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try{
    const child=spawn(process.execPath,['--no-warnings','--import',pathToFileURL(preload).href,fileURLToPath(new URL('../bin/update.mjs',import.meta.url)),'validate','fixture-snapshot'],{env:{...process.env,PORT:String(server.address().port),NIMBUS_DATA:root},windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);const code=await new Promise((r,j)=>{child.on('error',j);child.on('close',r);});
    assert.equal(code,status===200?0:1,err);assert.equal(JSON.parse(out).state,status===200?'validated':'validation_failed');
    assert.deepEqual(requests,[{method:'POST',body:{action:'validate',snapshotId:'fixture-snapshot'},admin:'fixture-admin-only'}]);
  }finally{await new Promise(r=>server.close(r));assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});}
});
