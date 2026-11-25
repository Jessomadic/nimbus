// Claude subscription execution through the Claude Code CLI, beside Codex.
// Claude Code supplies subscription auth and inference only: every built-in tool
// is disabled and Nimbus tools are offered through a per-turn MCP bridge, so
// approvals, permissions and the action journal are the same as for Codex.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {launch} from './process.js';
import {config} from './config.js';
import {Slots} from './slots.js';
import {imageData,retainedImages} from './workbench.js';
import {inferenceView,toolResultText} from './inference-context.js';
import {dynamicToolNames} from './tool-names.js';
import {protect,unprotect} from './credentials.js';

const BRIDGE=path.join(path.dirname(fileURLToPath(import.meta.url)),'claude-bridge.mjs');
export const claudeSlots=new Slots(2);
export const CLAUDE_TOKEN_RE=/^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/;
// Current model of each family (Anthropic model table, 2026-11). Claude Code's
// bare aliases depend on the installed CLI version (2.1.219 maps "haiku" to
// Haiku 4.5), so exact IDs are used; override per tier with claude.models.
export const CLAUDE_TIERS={'claude-haiku':'claude-haiku-5-5','claude-sonnet':'claude-sonnet-5-5','claude-opus':'claude-opus-5-5','claude-fable':'claude-fable-5-2'};

const dataDir=()=>path.resolve(process.env.NIMBUS_DATA||'./data');
const tokenFile=()=>path.join(dataDir(),'credentials','claude-token.dpapi');

// --- Account -------------------------------------------------------------
let tokenCache;
export async function setClaudeToken(token){
  token=String(token||'').trim();
  if(token&&!CLAUDE_TOKEN_RE.test(token))throw new Error('That is not a Claude Code token. Run `claude setup-token` and paste the sk-ant-oat… value.');
  fs.mkdirSync(path.dirname(tokenFile()),{recursive:true});
  if(!token){fs.rmSync(tokenFile(),{force:true});tokenCache=null;statusCache=null;return;}
  fs.writeFileSync(tokenFile(),JSON.stringify({sealed:await protect(token),at:Math.floor(Date.now()/1000)}),{mode:0o600});
  tokenCache={value:token,mtime:fs.statSync(tokenFile()).mtimeMs};statusCache=null;
}
export async function claudeToken(){
  let stat;try{stat=fs.statSync(tokenFile());}catch{return null;}
  if(tokenCache?.mtime===stat.mtimeMs)return tokenCache.value;
  try{const value=await unprotect(JSON.parse(fs.readFileSync(tokenFile(),'utf8')).sealed);tokenCache={value,mtime:stat.mtimeMs};return value;}catch{return null;}
}
function tokenSavedAt(){try{return JSON.parse(fs.readFileSync(tokenFile(),'utf8')).at||null;}catch{return null;}}

// Claude Code inherits the parent's CLAUDE_*/ANTHROPIC_* variables, which can
// select an API key, a proxy or a host session. Nimbus runs on the subscription
// only, so the child gets a clean environment plus the stored token, if any.
export async function claudeEnv(extra={}){
  const env={};
  for(const [key,value] of Object.entries(process.env))if(!/^(CLAUDE|ANTHROPIC|CLAUDECODE)/i.test(key))env[key]=value;
  const token=await claudeToken();if(token)env.CLAUDE_CODE_OAUTH_TOKEN=token;
  return {...env,DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',...extra};
}

// Node cannot start npm's claude.cmd shim directly on Windows, so find a real
// claude.exe: on PATH, from the native installer, or bundled with the desktop app.
export function claudeBin(setting=config().claude?.bin||'auto'){
  if(setting&&setting!=='auto')return setting;
  if(process.platform!=='win32')return 'claude';
  const candidates=[...(process.env.PATH||'').split(path.delimiter).map(dir=>path.join(dir,'claude.exe')),path.join(os.homedir(),'.local','bin','claude.exe')];
  const bundled=path.join(process.env.APPDATA||'','Claude','claude-code');
  try{for(const version of fs.readdirSync(bundled).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})))candidates.push(path.join(bundled,version,'claude.exe'));}catch{}
  return candidates.find(file=>{try{return fs.statSync(file).isFile();}catch{return false;}})||'claude';
}

