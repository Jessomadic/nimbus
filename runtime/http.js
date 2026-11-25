import {reviewAction} from './action-review.js';
import { q, db } from '../db.js';
import { broadcast } from '../events.js';
import { runBot, taskResult, resumeRun, runtimeQueues,toolDevelopment,approvePendingPermissions } from '../runner.js';
import { config } from './config.js';
import { updateRuntimeConfig } from './local-service-config.js';
import { cloudStatus, CodexClient } from './codex.js';
import { claudeStatus, setClaudeToken } from './claude.js';
import { openaiCatalogTiers } from './plan-models.js';
import { localCatalog } from './local.js';
import { resources } from './resources.js';
import { browsers } from './tools.js';
import { events, event } from './journal.js';
import { redact, encodeRedacted } from '../redact.js';
import {toolRequestSummary} from './tool-development-view.js';
import {createTaskSubmission,orchestratorStatus} from './orchestrator.js';

export function registerRuntimeRoutes({ route, body, json, reviewAuthority }) {
  const submitTask=createTaskSubmission({db,query:q,runTask:runBot,getTask:taskResult});
  const submission=orchestratorOnly=>async(req,res)=>{try{const result=submitTask(await body(req),{orchestratorOnly});return json(res,result.status,result.body);}catch(error){if(error.statusCode)return json(res,error.statusCode,{error:error.message,code:error.code});throw error;}};
  route('GET','/api/orchestrator',(req,res)=>{try{return json(res,200,orchestratorStatus(q('SELECT id,name,template,parent_bot_id,model,default_model,effort FROM bots ORDER BY id').all()));}catch(error){if(error.statusCode)return json(res,error.statusCode,{error:error.message,code:error.code});throw error;}});
  route('POST','/api/orchestrator/tasks',submission(true));
  route('GET','/api/tool-requests',(req,res,p,url)=>{const runId=url.searchParams.has('runId')?Number(url.searchParams.get('runId')):undefined;if(runId!==undefined&&(!Number.isSafeInteger(runId)||runId<1))return json(res,400,{error:'runId must be a positive task ID'});const result=toolDevelopment.list({runId,limit:50});return json(res,200,{...result,requests:result.requests.map(toolRequestSummary)});});
  route('GET','/api/tool-requests/:id',(req,res,p)=>{const request=toolDevelopment.get(p.id);return json(res,request?200:404,request||{error:'Tool-development request not found'});});
  route('POST','/api/tool-requests/:id/cancel',(req,res,p)=>json(res,200,toolDevelopment.cancel(p.id)));
  route('POST','/api/tool-requests/:id/retry',async(req,res,p)=>json(res,200,await toolDevelopment.retry(p.id,await body(req))));
  route('POST','/api/tool-requests/:id/continue',async(req,res,p)=>json(res,200,await toolDevelopment.continueStage(p.id,await body(req))));
  route('GET','/api/runtime',async(req,res)=>{
    const [cloud,local,hardware,claude]=await Promise.all([cloudStatus(),localCatalog(),resources(),claudeStatus()]);
    const c=config();
    let contact;try{contact=orchestratorStatus(q('SELECT id,name,template,parent_bot_id,model,default_model,effort FROM bots ORDER BY id').all());}catch(error){contact={configured:false,error:error.message};}
    json(res,200,{cloud:{ok:cloud.ok,subscription:cloud.subscription,plan:cloud.plan,tiers:openaiCatalogTiers(cloud,config()),models:cloud.models,runtime:cloud.runtime,error:cloud.error},
      claude:{ok:claude.ok,allowedTiers:claude.allowedTiers,excludedTiers:claude.excludedTiers,enabled:claude.enabled,subscription:claude.subscription,mode:claude.mode,plan:claude.plan,tokenAt:claude.tokenAt,limited:claude.limited,models:claude.models,error:claude.error},local,hardware,
      queues:runtimeQueues(),browserGroups:browsers.snapshot(),configuration:{localModel:c.local.model,routerModel:c.routing.routerModel||'shared loaded model',resourceCeiling:c.local.resourceCeiling},
      lumos:{connected:false,phase:contact.configured?'Orchestrator contact ready; Hermes/Lumos bridge is not configured':'Orchestrator setup required; Hermes/Lumos bridge is not configured',contactConfigured:contact.configured,taskEndpoint:'/api/orchestrator/tasks',orchestrator:contact.orchestrator||null,...(contact.error?{error:contact.error}:{})}});
  });
  route('GET','/api/runtime/config',(req,res)=>{const c=config();delete c.mcpServers;json(res,200,c);});
  route('PUT','/api/runtime/config',async(req,res)=>{
    const patch=await body(req);if(patch.lumos)throw new Error('Lumos settings are changed by Switch-LumosBackend.ps1 or nimbus.config.json, not this endpoint.');if(patch.mcpServers)throw new Error('Configure MCP definitions in the local configuration file; credentials are not returned through this endpoint.');
    try{const c=await updateRuntimeConfig(patch);approvePendingPermissions();delete c.mcpServers;broadcast('state_changed',{});json(res,200,c);}
    catch(error){const c=config();delete c.mcpServers;json(res,error.statusCode||500,{error:error.message,config:c});}
  });
  route('GET','/api/tasks',(req,res)=>json(res,200,q('SELECT id,bot_id,thread,status,source,requested_model,actual_model,route_reason,fallback_reason,backend,input_tokens,output_tokens,started_at,ended_at,last_error,parent_run FROM runs ORDER BY id DESC LIMIT 200').all()));
  route('POST','/api/tasks',submission(false));
  route('GET','/api/runs/:id',(req,res,p)=>json(res,200,taskResult(p.id)));
  route('GET','/api/runs/:id/events',(req,res,p)=>json(res,200,{events:events(Number(p.id)),tools:q('SELECT * FROM tool_calls WHERE run_id=? ORDER BY started_at,id').all(Number(p.id))}));
  route('POST','/api/runs/:id/resume',async(req,res,p)=>json(res,200,{runId:resumeRun(p.id,await body(req))}));
  route('POST','/api/tool-calls/:id/resolve',async(req,res,p)=>{
    if(!await reviewAuthority?.(req,res))return;
    const request=await body(req);
    const authority=await reviewAuthority?.(req,res);
    if(!authority)return;
    try {
      return json(res,200,reviewAction({db,q,authority,id:decodeURIComponent(p.id),request}));
    }catch(e){if(e.statusCode)return json(res,e.statusCode,{error:e.message});throw e;}
  });
  route('GET','/api/browser-groups',(req,res)=>json(res,200,{groups:browsers.snapshot()}));
  route('GET','/api/browser/:owner/:tab/screenshot',async(req,res,p)=>{
    const page=browsers.groups.get(p.owner)?.tabs.get(decodeURIComponent(p.tab));
    if(!page)return json(res,404,{error:'This browser tab is not open in that worker group'});
    const bytes=await page.screenshot();res.writeHead(200,{'content-type':'image/png','cache-control':'no-store'});res.end(bytes);
  });
  // Claude account: a token from `claude setup-token` (DPAPI-protected) or the
  // server's own Claude Code login. The token wins when both exist. The token is
  // never returned by any endpoint.
  // The UI polls this; it shares the 30-second status cache instead of starting a process each time.
  route('GET','/api/claude/status',async(req,res)=>{const s=await claudeStatus();json(res,200,{ok:s.ok,enabled:s.enabled,mode:s.mode,plan:s.plan,tokenAt:s.tokenAt,limited:s.limited,models:s.models,allowedTiers:s.allowedTiers,excludedTiers:s.excludedTiers,error:s.error});});
  route('POST','/api/claude/token',async(req,res)=>{
    const {token}=await body(req);
    try{await setClaudeToken(token);}catch(error){return json(res,400,{error:error.message});}
    broadcast('state_changed',{});const s=await claudeStatus({fresh:true});json(res,200,{ok:s.ok,mode:s.mode,error:s.error});
  });
  route('DELETE','/api/claude/token',async(req,res)=>{await setClaudeToken('');broadcast('state_changed',{});const s=await claudeStatus({fresh:true});json(res,200,{ok:s.ok,mode:s.mode});});
  let login=null;
  route('POST','/api/openai/login',async(req,res)=>{
    if(login)return json(res,409,{error:'A sign-in is already in progress'});
    const client=login=new CodexClient();
    try{
      await client.initialize();
      const started=await client.request('account/login/start',{type:'chatgpt'});
      client.on('message',msg=>{if(msg.method==='account/login/completed'){broadcast('openai_login',{success:msg.params.success,error:msg.params.error});client.close();login=null;}});
      setTimeout(()=>{if(login===client){client.close();login=null;}},600000).unref();
      json(res,200,{authUrl:started.authUrl,loginId:started.loginId});
    }catch(e){client.close();login=null;throw e;}
  });
}
