#!/usr/bin/env node
// Explicit, bounded subscription entitlement and cancellation verification.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT} from '../runtime/config.js';
const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data')),base=`http://127.0.0.1:${process.env.PORT||8787}`;
const headers={'x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),'content-type':'application/json'};
const session=randomUUID(),receipt={session,checks:[]},file=path.join(data,'verification',`models-${Date.now()}.json`);
fs.mkdirSync(path.dirname(file),{recursive:true});
const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));
async function api(route,method='GET',body){const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){const end=Date.now()+180000;while(Date.now()<end){const r=await fn();if(r)return r;await sleep(500);}throw new Error('Verification deadline exceeded');}
async function done(id){return until(async()=>{const r=await api(`/api/runs/${id}`);return ['done','paused','error','needs_review','stopped','interrupted'].includes(r.status)&&r;});}
async function check(name,fn){const row={name};receipt.checks.push(row);save();try{row.result=await fn();row.pass=true;}catch(e){row.pass=false;row.error=e.message;process.exitCode=1;}save();console.log(`${row.pass?'PASS':'FAIL'} ${name}${row.error?': '+row.error:''}`);}
for(const tier of ['terra','sol','astra'])await check(`${tier} subscription tools`,async()=>{
  const worker=await api('/api/bots','POST',{name:`Verify ${tier} ${session.slice(0,6)}`,model:tier,effort:'low',tools:['write_file','read_file'],approval_rules:[]});
  const content=`NIMBUS_${tier.toUpperCase()}_OK`;
  const task=await api('/api/tasks','POST',{botId:worker.id,task:`Use write_file to write receipt.txt containing exactly ${content}, then use read_file to verify it. Reply with the observed contents.`,requestId:`${session}:${tier}`});
  const run=await done(task.runId);
  if(run.status!=='done'||!run.actual_model?.includes(tier))throw new Error(run.last_error||'The selected cloud family did not complete');
  if(fs.readFileSync(path.join(data,'bots',String(worker.id),'receipt.txt'),'utf8')!==content)throw new Error('Actual artifact did not match');
  return run;
});
await check('cancelled cloud host action is held without replay',async()=>{
  const worker=await api('/api/bots','POST',{name:`Verify cancel ${session.slice(0,6)}`,model:'luna',effort:'low',tools:['shell'],approval_rules:[]});
  const marker=path.join(data,'bots',String(worker.id),'cancel-started.txt');
  const task=await api('/api/tasks','POST',{botId:worker.id,task:"Use shell once to run exactly: Add-Content -LiteralPath cancel-started.txt -Value NIMBUS_CANCEL_ONCE; Start-Sleep -Seconds 20; Write-Output FINISHED. Set timeoutSeconds to 30. Do not repeat this command.",requestId:`${session}:cancel`});
  await until(async()=>fs.existsSync(marker));
  await api(`/api/runs/${task.runId}/stop`,'POST',{});const run=await done(task.runId);
  const detail=await api(`/api/runs/${task.runId}/events`);
  if(run.status!=='needs_review'||!detail.tools.some(t=>t.state==='uncertain'))throw new Error('Cancelled action was not held for review');
  await sleep(1000);
  if(fs.readFileSync(marker,'utf8').trim().split(/\r?\n/).length!==1)throw new Error('Cancelled command was repeated');
  const response=await fetch(base+`/api/runs/${task.runId}/resume`,{method:'POST',headers,body:'{}'});
  if(response.ok)throw new Error('Unreviewed action was allowed to resume');
  return{run,tools:detail.tools,replayBlocked:true};
});
receipt.finished=true;receipt.passed=receipt.checks.filter(c=>c.pass).length;receipt.total=receipt.checks.length;save();console.log(JSON.stringify({receipt:file,passed:receipt.passed,total:receipt.total}));