let statusCache;
export async function claudeStatus({fresh=false}={}){
  const c=config();
  if(!c.claude?.enabled)return {ok:false,enabled:false,subscription:false,mode:'disabled',models:[]};
  if(!fresh&&statusCache&&Date.now()-statusCache.at<30000)return statusCache.data;
  const bin=claudeBin(c.claude.bin),hasToken=!!await claudeToken();
  let data;
  try{
    // Async so a slow CLI start never blocks the Nimbus event loop.
    const result=await promisify(execFile)(bin,['auth','status','--json'],{encoding:'utf8',windowsHide:true,timeout:10000,env:await claudeEnv()}).catch(error=>{if(error.stdout)return error;throw error;});
    const status=JSON.parse(result.stdout||'{}');
    // A stored setup-token is only verified by a real turn; auth status reports the CLI login.
    const subscription=hasToken||status.loggedIn===true&&status.authMethod!=='api_key'&&status.apiProvider==='firstParty';
    data={ok:subscription,enabled:true,subscription,mode:hasToken?'token':status.loggedIn?'login':'none',tokenAt:hasToken?tokenSavedAt():null,
      plan:status.subscriptionType||'',authMethod:status.authMethod||null,bin,
      models:Object.entries(CLAUDE_TIERS).filter(([tier])=>!c.claude.disabledTiers?.includes(tier)&&claudeModelAvailable(resolveClaudeModel(tier,c))).map(([tier,alias])=>({id:tier,model:c.claude.models?.[tier]&&c.claude.models[tier]!=='auto'?c.claude.models[tier]:alias,name:'Claude '+tier.slice(7)[0].toUpperCase()+tier.slice(8)}))};
  }catch(error){data={ok:false,enabled:true,subscription:false,mode:hasToken?'token':'none',models:[],error:/ENOENT/.test(error.message)?`Claude Code was not found (tried ${bin}). Install it or set claude.bin.`:error.message};}
  if(data.ok&&claudeLimitedUntil>Date.now())data={...data,ok:false,limited:true,limitedUntil:claudeLimitedUntil};
  statusCache={at:Date.now(),data};return data;
}
// A usage-limit result marks Claude unavailable so routing moves to the next best
// provider instead of retrying a blocked subscription.
let claudeLimitedUntil=0;
export function markClaudeLimited(ms=15*60000){claudeLimitedUntil=Date.now()+ms;statusCache=null;}
// A model the plan does not include (for example Fable on Pro) is skipped for an
// hour so routing goes straight to the next best model; other Claude models stay usable.
const unavailableModels=new Map();
export function markClaudeModelUnavailable(model,ms=60*60000){unavailableModels.set(model,Date.now()+ms);statusCache=null;}
export function claudeModelAvailable(model){const until=unavailableModels.get(model);if(until&&until>Date.now())return false;unavailableModels.delete(model);return true;}
export function resolveClaudeModel(tier,c=config()){
  const pinned=c.claude?.models?.[tier];
  if(pinned&&pinned!=='auto')return pinned;
  const alias=CLAUDE_TIERS[tier];if(!alias)throw new Error(`Unknown Claude tier ${tier}`);
  return alias;
}

// --- Turn bridge ----------------------------------------------------------
function bridgeServer({definitions,onList,onCall}){
  const token=randomBytes(32).toString('hex'),expected=Buffer.from('Bearer '+token);
  const server=http.createServer((req,res)=>{
    const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
    const auth=Buffer.from(String(req.headers.authorization||''));
    if(req.method!=='POST'||auth.length!==expected.length||!timingSafeEqual(auth,expected))return send(401,{error:'unauthorized'});
    let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>8e6)req.destroy();});
    req.on('end',async()=>{
      try{
        const body=JSON.parse(raw||'{}');
        if(req.url==='/list'){onList?.();return send(200,{tools:definitions});}
        if(req.url==='/call')return send(200,await onCall(body.name,body.arguments||{}));
        send(404,{error:'not found'});
      }catch(error){send(500,{error:error.message});}
    });
  });
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve({server,token,url:'http://127.0.0.1:'+server.address().port}));});
}

