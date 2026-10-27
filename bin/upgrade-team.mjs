#!/usr/bin/env node
// Upgrade role instructions without replacing worker identity/history/memory,
// connector assignments, explicit model overrides or existing tool permissions.
import fs from 'node:fs';
import path from 'node:path';
import {ROOT} from '../runtime/config.js';
import {ROLE_PROFILES} from '../runtime/roles.js';
import {PROMPT_VERSION} from '../runtime/prompts.js';
const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
const base=`http://127.0.0.1:${process.env.PORT||8787}`;
const headers={'x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),'content-type':'application/json'};
const legacy={
  researcher:'Research the assigned question using available tools. Keep source URLs and evidence with the result. Separate observations from assumptions.',
  builder:'Implement the assigned task, verify the resulting behavior, and return exact artifact paths and test results. Preserve unrelated work.',
  reviewer:'Review the assigned work against its requirements. Inspect evidence and run appropriate checks. Report concrete issues and verification limits.'
};
async function api(route,method='GET',body){const r=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const result=await r.json();if(!r.ok)throw new Error(result.error||r.status);return result;}
const state=await api('/api/state');
if(state.queues.workers.active||state.queues.workers.queued)throw new Error('Wait for active and queued workers before upgrading their standing instructions.');
const changes=ROLE_PROFILES.map(profile=>({profile,existing:state.bots.find(b=>b.template===profile.id)||state.bots.find(b=>!b.template&&b.name===profile.name)}));
if(!process.argv.includes('--apply')){
  console.log(JSON.stringify({apply:false,promptVersion:PROMPT_VERSION,plan:changes.map(({profile,existing})=>({action:existing?'upgrade':'add',name:profile.name,preferredModel:profile.default_model}))},null,2));
}else{
  const dir=path.join(data,'verification');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,`team-upgrade-${Date.now()}.json`);
  const receipt={promptVersion:PROMPT_VERSION,startedAt:new Date().toISOString(),before:state.bots.map(({id,name,role,instructions,model,default_model,effort,template,tools})=>({id,name,role,instructions,model,default_model,effort,template,tools})),changes:[]};
  const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));save();
  for(const {profile,existing} of changes){
    let result;
    if(existing){
      const starter=!existing.instructions||existing.instructions===legacy[profile.id];
      const instructions=starter?profile.instructions:existing.instructions.includes(profile.instructions)?existing.instructions:
        profile.instructions+'\n\n### Existing user instructions (preserved; honor these constraints)\n'+existing.instructions;
      result=await api(`/api/bots/${existing.id}`,'PATCH',{instructions,role:starter?profile.role:existing.role,default_model:existing.default_model||profile.default_model,
        effort:starter?profile.effort:existing.effort,template:profile.id});
    }else result=await api(`/api/templates/${profile.id}/add`,'POST',{});
    receipt.changes.push({id:result.id,name:result.name,action:existing?'upgraded':'added',preferredModel:result.default_model,override:result.model});save();
  }
  const updated=await api('/api/state');
  for(const profile of ROLE_PROFILES.filter(p=>p.parent_profile)){
    const child=updated.bots.find(b=>b.template===profile.id),parent=updated.bots.find(b=>b.template===profile.parent_profile);
    if(child&&parent&&child.parent_bot_id==null)await api(`/api/bots/${child.id}`,'PATCH',{parent_bot_id:parent.id});
  }
  // Rebuild every roster after all additions, including the first worker's brief.
  for(const bot of (await api('/api/state')).bots)await api(`/api/bots/${bot.id}`,'PATCH',{});
  receipt.finishedAt=new Date().toISOString();receipt.complete=true;save();
  console.log(JSON.stringify({receipt:file,upgraded:receipt.changes.filter(c=>c.action==='upgraded').length,added:receipt.changes.filter(c=>c.action==='added').length,total:receipt.changes.length}));
}
