#!/usr/bin/env node
// Runs a separate Nimbus process and real local inference, preserving all receipts.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ROOT} from '../runtime/config.js';
const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data','restart-check'));
const port=Number(process.env.PORT||18989),base=`http://127.0.0.1:${port}`;
fs.mkdirSync(data,{recursive:true});fs.mkdirSync(path.join(data,'verification'),{recursive:true});
const file=path.join(data,'verification',`restart-${Date.now()}.json`),receipt={checks:[]};
const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+180000;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(100);}throw new Error('Restart verification deadline exceeded');}
let child,exited;
function start(){
  child=spawn(process.execPath,['--no-warnings',path.join(ROOT,'server.js')],{cwd:ROOT,windowsHide:true,
    env:{...process.env,NIMBUS_DATA:data,PORT:String(port),HOST:'127.0.0.1',NIMBUS_ALLOW_NO_PASSWORD:'1',NIMBUS_HTTPS_PORT:'0'},
    stdio:['ignore',fs.openSync(path.join(data,'process.stdout.log'),'a'),fs.openSync(path.join(data,'process.stderr.log'),'a')]});
  exited=once(child,'exit');
  return until(async()=>{try{return(await fetch(base+'/health')).ok;}catch{return false;}});
}
async function api(route,method='GET',body){const headers={'x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),'content-type':'application/json'};const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;}
try{
  // Never claim or stop an existing server on this port.
  let occupied=false;try{occupied=!!(await fetch(base+'/health'));}catch{}
  if(occupied)throw new Error('Restart verification requires an unused dashboard port');
  await start();
  const worker=await api('/api/bots','POST',{name:'Restart verifier '+randomUUID().slice(0,6),model:'local',tools:[],approval_rules:[]});
  const first=await api('/api/tasks','POST',{botId:worker.id,task:'Calculate 17 times 23 and reply with the number.'});
  const second=await api('/api/tasks','POST',{botId:worker.id,task:'Reply exactly QUEUE_SURVIVED.'});
  await until(async()=>{const run=await api(`/api/runs/${first.runId}`);if(['error','paused','done'].includes(run.status))throw new Error('First task did not remain active long enough for this check');return run.status==='waiting_local';});
  await api('/api/admin/shutdown','POST',{});await exited;
  const snapshot=new DatabaseSync(path.join(data,'nimbus.db'),{readOnly:true});
  const retained=snapshot.prepare('SELECT id,status,checkpoint FROM runs WHERE id IN (?,?) ORDER BY id').all(first.runId,second.runId);snapshot.close();
  if(retained[0].status!=='interrupted'||!retained[0].checkpoint||retained[1].status!=='queued')throw new Error('Shutdown did not preserve the active checkpoint and queued task');
  receipt.checks.push({name:'shutdown preserves checkpoint and queue',pass:true,runs:retained});save();
  await start();
  await api(`/api/runs/${first.runId}/resume`,'POST',{});
  const results=await Promise.all([first,second].map(t=>until(async()=>{const r=await api(`/api/runs/${t.runId}`);if(['paused','error','needs_review'].includes(r.status))throw new Error(r.last_error||r.status);return r.status==='done'&&r;})));
  if(!results[0].reply.includes('391')||!results[1].reply.includes('QUEUE_SURVIVED'))throw new Error('Restarted tasks did not return their observed expected results');
  receipt.checks.push({name:'new process resumes checkpoint and executes retained queue',pass:true,results});
  receipt.pass=true;save();console.log(JSON.stringify({receipt:file,passed:2,total:2}));
}catch(e){receipt.pass=false;receipt.error=e.message;save();console.error(e.message);process.exitCode=1;}
finally{if(child?.exitCode===null){try{await api('/api/admin/shutdown','POST',{});await exited;}catch{child.kill();}}}