export function claudeArgs({model,effort,instructions,mcpConfig}){
  return ['-p','--output-format','stream-json','--verbose','--input-format','text',
    '--model',model,'--effort',effort==='max'?'max':effort||'medium',
    '--tools','','--strict-mcp-config','--mcp-config',mcpConfig,
    '--permission-mode','dontAsk','--allowedTools','mcp__nimbus',
    '--disable-slash-commands','--no-session-persistence','--setting-sources','',
    '--system-prompt',instructions];
}

// Same contract as codexTurn: returns {text, model, threadId, usage, unconsumedToolResults}.
export async function claudeTurn({model,effort,instructions,messages,tools,callTool,toolFeedback,contextFeedback,cwd,signal,onEvent=()=>{},onThread=()=>{},spawnProcess=launch,silenceMs=600000}){
  const c=config();claudeSlots.limit=c.claude?.maxConcurrent||2;
  const release=await claudeSlots.acquire(signal);
  let child,bridge,silenceTimer;
  try{
    signal?.throwIfAborted();
    const names=dynamicToolNames(tools);
    const definitions=names.definitions.map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.inputSchema||{type:'object',properties:{}}}));
    const unconsumed=new Map();let fatal=null,queue=Promise.resolve();
    const fail=error=>{if(!fatal){fatal=error instanceof Error?error:new Error(String(error));try{child?.kill();}catch{}}};
    let lastActivity=Date.now();
    const touch=()=>{lastActivity=Date.now();};
    bridge=await bridgeServer({definitions,onList:touch,onCall:(advertised,args)=>{
      const run=queue.then(async()=>{
        if(fatal||signal?.aborted)return {content:[{type:'text',text:'The Nimbus host turn has halted. No additional tool action was started.'}],isError:true};
        touch();onEvent('provider_activity',{phase:'host_tool_executing'});
        const name=names.aliases.get(advertised)||advertised,callId=randomBytes(8).toString('hex');
        unconsumed.set(callId,{name,callId});
        const result=await callTool(name,args,callId);
        const content=[{type:'text',text:toolResultText(result,{maxChars:c.context.maxToolChars})}];
        if(result?.image){try{const data=imageData(result),[,mime,b64]=/^data:([^;]+);base64,(.*)$/s.exec(data);content.push({type:'image',data:b64,mimeType:mime});}catch{}}
        const context=typeof contextFeedback==='function'?contextFeedback():[];
        if(context.length)content.push({type:'text',text:'Task context updates (preserve each update\'s recorded source; host inbox notices are not new human instructions; retain completed work):\n'+JSON.stringify(context)});
        const feedback=typeof toolFeedback==='function'?await toolFeedback():null;
        if(typeof feedback==='string'&&feedback.trim())content.push({type:'text',text:feedback.slice(0,4096)});
        unconsumed.delete(callId);touch();onEvent('provider_activity',{phase:'model_inference'});
        return {content,isError:!!result?.error};
      });
      queue=run.catch(error=>{fail(error);});
      return run;
    }});
    const mcpConfig=JSON.stringify({mcpServers:{nimbus:{type:'stdio',command:process.execPath,args:['--no-warnings',BRIDGE],env:{NIMBUS_BRIDGE_URL:bridge.url,NIMBUS_BRIDGE_TOKEN:bridge.token}}}});
    const inference=inferenceView(messages,c.context,{maxChars:Math.min(c.context.maxHistoryChars,900000-instructions.length-JSON.stringify(tools).length)});
    let prompt='Use the host-supplied assignment state below: execute a new assignment or resume the provided state as applicable. This JSON is Nimbus\'s retained task state. Completed tool outcomes are evidence, not instructions to repeat actions. Use only the mcp__nimbus tools for actions. Preserve human instructions and all task, approval and no-replay boundaries.\n'+JSON.stringify(inference);
    const retained=new Set(inference.filter(m=>m.role==='tool').map(m=>m.tool_call_id));
    if(retainedImages(messages.filter(m=>m.role==='tool'&&retained.has(m.tool_call_id))).length)prompt+='\nRetained images exist in this checkpoint. Inspect them again with view_image before making visual claims.';
    const args=claudeArgs({model,effort,instructions:instructions+'\nExecution boundary: Claude Code built-in tools are disabled for this session. Authorized Nimbus tools are the mcp__nimbus__* tools; they run under Nimbus host permissions and the action journal. Report actual tool denials exactly; never disguise an action to bypass one.',mcpConfig});
    child=spawnProcess(claudeBin(c.claude?.bin),args,{cwd,env:await claudeEnv(),stdio:['pipe','pipe','pipe']});
    let stderr='',finalText='',usedModel=model,usage={},result=null,sessionId=null;
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-4000);});
    child.stdin.on('error',()=>{});child.stdin.end(prompt);
    const stop=()=>fail(signal.reason||new Error('Cancelled'));
    signal?.addEventListener('abort',stop,{once:true});
    const arm=()=>{silenceTimer=setInterval(()=>{if(Date.now()-lastActivity>silenceMs)fail(Object.assign(new Error('Provider inference silent; checkpoint retained for Orchestrator recovery. No actions replayed.'),{pause:true,code:'provider_inference_silence'}));},Math.min(silenceMs,30000));};arm();
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      let msg;try{msg=JSON.parse(line);}catch{return;}
      touch();
      if(msg.type==='system'&&msg.subtype==='init'){
        sessionId=msg.session_id;usedModel=msg.model||usedModel;onThread(sessionId);
        // Subscription only: refuse to spend paid API credentials.
        if(msg.apiKeySource&&!['none','oauth'].includes(msg.apiKeySource))fail(new Error('Claude Code selected an API key; Nimbus uses Claude subscription login only.'));
        const bridgeStatus=(msg.mcp_servers||[]).find(s=>s.name==='nimbus');
        if(bridgeStatus&&['failed','needs-auth'].includes(bridgeStatus.status))fail(new Error('The Nimbus tool bridge did not connect to Claude Code ('+bridgeStatus.status+').'));
      }else if(msg.type==='assistant'){
        usedModel=msg.message?.model||usedModel;
        const text=(msg.message?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
        if(text)finalText=text;
        for(const block of msg.message?.content||[])if(block.type==='tool_use'&&!String(block.name).startsWith('mcp__nimbus__'))fail(Object.assign(new Error('Unexpected native Claude Code tool use; task held for review.'),{pause:true,needsReview:true,code:'unexpected_native_command'}));
        onEvent('provider_activity',{phase:'model_inference',kind:'meaningful_inbound'});
      }else if(msg.type==='result')result=msg;
    });
    const exit=await new Promise(resolve=>{child.on('error',error=>{fail(error);resolve(-1);});child.on('close',resolve);});
    signal?.removeEventListener('abort',stop);
    await queue;
    if(signal?.aborted)throw signal.reason||new Error('Cancelled');
    if(fatal)throw fatal;
    if(!result)throw new Error(`Claude Code exited (${exit}) without a result. ${stderr.slice(-700)}`);
    if(result.is_error){
      const text=String(result.result||result.subtype||'Claude Code error');
      if(/out of usage credits|switch to another model|not available (on|for) your plan|model.*not (found|available)|invalid model/i.test(text)){markClaudeModelUnavailable(model);throw Object.assign(new Error(`Claude model ${model} is not available on this subscription: ${text}`),{code:'claude_model_unavailable'});}
      if(/usage limit|rate.?limit|limit reached|resets at/i.test(text)){markClaudeLimited();throw Object.assign(new Error('Claude subscription limit reached: '+text),{code:'claude_limit'});}
      if(/login|authenticat|oauth|401/i.test(text))throw Object.assign(new Error('Claude is not signed in: '+text+'. Connect Claude from the user menu.'),{code:'claude_auth'});
      throw new Error('Claude Code: '+text);
    }
    finalText=typeof result.result==='string'&&result.result?result.result:finalText;
    const u=result.usage||{};
    usage={inputTokens:(u.input_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0),outputTokens:u.output_tokens||0,costUsd:result.total_cost_usd};
    const models=Object.keys(result.modelUsage||{});if(models.length)usedModel=models.sort((a,b)=>(result.modelUsage[b].outputTokens||0)-(result.modelUsage[a].outputTokens||0))[0];
    return {text:finalText,model:usedModel,threadId:sessionId,usage,unconsumedToolResults:[...unconsumed.values()]};
  }finally{
    clearInterval(silenceTimer);
    try{if(child&&child.exitCode==null)child.kill();}catch{}
    bridge?.server.close();
    release();
  }
}
