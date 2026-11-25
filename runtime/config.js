import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {validateMcpScopes,policyHash,policyView} from './mcp-scope.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// Lumos (iMessage) connection settings; file-only (see runtime/lumos-config.js).
export const LUMOS_DEFAULTS={
  enabled:false,
  ingressPort:8646,
  bridgeUrl:'http://127.0.0.1:12345',
  bridgeConfigPath:'F:/Projects/Lumos/OpenBubblesResearch/bridge/config.json',
  ownerConfigPath:'F:/Projects/Lumos/HermesPilot/route.json',
  completeUrl:'http://127.0.0.1:12436/complete',
  botId:null,
  homeDir:'',
  schedulesEnabled:false,
  python:'',
  topicTimeoutSeconds:12,
  reviewerBotId:null,
  validatorBotId:null,
  reviewEvery:3,
};
const loopback=(value,label)=>{
  let url;try{url=new URL(value);}catch{throw new Error(`Invalid Lumos ${label}`);}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw new Error(`Lumos ${label} must be a loopback http URL`);
};
export function validateLumosConfig(l){
  if(typeof l?.enabled!=='boolean'||typeof l.schedulesEnabled!=='boolean')throw new Error('Lumos enabled and schedulesEnabled must be booleans');
  if(!Number.isInteger(l.ingressPort)||l.ingressPort<1024||l.ingressPort>65535)throw new Error('Invalid Lumos ingress port');
  loopback(l.bridgeUrl,'bridge URL');loopback(l.completeUrl,'completion URL');
  if(l.botId!==null&&(!Number.isSafeInteger(l.botId)||l.botId<1))throw new Error('Invalid Lumos worker id');
  for(const key of ['bridgeConfigPath','ownerConfigPath','homeDir','python'])if(typeof l[key]!=='string')throw new Error(`Invalid Lumos ${key}`);
  if(!Number.isFinite(l.topicTimeoutSeconds)||l.topicTimeoutSeconds<2||l.topicTimeoutSeconds>20)throw new Error('Invalid Lumos topic timeout');
  if(l.enabled&&(!l.botId||!l.homeDir))throw new Error('Lumos needs botId and homeDir before it can be enabled');
  return l;
}

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configOverridePresent = Object.hasOwn(process.env, 'NIMBUS_CONFIG');
export const CONFIG_FILE = path.resolve(process.env.NIMBUS_CONFIG || path.join(ROOT, 'nimbus.config.json'));
// Observed raw-file identity, not parsed settings or a CAS guarantee.
export function configIdentity() {
  let rawFileSha256 = null, readState = 'ok';
  try { rawFileSha256 = createHash('sha256').update(fs.readFileSync(CONFIG_FILE)).digest('hex'); }
  catch (error) { readState = error.code === 'ENOENT' ? 'missing' : 'unreadable'; }
  return { resolvedPath: CONFIG_FILE, overridePresent: configOverridePresent,
    rawFileSha256, readState, pid: process.pid };
}
export const defaults = {
  version: 1,
  cloud: { enabled: true, codexBin: 'auto', maxConcurrent: 3,
    models: { luna: 'auto', terra: 'auto', sol: 'auto', astra: 'auto' } },
  // Claude subscription through Claude Code, used beside Codex (never instead of it).
  // Lumos (iMessage) on Nimbus. Off until the cutover switch enables it.
  lumos: LUMOS_DEFAULTS,
  claude: { enabled: true, bin: 'auto', maxConcurrent: 2, disabledTiers: [],
    models: { 'claude-haiku': 'auto', 'claude-sonnet': 'auto', 'claude-opus': 'auto', 'claude-fable': 'auto' } },
  local: { enabled: true, baseUrl: 'http://127.0.0.1:12438/v1', model: 'nimbus-local',
    approvedModels: ['nimbus-local', 'lumos-emergency-gemma', 'hermes-pilot-qwen'], reuseLoaded:true,
    managed:{enabled:true,lmsBin:'lms',modelKey:'google/gemma-4-e4b',gpuRatio:0.2,forecastGpuMB:6500,forecastRamMB:15625,upstreamUrl:'http://127.0.0.1:1234/v1'},
    contextTokens: 131072, maxConcurrent: 1, resourceCeiling: 90, timeoutSeconds: 240,
    tokenEnv: 'NIMBUS_LOCAL_TOKEN', tokenDpapiFile: '', healthUrl: 'http://127.0.0.1:12438/health' },
  routing: { routerModel: '', cloudFallbackTier:'luna', maxAttempts: 4, localWaitSeconds: 300, providerRanking: {} },
  workers: { maxConcurrent: 4, executionMode: 'bounded', maxSteps: 32, timeoutMinutes: 45, approvalPollMs: 500, permissionMode: 'rules' },
  toolDevelopment: { maxAutomaticContinuations: 3, maxAutomaticRepairs: 2 },
  context: { automaticCompression: true, maxHistoryChars: 240000, maxToolChars: 12000 },
  browser: { enabled: true, headless: true, channel: '', maxGroups: 12, maxTabsPerGroup: 8 },
  mcpServers: {},
  mcpScopeGroups: {},
};
function merge(base, incoming) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(incoming || {})) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid configuration key');
    out[key] = value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object'
      ? merge(base[key], value) : value;
  }
  return out;
}
export function validateConfig(c) {
  if(typeof c.local?.enabled!=='boolean')throw new Error('Local models enabled must be a boolean');
  if(typeof c.context.automaticCompression!=='boolean')throw new Error('Automatic context compression must be a boolean');
  for(const [key,min,max] of [['maxHistoryChars',24000,900000],['maxToolChars',256,32000]])if(!Number.isSafeInteger(c.context[key])||c.context[key]<min||c.context[key]>max)throw new Error(`Invalid context ${key}`);
  for(const value of [c.toolDevelopment.maxAutomaticContinuations,c.toolDevelopment.maxAutomaticRepairs])if(!Number.isInteger(value)||value<0||value>10)throw new Error('Automatic tool recovery limits must be integers from 0 to 10');
  validateMcpScopes(c);
  validateLumosConfig(c.lumos);
  if (!['bounded','progress'].includes(c.workers.executionMode)) throw new Error('Invalid execution mode');
  if (!['rules', 'all'].includes(c.workers?.permissionMode)) throw new Error('Invalid worker permission mode');
  for (const [label, value, min, max] of [
    ['local concurrency', c.local.maxConcurrent, 1, 1], ['worker concurrency', c.workers.maxConcurrent, 1, 32],
    ['cloud concurrency', c.cloud.maxConcurrent, 1, 16], ['resource ceiling', c.local.resourceCeiling, 10, 90],
    ['maximum steps', c.workers.maxSteps, 1, 200], ['context size', c.local.contextTokens, 4096, 1000000],
    ['local timeout', c.local.timeoutSeconds, 5, 1800], ['local wait', c.routing.localWaitSeconds, 1, 3600],
    ['worker timeout', c.workers.timeoutMinutes, 1, 1440], ['browser groups', c.browser.maxGroups, 1, 64],
    ['tabs per group', c.browser.maxTabsPerGroup, 1, 64], ['model attempts',c.routing.maxAttempts,1,5],
    ['GPU ratio',c.local.managed.gpuRatio,0,1],['GPU load forecast',c.local.managed.forecastGpuMB,1,100000],['RAM load forecast',c.local.managed.forecastRamMB,1,1000000]
  ]) if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  const url = new URL(c.local.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid local inference URL');
  if (!Object.keys(c.cloud.models).every(k => ['luna', 'terra', 'sol', 'astra'].includes(k))) throw new Error('Unknown model tier');
  if(!['luna','terra','sol','astra'].includes(c.routing.cloudFallbackTier))throw new Error('Invalid cloud fallback tier');
  if(typeof c.claude?.enabled!=='boolean')throw new Error('Claude enabled must be a boolean');
  if(!Number.isInteger(c.claude.maxConcurrent)||c.claude.maxConcurrent<1||c.claude.maxConcurrent>16)throw new Error('Invalid Claude concurrency');
  const claudeTiers=['claude-haiku','claude-sonnet','claude-opus','claude-fable'];
  if(!Object.keys(c.claude.models||{}).every(k=>claudeTiers.includes(k))||!Array.isArray(c.claude.disabledTiers)||c.claude.disabledTiers.some(t=>!claudeTiers.includes(t)))throw new Error('Unknown Claude model tier');
  const rankable=['luna','terra','sol','astra',...claudeTiers];
  for(const [category,order] of Object.entries(c.routing.providerRanking||{}))if(!Array.isArray(order)||order.some(t=>!rankable.includes(t)))throw new Error(`Invalid provider ranking for ${category}`);
  if(!Array.isArray(c.local.approvedModels)||c.local.approvedModels.some(m=>typeof m!=='string'))throw new Error('Invalid local model allowlist');
  return c;
}
// Synchronous read/check/write is serialized in the host event loop. Exclusive
// lock also protects independent Nimbus processes; never steal an uncertain lock.
export function updateMcpScope(args,write=false){
  const lock=CONFIG_FILE+'.scope.lock';let fd;
  if(write){try{fd=fs.openSync(lock,'wx');}catch{throw new Error('MCP policy busy; inspect before retrying');}}
  let part;
  try{
    const raw=fs.existsSync(CONFIG_FILE)?fs.readFileSync(CONFIG_FILE,'utf8'):'{}';
    const file=JSON.parse(raw),current=validateConfig(merge(defaults,file));
    if(write&&(!/^[0-9a-f]{64}$/.test(args.expectedPolicyHash||'')||args.expectedPolicyHash!==policyHash(current)))throw new Error('policy_conflict');
    if(args.scope===undefined&&args.groups===undefined)throw new Error('Provide scope or groups');
    if(args.scope!==undefined){
      if(typeof args.server!=='string'||!Object.hasOwn(file.mcpServers||{},args.server))throw new Error('Unknown configured MCP server');
      file.mcpServers[args.server].scope=structuredClone(args.scope);
    }else if(args.server!==undefined)throw new Error('Server requires scope');
    if(args.groups!==undefined)file.mcpScopeGroups=structuredClone(args.groups);
    const next=validateConfig(merge(defaults,file));
    if(write){
      // Optimistic comparison includes unrelated config to avoid lost writes.
      if((fs.existsSync(CONFIG_FILE)?fs.readFileSync(CONFIG_FILE,'utf8'):'{}')!==raw)throw new Error('policy_conflict');
      const target=CONFIG_FILE+'.scope.part';const output=fs.openSync(target,'wx');part=target;
      try{fs.writeFileSync(output,JSON.stringify(file,null,2)+'\n');}finally{fs.closeSync(output);}
      fs.renameSync(part,CONFIG_FILE);part=undefined;
      if(policyHash(config())!==policyHash(next))throw new Error('Policy verification failed; inspect configuration');
    }
    return {written:write,policyHash:policyHash(next),...policyView(next)};
  }finally{if(part&&fs.existsSync(part))fs.unlinkSync(part);if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}
export function config() {
  const file = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  return validateConfig(merge(defaults, file));
}
export function saveConfig(patch) {
  const lock=CONFIG_FILE+'.scope.lock';let fd;
  try{fd=fs.openSync(lock,'wx');}catch{throw new Error('MCP policy busy; inspect before retrying');}
  try{
  const next = merge(config(), patch);
  // Policy maps and scopes are replacements, never recursive security-rule merges.
  if(Object.hasOwn(patch,'mcpScopeGroups'))next.mcpScopeGroups=structuredClone(patch.mcpScopeGroups);
  for(const [name,def] of Object.entries(patch.mcpServers||{}))if(Object.hasOwn(def,'scope'))next.mcpServers[name].scope=structuredClone(def.scope);
  validateConfig(next);
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE + '.part', JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(CONFIG_FILE + '.part', CONFIG_FILE);
  return next;
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
