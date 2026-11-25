import fs from 'node:fs';
import path from 'node:path';

// Codex ships rg independently of its CLI: their versioned directories can
// differ, and a Windows sign-in process does not inherit either session PATH.
export function installedRipgrepBins(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) return [];
  const candidates = [path.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'rg.exe')];
  const root = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(root, entry.name, 'rg.exe'));
  }
  return candidates.filter(file => fs.existsSync(file));
}
