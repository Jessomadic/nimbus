import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CONFIG_FILE = path.resolve(process.env.NIMBUS_CONFIG || path.join(ROOT, 'nimbus.config.json'));
export const defaults = {
  version: 1,
  cloud: { enabled: true, codexBin: 'codex', maxConcurrent: 3,
    models: { luna: 'auto', terra: 'auto', sol: 'auto', astra: 'auto' } },
  local: { enabled: true, baseUrl: 'http://127.0.0.1:12438/v1', model: 'nimbus-local',
    approvedModels: ['nimbus-local', 'lumos-emergency-gemma', 'hermes-pilot-qwen'], reuseLoaded:true,
    managed:{enabled:true,lmsBin:'lms',modelKey:'google/gemma-4-e4b',gpuRatio:0.2,forecastGpuMB:6500,forecastRamMB:15625,upstreamUrl:'http://127.0.0.1:1234/v1'},
    contextTokens: 131072, maxConcurrent: 1, resourceCeiling: 90, timeoutSeconds: 240,
    tokenEnv: 'NIMBUS_LOCAL_TOKEN', tokenDpapiFile: '', healthUrl: 'http://127.0.0.1:12438/health' },
  routing: { routerModel: '', cloudFallbackTier:'luna', maxAttempts: 3, localWaitSeconds: 300 },
  workers: { maxConcurrent: 4, maxSteps: 32, timeoutMinutes: 45, approvalPollMs: 500 },
  browser: { enabled: true, headless: true, channel: '', maxGroups: 12, maxTabsPerGroup: 8 },
  mcpServers: {},
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
  if(!Array.isArray(c.local.approvedModels)||c.local.approvedModels.some(m=>typeof m!=='string'))throw new Error('Invalid local model allowlist');
  return c;
}
export function config() {
  const file = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  return validateConfig(merge(defaults, file));
}
export function saveConfig(patch) {
  const next = validateConfig(merge(config(), patch));
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE + '.part', JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(CONFIG_FILE + '.part', CONFIG_FILE);
  return next;
}
