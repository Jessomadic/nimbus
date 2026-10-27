import fs from 'node:fs';
import { capture } from './process.js';

const cache = new Map();
export async function unprotectWindows(file) {
  if (process.platform !== 'win32') throw new Error('This credential is protected for its owning Windows account; configure a credential on this machine.');
  const stat = fs.statSync(file);
  const entry = cache.get(file);
  if (entry?.mtime === stat.mtimeMs) return entry.value;
  const script = 'Add-Type -AssemblyName System.Security; $p=[Console]::In.ReadToEnd(); $b=[System.IO.File]::ReadAllBytes($p); $v=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($v)); [Array]::Clear($v,0,$v.Length)';
  const value = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: file });
  cache.set(file, { mtime: stat.mtimeMs, value });
  return value;
}
export async function localToken(c) {
  if (c.tokenDpapiFile) return unprotectWindows(c.tokenDpapiFile);
  return process.env[c.tokenEnv] || '';
}
export async function protect(text) {
  if (process.platform !== 'win32') throw new Error('Connector credential storage currently requires Windows DPAPI.');
  const script = 'Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[System.Text.Encoding]::UTF8.GetBytes($s); $v=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($v)); [Array]::Clear($b,0,$b.Length)';
  return 'dpapi:' + (await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: text })).trim();
}
export async function unprotect(value) {
  if (!value?.startsWith('dpapi:')) return value || '{}';
  const script = 'Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $v=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($v)); [Array]::Clear($v,0,$v.Length)';
  return capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: value.slice(6) });
}
