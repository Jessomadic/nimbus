import {createHash,randomUUID} from 'node:crypto';

export const ORCHESTRATOR_PROFILE_ID='orchestrator';
export class OrchestratorError extends Error{
  constructor(message,statusCode=400,code='invalid_request'){super(message);this.name='OrchestratorError';this.statusCode=statusCode;this.status=statusCode;this.code=code;}
}
function roster(bots){if(!Array.isArray(bots))throw new OrchestratorError('A current worker roster is required',500,'invalid_roster');return bots;}
function coordinatorCandidates(bots){return roster(bots).filter(bot=>bot.template===ORCHESTRATOR_PROFILE_ID||String(bot.name||'').trim().toLowerCase()==='orchestrator');}
export function resolveOrchestrator(bots,{required=true}={}){
  const candidates=coordinatorCandidates(bots);
  if(candidates.length>1)throw new OrchestratorError('Multiple Orchestrator identities exist. Resolve duplicate profiles/names before routing or setup.',409,'ambiguous_orchestrator');
  if(candidates.length===1&&candidates[0].template!==ORCHESTRATOR_PROFILE_ID)throw new OrchestratorError('An unregistered worker already uses the Orchestrator name. Classify it explicitly before creating a coordinator.',409,'orchestrator_name_collision');
  if(!candidates.length){if(required)throw new OrchestratorError('Orchestrator is not configured. Run the Orchestrator setup before submitting default tasks.',404,'orchestrator_not_configured');return null;}
  const result=candidates[0];
  if(result.parent_bot_id!=null)throw new OrchestratorError('The Orchestrator has a parent. Setup will not silently reparent it; resolve that hierarchy explicitly.',409,'orchestrator_has_parent');
  return result;
}
function positiveId(value){
  const valid=typeof value==='number'&&Number.isSafeInteger(value)||typeof value==='string'&&/^[1-9]\d*$/.test(value);
  if(!valid||!Number.isSafeInteger(Number(value))||Number(value)<1)throw new OrchestratorError('botId must be an explicit positive worker ID');
  return Number(value);
}
function selectedWorker(body,bots){
  let byId,byName;
  if(Object.hasOwn(body,'botId')){const id=positiveId(body.botId);byId=bots.find(bot=>Number(bot.id)===id);if(!byId)throw new OrchestratorError('Worker ID not found',404,'worker_not_found');}
  if(Object.hasOwn(body,'worker')){
    if(typeof body.worker!=='string'||!body.worker.trim()||body.worker.length>200)throw new OrchestratorError('worker must be an explicit nonempty worker name');
    const matches=bots.filter(bot=>String(bot.name).toLowerCase()===body.worker.trim().toLowerCase());
    if(matches.length>1)throw new OrchestratorError('Worker name is ambiguous; submit an explicit botId.',409,'ambiguous_worker');
    if(!matches.length)throw new OrchestratorError('Worker name not found',404,'worker_not_found');byName=matches[0];
  }
  if(byId&&byName&&Number(byId.id)!==Number(byName.id))throw new OrchestratorError('botId and worker identify different workers; choose one intended destination.',409,'conflicting_worker_selectors');
  return byId||byName||null;
}
export function resolveTaskWorker(body,bots,{orchestratorOnly=false}={}){
  roster(bots);if(!body||typeof body!=='object'||Array.isArray(body))throw new OrchestratorError('Task input must be an object');
  const selected=selectedWorker(body,bots);
  if(orchestratorOnly){const coordinator=resolveOrchestrator(bots);if(selected&&Number(selected.id)!==Number(coordinator.id))throw new OrchestratorError('The canonical Orchestrator endpoint does not accept a redirect to another worker.',400,'orchestrator_redirect_rejected');return coordinator;}
  return selected||resolveOrchestrator(bots);
}
export function orchestratorStatus(bots){
  const coordinator=resolveOrchestrator(bots,{required:false});
  return{configured:!!coordinator,orchestrator:coordinator?{id:Number(coordinator.id),name:coordinator.name,template:coordinator.template,parent_bot_id:null,model:coordinator.model||'auto',default_model:coordinator.default_model||'',effort:coordinator.effort||null}:null,
    taskEndpoint:'/api/orchestrator/tasks',bridge:{connected:false,status:'not_configured',contacts:['hermes','lumos'],message:'This endpoint is the designated Nimbus contact for Hermes/Lumos. No bridge connection, credentials or live integration has been configured or verified.'},
    ...(!coordinator?{setupRequired:true,message:'Create the unique Orchestrator profile through bin/setup-orchestrator.mjs --apply.'}:{})};
}
export function planOrchestratorSetup(bots){
  const coordinator=resolveOrchestrator(bots,{required:false});
  return{create:!coordinator,orchestrator:coordinator?{id:Number(coordinator.id),name:coordinator.name,template:coordinator.template,parent_bot_id:null}:null,
    attach:roster(bots).filter(bot=>Number(bot.id)!==Number(coordinator?.id)&&bot.parent_bot_id==null).map(bot=>({id:Number(bot.id),name:bot.name,parent_bot_id:null})),
    preserveParents:roster(bots).filter(bot=>bot.parent_bot_id!=null).map(bot=>({id:Number(bot.id),name:bot.name,parent_bot_id:bot.parent_bot_id})),
    bridge:{connected:false,status:'not_configured'},note:'Only the unique Orchestrator profile and currently parentless workers are changed. Existing nonnull parents, worker settings, memory and history are retained.'};
}
export function createTaskSubmission({db,query,runTask,getTask}={}){
  if(!db||typeof query!=='function'||typeof runTask!=='function'||typeof getTask!=='function')throw new Error('Task submission requires the existing database/runner callbacks');
  return function submitTask(body,{orchestratorOnly=false}={}){
    if(!body||typeof body!=='object'||Array.isArray(body))throw new OrchestratorError('Task input must be an object');
    if(typeof body.task!=='string'||!body.task.trim())throw new OrchestratorError('task is required');
    const bots=query('SELECT id,name,template,parent_bot_id,model,default_model,effort FROM bots ORDER BY id').all(),bot=resolveTaskWorker(body,bots,{orchestratorOnly});
    const requestId=body.requestId===undefined?randomUUID():body.requestId;
    if(typeof requestId!=='string'||!requestId.trim()||requestId.length>200)throw new OrchestratorError('requestId must contain 1 to 200 characters');
    const source=body.source===undefined?'api':body.source;
    if(!['hermes','lumos','api'].includes(source))throw new OrchestratorError('source must be hermes, lumos or api');
    const thread=body.thread===undefined?'bot:'+bot.id:body.thread;
    if(typeof thread!=='string'||!/^(bot|room):\d+$/.test(thread))throw new OrchestratorError('A valid bot/room thread is required');
    if(orchestratorOnly&&thread!=='bot:'+bot.id)throw new OrchestratorError('The canonical Orchestrator endpoint uses its own task thread.',400,'orchestrator_thread_redirect_rejected');
    const task={botId:Number(bot.id),thread,task:body.task,context:body.context||'',files:body.files===undefined?[]:body.files};
    if(!Array.isArray(task.files)||task.files.some(file=>typeof file!=='string'))throw new OrchestratorError('files must be an array of host file paths');
    let context;try{context=typeof task.context==='string'?task.context:JSON.stringify(task.context);}catch{throw new OrchestratorError('context must be serializable task data');}
    // Keep the existing API fingerprint for source=api so old request IDs
    // replay after this upgrade. Non-API sources add their correlation label.
    const fingerprint=createHash('sha256').update(JSON.stringify(source==='api'?task:{...task,source})).digest('hex');
    const prompt=task.task+'\nContext:\n'+context+(task.files.length?'\nHost files:\n'+task.files.join('\n'):'');
    db.exec('BEGIN IMMEDIATE');
    try{
      const previous=query('SELECT * FROM task_requests WHERE request_key=?').get(requestId);
      if(previous){
        if(previous.fingerprint!==fingerprint)throw new OrchestratorError('requestId was already used for different task data',409,'request_id_conflict');
        const result={status:200,body:{requestId,replayed:true,runId:Number(previous.run_id),...getTask(previous.run_id)}};db.exec('COMMIT');return result;
      }
      const id=runTask({botId:Number(bot.id),thread,prompt,source,originRequestId:requestId});
      query('INSERT INTO task_requests(request_key,fingerprint,run_id) VALUES(?,?,?)').run(requestId,fingerprint,id);
      db.exec('COMMIT');return{status:202,body:{requestId,runId:Number(id),status:'queued',botId:Number(bot.id),source}};
    }catch(error){db.exec('ROLLBACK');throw error;}
  };
}
