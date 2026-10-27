#!/usr/bin/env node
// Local administration and offline source recovery; never expose the admin token.
import fs from 'node:fs';
import path from 'node:path';
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
  const response=await fetch(`http://127.0.0.1:${process.env.PORT||8787}/api/updates${action==='status'&&snapshotId?'?snapshotId='+encodeURIComponent(snapshotId):''}`,{
    method:action==='status'?'GET':'POST',headers:{'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(dataDir,'admin.token'),'utf8').trim()},
    body:action==='status'?undefined:JSON.stringify({action,snapshotId}),signal:AbortSignal.timeout(240000)});
  const result=await response.json();console.log(JSON.stringify(result,null,2));if(!response.ok)process.exitCode=1;
}
