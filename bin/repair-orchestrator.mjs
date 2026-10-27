#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {ROOT} from '../runtime/config.js';
import {ROLE_PROFILES} from '../runtime/roles.js';
import {PROMPT_VERSION} from '../runtime/prompts.js';
import {resolveOrchestrator,OrchestratorError} from '../runtime/orchestrator.js';

// Matches the original Orchestrator profile shipped with prompt version .2.
// This text is retained as upgrade provenance, never executed as instructions.
export const LEGACY_ORCHESTRATOR_INSTRUCTIONS=`### Mission, intake and authority
Act as the dedicated top-level Nimbus coordinator. The human owner remains the authority; your place in the team does not authorize new external actions or override worker approvals. Receive requests from the owner or an explicitly configured Hermes/Lumos/API caller, preserve the original task, source label, request ID, context and file references, and define the deliverable and acceptance evidence. Source labels alone do not prove a bridge is connected. Hermes/Lumos integration is not configured or verified by this profile; never claim otherwise.
### Inspect and delegate
Use team_status before delegation to inspect the current roster, registered hierarchy, available specialists and bounded task state. Scope each assignment to a concrete outcome and acceptance criteria. Choose the appropriate registered specialist across engineering, quality/security, research/knowledge, operations/content, browser and GitHub roles. Existing GitHub subagent ownership remains intact. Delegate through ask_worker, retain run IDs and collect actual worker_result outputs; do not report queued or running work as complete. Avoid cyclic handoffs and needless delegation. Workers may still communicate directly when useful; you are the coordination contact, not a restriction on their existing cooperation.
### Evidence, missing tools and recovery
Carry only the relevant context and exact paths/IDs into handoffs. Reconcile claims against actual tool journals, artifact files, process exits, QA/review evidence and destination records. Keep observations separate from assumptions. If a required capability is absent, inspect tool_catalog and connector_inventory before using request_tool; preserve the original requester/source, follow its durable design/build/QA/review/deployment status, and report gaps honestly. Disabled permissions, missing credentials, unavailable services and uncertain actions require their existing resolution path, not a bypass tool. Preserve checkpoints and completed outcomes; never automatically replay an uncertain external action.
### Upstream reporting and acceptance
Return useful progress and final evidence to the original request source through the configured Nimbus task channel. Do not invent outbound callbacks, send messages through an unconfigured Hermes/Lumos bridge, or borrow another app's credentials. Report completed specialist work, actual checks, artifacts, remaining blockers and needed human decisions. A launch, child assertion, configured endpoint, accepted update or profile name is not completion. Finish only when the user's requested outcome is verified, or preserve a precise blocked state when required access or a decision is missing.`;
// Same marker used by bin/upgrade-team.mjs. A recognized profile prefix can be
// replaced while the exact following custom suffix remains owner-authored.
export const CUSTOM_INSTRUCTIONS_MARKER='\n\n### Existing user instructions (preserved; honor these constraints)\n';
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const plainBot=bot=>Object.fromEntries(Object.entries(bot).filter(([key])=>!['status','today'].includes(key)));
const profile=()=>ROLE_PROFILES.find(item=>item.id==='orchestrator');
function idle(state){const queue=state?.queues?.workers;if(!queue||!Number.isFinite(queue.active)||!Number.isFinite(queue.queued))throw new OrchestratorError('Cannot verify the current worker queue before repair',409,'queue_state_unknown');if(queue.active||queue.queued)throw new OrchestratorError('Wait for active and queued worker tasks before repairing the coordinator profile.',409,'workers_active');}
function toolsOf(bot){let names=bot.tools;if(typeof names==='string'){try{names=JSON.parse(names);}catch{throw new OrchestratorError('The Orchestrator tool assignment is malformed',409,'invalid_tool_assignment');}}if(!Array.isArray(names)||names.some(name=>typeof name!=='string'))throw new OrchestratorError('The Orchestrator tool assignment is malformed',409,'invalid_tool_assignment');return names;}
function instructionsFor(current,{preserveCustom=false}={}){
  const target=profile().instructions;
  if(current===target)return{instructions:target,classification:'current_default',customPreserved:false};
  if(current===LEGACY_ORCHESTRATOR_INSTRUCTIONS)return{instructions:target,classification:'legacy_default',customPreserved:false};
  for(const [label,prefix]of [['current',target],['legacy',LEGACY_ORCHESTRATOR_INSTRUCTIONS]])if(current.startsWith(prefix+CUSTOM_INSTRUCTIONS_MARKER))return{instructions:target+current.slice(prefix.length),classification:label+'_with_preserved_custom_suffix',customPreserved:true};
  if(!preserveCustom)throw new OrchestratorError('The Orchestrator has unrecognized custom instructions. Review them, then explicitly use --preserve-custom to retain the entire text under the documented user-instruction marker.',409,'custom_instructions_require_review');
  return{instructions:target+CUSTOM_INSTRUCTIONS_MARKER+current,classification:'explicitly_preserved_custom',customPreserved:true};
}
export function planOrchestratorRepair(bots,{preserveCustom=false}={}){
  const bot=resolveOrchestrator(bots),oldTools=toolsOf(bot),instructions=instructionsFor(String(bot.instructions??''),{preserveCustom}),next=profile();
  return{botId:Number(bot.id),name:bot.name,promptVersion:PROMPT_VERSION,classification:instructions.classification,customPreserved:instructions.customPreserved,
    beforeTools:[...oldTools],tools:[...next.tools],removedTools:oldTools.filter(name=>!next.tools.includes(name)),addedTools:next.tools.filter(name=>!oldTools.includes(name)),
    beforeInstructionsHash:digest(String(bot.instructions??'')),instructionsHash:digest(instructions.instructions),changed:JSON.stringify(oldTools)!==JSON.stringify(next.tools)||bot.instructions!==instructions.instructions,
    patch:{tools:[...next.tools],instructions:instructions.instructions},note:'Only this coordinator tool assignment and profile instructions change. Existing models, authority rules, parents, specialists and MCP settings are retained. Existing run checkpoints are not resumed or rewritten.'};
}
function save(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file+'.part',JSON.stringify(value,null,2)+'\n');fs.renameSync(file+'.part',file);}
export async function repairOrchestrator({api,apply=false,receiptFile,source='Authenticated live Nimbus API /api/state',preserveCustom=false}={}){
  if(typeof api!=='function')throw new Error('An authenticated Nimbus API client is required');
  const state=await api('/api/state');idle(state);const plan=planOrchestratorRepair(state.bots,{preserveCustom}),before=resolveOrchestrator(state.bots);
  const publicPlan={...plan};delete publicPlan.patch;
  if(!apply)return{apply:false,source,plan:publicPlan};
  if(typeof receiptFile!=='string'||!path.isAbsolute(receiptFile))throw new Error('An absolute new repair receipt path is required');if(fs.existsSync(receiptFile))throw new Error('Repair receipt already exists; choose a new evidence path');
  const receipt={startedAt:new Date().toISOString(),source,promptVersion:PROMPT_VERSION,provenance:{profile:'orchestrator',profileSource:'runtime/roles.js',profileInstructionsHash:digest(profile().instructions),legacyInstructionsHash:digest(LEGACY_ORCHESTRATOR_INSTRUCTIONS),preservedMarker:CUSTOM_INSTRUCTIONS_MARKER},plan:publicPlan,before:plainBot(before),otherAgentsBefore:state.bots.filter(bot=>Number(bot.id)!==plan.botId).map(plainBot),operations:[],complete:false};
  const persist=()=>save(receiptFile,receipt);persist();
  try{
    const fresh=await api('/api/state');idle(fresh);const current=resolveOrchestrator(fresh.bots);
    if(Number(current.id)!==plan.botId||digest(plainBot(current))!==digest(plainBot(before)))throw new OrchestratorError('The coordinator changed after the repair plan; refresh and review its retained settings.',409,'repair_source_drift');
    if(plan.changed){const op={method:'PATCH',route:'/api/bots/'+plan.botId,body:plan.patch,status:'pending'};receipt.operations.push(op);persist();try{await api(op.route,op.method,op.body);op.status='observed';persist();}catch(error){op.status='error';op.error=error.message;persist();throw error;}}
    const after=await api('/api/state'),observed=resolveOrchestrator(after.bots),unexpected=[];
    if(Number(observed.id)!==plan.botId)unexpected.push({field:'identity',reason:'Coordinator identity changed'});
    if(JSON.stringify(toolsOf(observed))!==JSON.stringify(plan.patch.tools)||observed.instructions!==plan.patch.instructions)unexpected.push({field:'tools/instructions',reason:'The API did not retain the planned coordinator profile'});
    for(const [key,value]of Object.entries(plainBot(before)))if(!['tools','instructions'].includes(key)&&JSON.stringify(observed[key])!==JSON.stringify(value))unexpected.push({id:plan.botId,field:key,reason:'An unrelated coordinator field changed'});
    const afterOthers=after.bots.filter(bot=>Number(bot.id)!==plan.botId).map(plainBot);if(digest(afterOthers)!==digest(receipt.otherAgentsBefore))unexpected.push({field:'other_agents',reason:'A specialist roster/settings change was observed during repair'});
    receipt.after=plainBot(observed);receipt.otherAgentsAfter=afterOthers;receipt.unexpectedChanges=unexpected;receipt.finishedAt=new Date().toISOString();if(unexpected.length){persist();throw new Error('Repair observed unexpected settings changes; inspect its saved receipt. No automatic rollback was attempted.');}
    receipt.complete=true;persist();return{apply:true,changed:plan.changed,verified:true,botId:plan.botId,promptVersion:PROMPT_VERSION,removedTools:plan.removedTools,customPreserved:plan.customPreserved,receipt:receiptFile,note:plan.note};
  }catch(error){receipt.error=error.message;receipt.finishedAt=new Date().toISOString();persist();throw error;}
}

async function main(){
  const flags=process.argv.slice(2);if(flags.some(flag=>!['--apply','--preserve-custom'].includes(flag)))throw new Error('Usage: node bin/repair-orchestrator.mjs [--apply] [--preserve-custom]');
  const data=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data')),base=`http://127.0.0.1:${process.env.PORT||8787}`,headers={'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim()};
  const api=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000)}),value=await response.json();if(!response.ok)throw Object.assign(new Error(value.error||'HTTP '+response.status),{statusCode:response.status,code:value.code});return value;};
  const receiptFile=path.join(data,'verification',`orchestrator-repair-${Date.now()}-${randomUUID().slice(0,8)}.json`);console.log(JSON.stringify(await repairOrchestrator({api,apply:flags.includes('--apply'),preserveCustom:flags.includes('--preserve-custom'),receiptFile,source:{kind:'Authenticated live Nimbus API',endpoint:base+'/api/state'}}),null,2));
}
const invoked=process.argv[1]?path.resolve(process.argv[1]):'',self=fileURLToPath(import.meta.url);
if(invoked&&(process.platform==='win32'?invoked.toLowerCase()===self.toLowerCase():invoked===self))await main().catch(error=>{console.error(error.message);process.exitCode=1;});
