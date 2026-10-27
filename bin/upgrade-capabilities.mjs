#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../runtime/config.js';
import {ROLE_PROFILES} from '../runtime/roles.js';
import {specialistToolNames} from '../runtime/toolsets/index.js';
const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
const headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
async function api(route,method='GET',body){const r=await fetch(`http://127.0.0.1:${process.env.PORT||8787}${route}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();if(!r.ok)throw new Error(value.error||r.status);return value;}
const state=await api('/api/state');if(state.queues.workers.active||state.queues.workers.queued)throw new Error('Wait for active workers before changing their enabled tools');
const changes=state.bots.map(bot=>{
  const before=JSON.parse(bot.tools||'[]'),tools=new Set(before);
  for(const name of ['skills','update_plan','request_user_input','capabilities','request_tool','tool_request_status'])tools.add(name);
  if(tools.has('read_file'))tools.add('view_image');
  if(tools.has('shell')){tools.add('exec_command');tools.add('write_stdin');}
  if(tools.has('write_file'))tools.add('apply_patch');
  if(tools.has('shell')&&tools.has('write_file'))tools.add('self_update');
  const profile=ROLE_PROFILES.find(profile=>profile.id===bot.template)||ROLE_PROFILES.find(profile=>profile.name===bot.name);
  for(const name of specialistToolNames(profile?.id))tools.add(name);
  const approvalBefore=[...bot.approval_rules],approvalAfter=[...approvalBefore];
  if(tools.has('automation_schedule')&&!approvalAfter.includes('automation_schedule(enable)'))approvalAfter.push('automation_schedule(enable)');
  const pluginBefore=[...(bot.plugins||[])],pluginAfter=[...pluginBefore];
  if(process.argv.includes('--context7')&&profile&&!pluginAfter.includes('context7'))pluginAfter.push('context7');
  return{id:bot.id,name:bot.name,profile:profile?.id||null,before,after:[...tools],added:[...tools].filter(name=>!before.includes(name)),specialistTools:specialistToolNames(profile?.id).filter(name=>name!=='tool_catalog'),approvalBefore,approvalAfter,pluginBefore,pluginAfter};
});
if(!process.argv.includes('--apply'))console.log(JSON.stringify({apply:false,changes},null,2));
else{
  const file=path.join(data,'verification',`capability-upgrade-${Date.now()}.json`);fs.mkdirSync(path.dirname(file),{recursive:true});
  const receipt={changes,applied:[],startedAt:new Date().toISOString(),context7Requested:process.argv.includes('--context7')};const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));save();
  if(process.argv.includes('--context7')&&!state.installed.includes('context7')){await api('/api/plugins/context7','POST',{secrets:{}});receipt.context7Installed=true;save();}
  for(const change of changes){
    await api(`/api/bots/${change.id}`,'PATCH',{tools:change.after,approval_rules:change.approvalAfter});
    if(JSON.stringify(change.pluginBefore)!==JSON.stringify(change.pluginAfter))await api(`/api/bots/${change.id}/plugins`,'PUT',{plugins:change.pluginAfter});
    receipt.applied.push(change.id);save();
  }
  receipt.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({receipt:file,workers:receipt.applied.length}));
}
