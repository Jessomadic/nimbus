#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../runtime/config.js';
const DATA=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
const BASE=`http://127.0.0.1:${process.env.PORT||8787}`;
const token=fs.readFileSync(path.join(DATA,'admin.token'),'utf8').trim();
const headers={'x-nimbus-admin':token,'content-type':'application/json'};
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),session=randomUUID();
const out=path.join(DATA,'verification',`live-${stamp}.json`);fs.mkdirSync(path.dirname(out),{recursive:true});
const receipt={startedAt:new Date().toISOString(),session,server:BASE,checks:[],workers:[],samples:[],notes:[],finished:false};
const save=()=>fs.writeFileSync(out,JSON.stringify(receipt,null,2)+'\n');save();
async function api(route,method='GET',body){const r=await fetch(BASE+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const value=await r.json();if(!r.ok)throw new Error(value.error||`HTTP ${r.status}`);return value;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function worker(name,model,tools){const b=await api('/api/bots','POST',{name:`Verify ${name} ${session.slice(0,6)}`,role:'Bounded Nimbus acceptance worker',model,effort:'low',approval_rules:[],tools});receipt.workers.push(b.id);save();return b;}
async function submit(b,task,label){const r=await api('/api/tasks','POST',{botId:b.id,task,requestId:`${session}:${label}`});return r.runId;}
async function wait(id,timeout=420000){const until=Date.now()+timeout;while(Date.now()<until){const r=await api(`/api/runs/${id}`);if(['done','error','paused','stopped','interrupted','needs_review'].includes(r.status))return r;await sleep(1500);}throw new Error(`Task ${id} did not finish within the verification timeout`);}
async function check(name,fn){const row={name,startedAt:new Date().toISOString()};receipt.checks.push(row);save();try{row.details=await fn();row.pass=true;}catch(e){row.pass=false;row.error=e.message;process.exitCode=1;}row.finishedAt=new Date().toISOString();save();console.log(`${row.pass?'PASS':'FAIL'} ${name}${row.error?': '+row.error:''}`);}
function must(value,message){if(!value)throw new Error(message);}
const fixture=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Nimbus verification fixture</title><h1>Ready</h1><button onclick="document.querySelector(\'h1\').textContent=\'NIMBUS_BROWSER_CLICK_OK\'">Verify click</button>');});
await new Promise(r=>fixture.listen(0,'127.0.0.1',r));
const fixtureUrl=`http://127.0.0.1:${fixture.address().port}`;
let sampler;
try{
  const [a,b,cloud,router]=await Promise.all([
    worker('Local A','local',['write_file','read_file','browser']),worker('Local B','local',['write_file','read_file','browser']),
    worker('Cloud','luna',['write_file','read_file','browser','ask_worker']),worker('Router','',['write_file','read_file'])]);
  sampler=setInterval(async()=>{try{const state=await api('/api/runtime');receipt.samples.push({at:Date.now(),local:state.queues.local,loaded:state.local.models.filter(m=>m.loaded).map(m=>m.id),ram:state.hardware.ram.percent,vram:state.hardware.gpu?.map(g=>g.percent)});save();}catch{}},4000);
  const localA=await submit(a,'Use write_file to write receipt-a.txt containing exactly NIMBUS_SHARED_A, then read_file to verify it. Reply with the verified path and contents.','local-a');
  const localB=await submit(b,'Use write_file to write receipt-b.txt containing exactly NIMBUS_SHARED_B, then read_file to verify it. Reply with the verified path and contents.','local-b');
  const cloudId=await submit(cloud,'Use write_file to write receipt-cloud.txt containing exactly NIMBUS_CLOUD_ACCEPTED, then read_file to verify it. Reply with the verified path and contents.','cloud');
  const autoId=await submit(router,'Calculate 17 times 23. No external information is needed. Reply with the answer.','router');
  await check('local worker A real tool execution',async()=>{const r=await wait(localA);must(r.status==='done',r.last_error||r.status);must(fs.readFileSync(path.join(DATA,'bots',String(a.id),'receipt-a.txt'),'utf8')==='NIMBUS_SHARED_A','Receipt A differs');return r;});
  await check('local worker B shares inference capacity',async()=>{const r=await wait(localB);must(r.status==='done',r.last_error||r.status);must(fs.readFileSync(path.join(DATA,'bots',String(b.id),'receipt-b.txt'),'utf8')==='NIMBUS_SHARED_B','Receipt B differs');must(receipt.samples.every(s=>s.local.active<=1),'Local inference exceeded one active slot');return r;});
  await check('OpenAI subscription real tool execution',async()=>{const r=await wait(cloudId);must(r.status==='done',r.last_error||r.status);must(r.actual_model?.startsWith('gpt-'),'Cloud route did not complete on an OpenAI model');must(fs.readFileSync(path.join(DATA,'bots',String(cloud.id),'receipt-cloud.txt'),'utf8')==='NIMBUS_CLOUD_ACCEPTED','Cloud receipt differs');return r;});
  await check('local model chooses the task route',async()=>{const r=await wait(autoId),detail=await api(`/api/runs/${autoId}/events`);must(r.status==='done',r.last_error||r.status);must(r.reply.includes('391'),'Arithmetic receipt differs');const selected=detail.events.find(e=>e.type==='route.selected');must(selected?.data.router&&selected.data.router!=='explicit','Automatic route was not chosen by the local model');return{...r,decision:selected.data};});
  await check('cloud worker controls its own browser group',async()=>{
    const id=await submit(cloud,`Use the browser tool to open ${fixtureUrl}, click the button named Verify click, then take a snapshot and report the observed heading. Do not use shell or another browser.`, 'browser-cloud');
    const r=await wait(id);must(r.status==='done',r.last_error||r.status);must(r.reply.includes('NIMBUS_BROWSER_CLICK_OK'),'Browser heading was not verified');return r;
  });
  await check('worker handoff returns the actual child result',async()=>{
    const task=`Use ask_worker to assign ${JSON.stringify(b.name)} this task: write handoff.txt containing NIMBUS_HANDOFF_OK and read it back. Use worker_result to collect its completed result. Reply only after the delegated task is done and include its verified contents.`;
    const id=await submit(cloud,task,'handoff'),r=await wait(id);must(r.status==='done',r.last_error||r.status);
    const tasks=await api('/api/tasks'),children=tasks.filter(t=>t.parent_run===id);must(children.some(t=>t.status==='done'),'No delegated child completed');must(fs.readFileSync(path.join(DATA,'bots',String(b.id),'handoff.txt'),'utf8').includes('NIMBUS_HANDOFF_OK'),'Child artifact missing');return{parent:r,children};
  });
  await check('duplicate request does not execute a second task',async()=>{
    const value={botId:a.id,task:'Reply exactly IDEMPOTENT_OK.',requestId:`${session}:idempotency`};
    const first=await api('/api/tasks','POST',value),second=await api('/api/tasks','POST',value);must(first.runId===second.id&&second.replayed,'Request was duplicated');const r=await wait(first.runId);must(r.status==='done',r.last_error||r.status);return{runId:first.runId,replayed:second.replayed};
  });
  await check('resources remain below the configured ceiling',async()=>{const runtime=await api('/api/runtime'),ceiling=runtime.configuration.resourceCeiling;must(receipt.samples.length>0,'No resource samples were collected');must(receipt.samples.every(s=>s.ram<ceiling&&s.vram?.every(v=>v<ceiling)),'A resource sample exceeded its ceiling');return{ceiling,samples:receipt.samples.length,peakRam:Math.max(...receipt.samples.map(s=>s.ram)),peakVram:Math.max(...receipt.samples.flatMap(s=>s.vram||[]))};});
  await check('encrypted backup produces an archive',async()=>{const r=await api('/api/backup','POST',{});must(r.ok,r.error);must(fs.existsSync(r.file)&&r.size>0,'Backup archive missing');return r;});
}finally{
  clearInterval(sampler);fixture.closeAllConnections();await new Promise(r=>fixture.close(r));receipt.finishedAt=new Date().toISOString();receipt.finished=true;receipt.passed=receipt.checks.filter(c=>c.pass).length;receipt.total=receipt.checks.length;save();console.log(JSON.stringify({receipt:out,passed:receipt.passed,total:receipt.total}));
}
