#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
const data=path.resolve(process.env.NIMBUS_DATA||'data'),base=`http://127.0.0.1:${process.env.PORT||8787}`;
const headers={'x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),'content-type':'application/json'},file=path.join(data,'verification',`github-team-${Date.now()}.json`);
const api=async(route,method='GET',body)=>{const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const v=await r.json();if(!r.ok)throw new Error(v.error||r.status);return v;};
const receipt={};try{
  const state=await api('/api/state'),parent=state.bots.find(b=>b.template==='github-coordinator'),children=state.bots.filter(b=>b.parent_bot_id===parent?.id);
  if(!parent||children.length!==5)throw new Error('GitHub coordinator hierarchy is incomplete');
  receipt.parent={id:parent.id,name:parent.name};receipt.children=children.map(b=>({id:b.id,name:b.name,profile:b.template}));
  const task=await api('/api/tasks','POST',{botId:parent.id,requestId:randomUUID(),task:'Verification only. Use ask_worker to delegate to your GitHub Sync subagent this read-only task: use shell to run git -C F:/Nimbus rev-parse --show-toplevel and git -C F:/Nimbus status --short, then report the repository root and the count of changed paths. Do not fetch, pull, stage, commit, push, modify files, or write to GitHub. Use worker_result to collect its completed result before replying. End your final reply with NIMBUS_GITHUB_HANDOFF_OK.'});
  let result;const end=Date.now()+240000;while(Date.now()<end){result=await api('/api/runs/'+task.runId);if(['done','paused','error','needs_review'].includes(result.status))break;await new Promise(r=>setTimeout(r,700));}
  const delegated=(await api('/api/tasks')).filter(t=>t.parent_run===task.runId);receipt.result=result;receipt.delegated=delegated;
  if(result.status!=='done'||!result.reply?.includes('NIMBUS_GITHUB_HANDOFF_OK')||!delegated.some(t=>t.status==='done'&&children.some(c=>c.id===t.bot_id)))throw new Error(result.last_error||'A registered GitHub subagent did not complete');
  receipt.pass=true;console.log('PASS GitHub coordinator delegates to a registered specialist and collects its real read-only Git result');
}catch(e){receipt.pass=false;receipt.error=e.message;process.exitCode=1;console.error(e.message);}
fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(receipt,null,2));console.log(JSON.stringify({receipt:file,pass:receipt.pass}));
