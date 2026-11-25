import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

export function installedCodexBins(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return [];
  const candidates = [path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')];
  const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(root, entry.name, 'codex.exe'));
  }
  return candidates.filter(file => fs.existsSync(file));
}
export function newestCodexRuntime(runtimes) {
  const parsed = runtimes.flatMap(item => {
    const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?\s*$/.exec(item.version);
    return match ? [{...item, parts:match.slice(1,4).map(Number), prerelease:match[4] || ''}] : [];
  });
  parsed.sort((a,b) => {
    for (let i=0;i<3;i++) if (a.parts[i]!==b.parts[i]) return b.parts[i]-a.parts[i];
    if (!a.prerelease || !b.prerelease) return Number(!!a.prerelease)-Number(!!b.prerelease);
    return b.prerelease.localeCompare(a.prerelease, undefined, {numeric:true});
  });
  if (!parsed.length) throw new Error('No working Codex CLI found. Install Codex or configure cloud.codexBin.');
  const {bin,version} = parsed[0]; return {bin,version};
}
let cached;
export function codexRuntime(setting = 'auto') {
  if (setting && setting !== 'auto') return {bin:setting,version:null};
  if (cached && Date.now()-cached.at < 30000) return cached.value;
  const candidates = [...new Set([...installedCodexBins(), 'codex'])];
  const runtimes = candidates.flatMap(bin => {
    const result = spawnSync(bin, ['--version'], {encoding:'utf8',windowsHide:true,timeout:3000});
    return result.status===0 ? [{bin,version:result.stdout.trim()}] : [];
  });
  const value = newestCodexRuntime(runtimes); cached={at:Date.now(),value}; return value;
}
