// Wrap every Python stdio MCP server in integration/mcp-stdio-isolate.py (see that file for why).
//   node bin/mcp-isolate-stdin.mjs [--apply] [config path]
// Dry run by default. --apply backs up the config, inserts the launcher before the server
// script, and re-pins reviewedEffects transport hashes ONLY where they matched before the
// change (a stale pin stays stale: this never approves anything new).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
const nimbus = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {effectTransportHash} = await import(pathToFileURL(path.join(nimbus, 'runtime', 'mcp-scope.js')).href);
const apply = process.argv.includes('--apply');
const cfgPath = process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(nimbus, 'nimbus.config.json');
const SHIM = path.join(nimbus, 'integration', 'mcp-stdio-isolate.py').replaceAll('\\', '/');

export function wrapDefinition(name, def, shim = SHIM) {
  if (!def?.command || !/python(?:w)?(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(String(def.command))) return null;
  const args = Array.isArray(def.args) ? def.args : [];
  if (args.some(a => /mcp-stdio-isolate\.py$/i.test(String(a)))) return null; // already wrapped
  const at = args.findIndex(a => /\.py$/i.test(String(a)));
  if (at < 0 || args.slice(0, at).some(a => !String(a).startsWith('-'))) return null; // -m module or unknown shape
  const before = effectTransportHash(name, def);
  const next = structuredClone(def);
  next.args = [...args.slice(0, at), shim, ...args.slice(at)];
  const after = effectTransportHash(name, next);
  const repinned = [];
  for (const [tool, rule] of Object.entries(next.reviewedEffects || {}))
    if (rule?.transportHash === before) { rule.transportHash = after; repinned.push(tool); }
  return {def: next, repinned, stale: Object.keys(next.reviewedEffects || {}).filter(t => !repinned.includes(t))};
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  let changed = 0;
  for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
    const r = wrapDefinition(name, def);
    if (!r) { console.log('skip ', name); continue; }
    cfg.mcpServers[name] = r.def; changed++;
    console.log('wrap ', name, 'repinned', r.repinned.length, r.stale.length ? 'stale-unchanged ' + JSON.stringify(r.stale) : '');
  }
  if (apply && changed) {
    const backup = cfgPath + '.pre-stdin-isolate-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    fs.copyFileSync(cfgPath, backup);
    const tmp = cfgPath + '.tmp-isolate';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + (raw.endsWith('\n') ? '\n' : ''));
    fs.renameSync(tmp, cfgPath);
    console.log('wrote', cfgPath, 'backup', backup);
  } else console.log(apply ? 'nothing to change' : `dry run: ${changed} server(s) would change`);
}
