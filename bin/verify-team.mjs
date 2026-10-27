#!/usr/bin/env node
// Two bounded real tasks: automatic local specialization and explicit cloud
// override, including verification that Codex kept no durable inference thread.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ROOT} from '../runtime/config.js';
import {ROLE_PROFILES} from '../runtime/roles.js';
import {PROMPT_VERSION} from '../runtime/prompts.js';
import {CodexClient} from '../runtime/codex.js';
const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data')),base=`http://127.0.0.1:${process.env.PORT||8787}`;
const headers={'x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),'content-type':'application/json'};
const receipt={session:randomUUID(),checks:[]},file=path.join(data,'verification',`team-check-${Date.now()}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});
const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));
async function api(route,method='GET',body){const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(id){const end=Date.now()+300000;while(Date.now()<end){const r=await api(`/api/runs/${id}`);if(['done','error','paused','stopped','interrupted','needs_review'].includes(r.status))return r;await sleep(500);}throw new Error('Verification task deadline exceeded');}
async function check(name,fn){const row={name};receipt.checks.push(row);save();try{row.result=await fn();row.pass=true;}catch(e){row.pass=false;row.error=e.message;process.exitCode=1;}save();console.log(`${row.pass?'PASS':'FAIL'} ${name}${row.error?': '+row.error:''}`);}
const state=await api('/api/state');
await check('all fourteen specialist profiles and complete rosters are installed',async()=>{
  const profiles=[];
  for(const p of ROLE_PROFILES){const b=state.bots.find(b=>b.template===p.id);if(!b||b.default_model!==p.default_model)throw new Error('Missing profile/preference '+p.id);
    const brief=fs.readFileSync(path.join(data,'bots',String(b.id),'AGENTS.md'),'utf8');
    if(!brief.includes(PROMPT_VERSION)||!brief.includes(p.instructions)||!state.bots.filter(o=>o.id!==b.id).every(o=>brief.includes(`${o.name} (#${o.id})`)))throw new Error('Brief/roster incomplete for '+p.id);
    profiles.push({id:b.id,name:b.name,preferred:b.default_model,override:b.model,briefCharacters:brief.length});
  }return profiles;
});
const curator=state.bots.find(b=>b.template==='knowledge-curator'),office=state.bots.find(b=>b.template==='office-assistant');
await check('automatic role routing completes on an available backend',async()=>{
  const task=await api('/api/tasks','POST',{botId:curator.id,task:'Use write_file to write role-prompt-check.txt containing exactly NIMBUS_ROLE_LOCAL_OK. Use read_file to verify it. Report the observed path and contents.',requestId:`${receipt.session}:local`});
  const run=await wait(task.runId),detail=await api(`/api/runs/${task.runId}/events`);
  if(run.status!=='done')throw new Error(run.last_error||run.status);
  if(fs.readFileSync(path.join(data,'bots',String(curator.id),'role-prompt-check.txt'),'utf8')!=='NIMBUS_ROLE_LOCAL_OK')throw new Error('Local artifact differs');
  const decision=detail.events.find(e=>e.type==='route.selected')?.data;
  if(decision?.preferredTier!=='local'||decision.router==='explicit')throw new Error('Role preference was not used by the local router');
  return{run,decision};
});
await check('explicit model override uses temporary subscription execution and shared role tools',async()=>{
  let id;
  try{
    await api(`/api/bots/${office.id}`,'PATCH',{model:'luna'});
    const task=await api('/api/tasks','POST',{botId:office.id,task:'Use write_file to write role-prompt-check.txt containing exactly NIMBUS_ROLE_CLOUD_OK. Use read_file to verify it. Report the observed path and contents.',requestId:`${receipt.session}:cloud`});
    id=task.runId;const run=await wait(id),detail=await api(`/api/runs/${id}/events`);
    if(run.status!=='done'||!run.actual_model?.includes('luna'))throw new Error(run.last_error||'The explicit Luna route did not complete');
    if(fs.readFileSync(path.join(data,'bots',String(office.id),'role-prompt-check.txt'),'utf8')!=='NIMBUS_ROLE_CLOUD_OK')throw new Error('Cloud artifact differs');
    const threadId=detail.events.find(e=>e.type==='codex.thread')?.data.id;if(!threadId)throw new Error('Missing native session receipt');
    const client=new CodexClient();let absent=false;
    try{await client.initialize();try{await client.request('thread/read',{threadId,includeTurns:false});}catch(e){if(/thread not loaded|not found|no rollout|does not exist/i.test(e.message))absent=true;else throw e;}}finally{client.close();}
    if(!absent)throw new Error('Cloud session was saved as a durable Codex thread');
    return{run,nativeThreadId:threadId,temporarySessionNotPersisted:true};
  }finally{await api(`/api/bots/${office.id}`,'PATCH',{model:office.model||'auto'});}
});
receipt.finished=true;receipt.passed=receipt.checks.filter(c=>c.pass).length;receipt.total=receipt.checks.length;save();console.log(JSON.stringify({receipt:file,passed:receipt.passed,total:receipt.total}));
