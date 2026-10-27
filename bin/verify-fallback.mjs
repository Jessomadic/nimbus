#!/usr/bin/env node
// Verify the real resource-blocked route without changing memory admission or
// other GPU workloads. Uses an existing worker and restores its model setting.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const data=path.resolve(process.env.NIMBUS_DATA||'data'),base=`http://127.0.0.1:${process.env.PORT||8787}`;
const headers={'x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),'content-type':'application/json'};
const receipt={checks:[]},file=path.join(data,'verification',`vram-fallback-${Date.now()}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});
const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));
async function api(route,method='GET',body){const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;}
async function wait(id){const end=Date.now()+300000;while(Date.now()<end){const r=await api(`/api/runs/${id}`);if(['done','paused','error','needs_review','stopped'].includes(r.status))return r;await new Promise(resolve=>setTimeout(resolve,500));}throw new Error('Fallback verification deadline exceeded');}
const worker=(await api('/api/state')).bots.find(b=>b.template==='knowledge-curator');if(!worker)throw new Error('Knowledge Curator is required for this bounded check');
try{
  // The retained task stopped before any tool side effects, so resuming it is safe.
  const tasks=await api('/api/tasks'),retained=tasks.find(t=>t.bot_id===worker.id&&t.status==='paused'&&/VRAM|resource|projected load/i.test(t.last_error||''));
  if(!retained)throw new Error('No retained resource-blocked task is available; this check must not force a GPU denial');
  await api(`/api/runs/${retained.id}/resume`,'POST',{});
  const resumed=await wait(retained.id),events=await api(`/api/runs/${retained.id}/events`);
  if(resumed.status!=='done'||!resumed.actual_model?.startsWith('gpt-')||!events.events.some(e=>e.type==='model.fallback'&&e.data.phase==='routing'&&/VRAM|resource|projected load/i.test(e.data.reason)))throw new Error(resumed.last_error||'Automatic resource fallback was not observed');
  receipt.checks.push({name:'resource-blocked local router completes retained task through OpenAI',pass:true,run:resumed});save();
  await api(`/api/bots/${worker.id}`,'PATCH',{model:'local'});
  const marker='NIMBUS_VRAM_FALLBACK_OK';
  const task=await api('/api/tasks','POST',{botId:worker.id,task:`Use write_file to write vram-fallback-check.txt containing exactly ${marker}, then read_file to verify its contents. Reply with the observed path and contents.`,requestId:randomUUID()});
  const direct=await wait(task.runId),detail=await api(`/api/runs/${task.runId}/events`);
  if(direct.status!=='done'||!direct.actual_model?.startsWith('gpt-')||!detail.events.some(e=>e.type==='model.fallback'&&e.data.phase==='execution'&&/VRAM|resource|projected load/i.test(e.data.reason)))throw new Error(direct.last_error||'Local execution resource fallback was not observed');
  if(fs.readFileSync(path.join(data,'bots',String(worker.id),'vram-fallback-check.txt'),'utf8')!==marker)throw new Error('Fallback artifact differs');
  receipt.checks.push({name:'explicit local execution admission failure completes real tools through OpenAI',pass:true,run:direct});receipt.pass=true;save();console.log(JSON.stringify({receipt:file,passed:2,total:2}));
}catch(error){receipt.pass=false;receipt.error=error.message;save();console.error(error.message);process.exitCode=1;}
finally{await api(`/api/bots/${worker.id}`,'PATCH',{model:worker.model||'auto'});}
