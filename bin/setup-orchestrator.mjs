#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {ROOT} from '../runtime/config.js';
import {planOrchestratorSetup,resolveOrchestrator,OrchestratorError} from '../runtime/orchestrator.js';

const preservedFields=['name','role','instructions','color','effort','model','default_model','runtime','approval_rules','allow_rules','tools','template','shape','computer','display_group','created_at','plugins'];
function idle(state){const queues=state?.queues?.workers;if(!queues||!Number.isFinite(queues.active)||!Number.isFinite(queues.queued))throw new OrchestratorError('Cannot verify the current worker queue before setup',409,'queue_state_unknown');if(queues.active||queues.queued)throw new OrchestratorError('Wait for active and queued worker tasks before setting up the team hierarchy.',409,'workers_active');}
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.part',file);}
export async function setupOrchestrator({api,apply=false,receiptFile,source='Live Nimbus API /api/state'}={}){
  if(typeof api!=='function')throw new Error('An authenticated Nimbus API client is required');
  const state=await api('/api/state');idle(state);const plan=planOrchestratorSetup(state.bots);
  if(!apply)return{apply:false,source,plan};
  if(typeof receiptFile!=='string'||!path.isAbsolute(receiptFile))throw new Error('An absolute new receipt path is required for --apply');
  if(fs.existsSync(receiptFile))throw new Error('Setup receipt already exists; choose a new evidence path');
  const receipt={startedAt:new Date().toISOString(),source,plan,before:state.bots,operations:[],attachments:[],skipped:[],complete:false};
  const persist=()=>save(receiptFile,receipt);persist();
  const operation=async(kind,route,method,body)=>{const item={kind,route,method,body,status:'pending'};receipt.operations.push(item);persist();try{const result=await api(route,method,body);item.status='observed';item.resultId=result?.id??null;persist();return result;}catch(error){item.status='error';item.error=error.message;persist();throw error;}};
  try{
    if(plan.create)await operation('create_orchestrator','/api/templates/orchestrator/add','POST',{});
    let current=await api('/api/state');idle(current);const coordinator=resolveOrchestrator(current.bots),rootId=Number(coordinator.id);
    const targets=current.bots.filter(bot=>Number(bot.id)!==rootId&&bot.parent_bot_id==null).map(bot=>({id:Number(bot.id),name:bot.name}));
    for(const target of targets){
      current=await api('/api/state');idle(current);const stillRoot=resolveOrchestrator(current.bots);if(Number(stillRoot.id)!==rootId)throw new Error('The coordinator identity changed during setup; inspect the retained plan');
      const bot=current.bots.find(bot=>Number(bot.id)===target.id);
      if(!bot||bot.parent_bot_id!=null){receipt.skipped.push({...target,reason:!bot?'Worker was removed during setup':'Worker already has a parent; its existing link was preserved',parent_bot_id:bot?.parent_bot_id??null});persist();continue;}
      try{
        const result=await operation('attach_parentless_worker',`/api/bots/${target.id}`,'PATCH',{parent_bot_id:rootId,expected_parent_bot_id:null});
        if(Number(result.parent_bot_id)!==rootId)throw new Error('The API did not retain the observed parent assignment');receipt.attachments.push({id:target.id,name:bot.name,before:null,after:rootId});persist();
      }catch(error){
        if(error.statusCode!==409&&error.status!==409)throw error;
        const refreshed=await api('/api/state'),changed=refreshed.bots.find(bot=>Number(bot.id)===target.id);
        if(changed?.parent_bot_id==null)throw error;
        receipt.skipped.push({...target,reason:'Parent changed before the guarded PATCH; concurrent link preserved',parent_bot_id:changed.parent_bot_id});persist();
      }
    }
    // Earlier briefs were generated while later root links were still pending.
    // Rebuild every current roster without replacing stored worker settings.
    current=await api('/api/state');idle(current);
    for(const bot of current.bots)await operation('refresh_standing_roster',`/api/bots/${bot.id}`,'PATCH',{});
    const after=await api('/api/state'),root=resolveOrchestrator(after.bots);if(Number(root.id)!==rootId)throw new Error('The final coordinator identity differs from the plan');
    const unexpected=[];
    for(const before of state.bots){
      const observed=after.bots.find(bot=>Number(bot.id)===Number(before.id));if(!observed){unexpected.push({id:before.id,field:'worker',reason:'Worker disappeared during setup'});continue;}
      for(const field of preservedFields)if(JSON.stringify(observed[field])!==JSON.stringify(before[field]))unexpected.push({id:before.id,field,reason:'A non-hierarchy field changed during setup; inspect concurrent edits'});
      if(before.parent_bot_id!=null&&observed.parent_bot_id!==before.parent_bot_id)unexpected.push({id:before.id,field:'parent_bot_id',reason:'An existing nonnull parent link changed during setup'});
    }
    receipt.after=after.bots;receipt.unexpectedChanges=unexpected;receipt.orchestrator={id:rootId,name:root.name,template:root.template,parent_bot_id:null};receipt.finishedAt=new Date().toISOString();
    if(unexpected.length){persist();throw new Error('Setup observed unexpected changes to existing settings or parent links; inspect the saved receipt before continuing');}
    receipt.complete=true;receipt.bridge={connected:false,status:'not_configured'};persist();
    return{apply:true,receipt:receiptFile,orchestrator:receipt.orchestrator,created:plan.create,attached:receipt.attachments.length,skipped:receipt.skipped.length,verified:true,bridge:receipt.bridge};
  }catch(error){receipt.error=error.message;receipt.finishedAt=new Date().toISOString();persist();throw error;}
}

async function main(){
  if(process.argv.slice(2).some(argument=>argument!=='--apply'))throw new Error('Usage: node bin/setup-orchestrator.mjs [--apply]');
  const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data')),base=`http://127.0.0.1:${process.env.PORT||8787}`;
  const headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)});const value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||`HTTP ${response.status}`),{statusCode:response.status,status:response.status,code:value.code});return value;};
  const apply=process.argv.includes('--apply'),receiptFile=path.join(data,'verification',`orchestrator-setup-${Date.now()}-${randomUUID().slice(0,8)}.json`);
  console.log(JSON.stringify(await setupOrchestrator({api,apply,receiptFile,source:{kind:'Live Nimbus API',endpoint:base+'/api/state'}}),null,2));
}
const invoked=process.argv[1]?path.resolve(process.argv[1]):'',self=fileURLToPath(import.meta.url);
if(invoked&&(process.platform==='win32'?invoked.toLowerCase()===self.toLowerCase():invoked===self))await main().catch(error=>{console.error(error.message);process.exitCode=1;});
