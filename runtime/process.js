import { spawn } from 'node:child_process';
import { once } from 'node:events';
export function launch(command, args = [], options = {}) {
  return spawn(command, args, { windowsHide: true, ...options });
}
export async function capture(command, args = [], { timeout = 15000, signal, input, ...options } = {}) {
  const child = launch(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let out = '', err = '';
  child.stdout.on('data', c => { if (out.length < 2000000) out += c; });
  child.stderr.on('data', c => { if (err.length < 10000) err += c; });
  let timedOut=false;
  const stop = () => {
    if(process.platform==='win32'&&child.pid)launch('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'}).on('error',()=>child.kill());
    else child.kill();
  };
  const timer = setTimeout(()=>{timedOut=true;stop();}, timeout);
  signal?.addEventListener('abort', stop, { once: true });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  try {
    const [code] = await once(child, 'close');
    if (signal?.aborted) throw signal.reason || new Error('Cancelled');
    if (code !== 0||timedOut) throw Object.assign(new Error(`${command} ${timedOut?'timed out':'failed ('+code+')'}: ${(err.trim()||out.trim()).slice(-1200)}`),{stdout:out,stderr:err,exitCode:code});
    return out;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}
