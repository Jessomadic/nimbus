import os from 'node:os';
import { capture } from './process.js';
let cached;
export async function resources({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < 3000) return cached;
  const ram = { total: os.totalmem(), used: os.totalmem() - os.freemem() };
  let gpu = null, gpuError = null;
  try {
    const csv = await capture('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'], { timeout: 8000 });
    gpu = csv.trim().split(/\r?\n/).map(row => { const [total, used] = row.split(',').map(Number); return { totalMb: total, usedMb: used, percent: used / total * 100 }; });
    if (!gpu.length || gpu.some(g => !Number.isFinite(g.percent))) throw new Error('Invalid GPU memory response');
  } catch (e) { gpuError = e.message; }
  cached = { at: Date.now(), ram: { ...ram, percent: ram.used / ram.total * 100 }, gpu, gpuError };
  return cached;
}
export async function checkResources(ceiling) {
  const state = await resources();
  if (state.ram.percent >= ceiling || state.gpu?.some(g => g.percent >= ceiling)) throw new Error(`Local inference paused: RAM or VRAM is at the ${ceiling}% ceiling.`);
  if (!state.gpu) throw new Error('GPU memory cannot be verified; local inference is paused.');
  return state;
}
