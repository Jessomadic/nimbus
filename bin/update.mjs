#!/usr/bin/env node
// Local administration and offline source recovery; never expose the admin token.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT } from '../runtime/config.js';
import { Maintenance } from '../runtime/maintenance.js';
const dataDir=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
const [action='status',snapshotId]=process.argv.slice(2);
if(action==='restore'){
  for(const name of ['supervisor.lock','server.pid']){
    const file=path.join(dataDir,name);if(!fs.existsSync(file))continue;
    const value=fs.readFileSync(file,'utf8'),pid=name.endsWith('.lock')?JSON.parse(value).pid:Number(value);
    let alive=false;try{process.kill(pid,0);alive=true;}catch(error){if(error.code==='EPERM')alive=true;}
    if(alive)throw new Error('Stop Nimbus before offline source recovery');
  }
  const manager=new Maintenance({root:ROOT,dataDir});
  manager.failPending('Update stopped for offline source recovery');
  console.log(JSON.stringify(manager.restore(snapshotId),null,2));
}else{
  if(!['status','snapshot','validate','apply'].includes(action))throw new Error('Choose status, snapshot, validate, apply or restore');
  // Validation can exceed fetch/Undici's five-minute header timeout. Make one
  // bounded local request; a transport failure must never resubmit the action.
  const payload=action==='status'?undefined:JSON.stringify({action,snapshotId});
  const response=await new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port:Number(process.env.PORT||8787),
      path:'/api/updates'+(action==='status'&&snapshotId?'?snapshotId='+encodeURIComponent(snapshotId):''),
      method:action==='status'?'GET':'POST',headers:{'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(dataDir,'admin.token'),'utf8').trim(),...(payload?{'content-length':Buffer.byteLength(payload)}:{})}},res=>{
      let text='';res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;if(text.length>4*1024*1024)request.destroy(new Error('Update response exceeded limit; inspect the saved receipt before retrying'));});res.on('error',reject);
      res.on('end',()=>{try{resolve({ok:res.statusCode>=200&&res.statusCode<300,result:JSON.parse(text)});}catch{reject(new Error('Invalid update response; inspect the saved receipt before retrying'));}});
    });
    const deadline=setTimeout(()=>request.destroy(new Error('Update request deadline exceeded; inspect the saved receipt before retrying')),660000);
    deadline.unref();request.once('close',()=>clearTimeout(deadline));
    request.setTimeout(660000,()=>request.destroy(new Error('Update request timed out; inspect the saved receipt before retrying')));
    request.on('error',reject);request.end(payload);
  });
  console.log(JSON.stringify(response.result,null,2));if(!response.ok)process.exitCode=1;
}
