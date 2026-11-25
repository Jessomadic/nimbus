// Host-only composition. Approvals are explicit trusted control-plane receipts,
// never connector configuration. No auto-enrollment, persistence or parent dlopen.
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {bindingV1} from './connector-binding.js';
const verifier=readFileSync(new URL('./connector-native-verifier.ps1',import.meta.url),'utf8');
const fail=()=>new Error('Protected connector credential unavailable');
export function createWindowsConnectorStore({records=[],approval,diagnostics=()=>{}}={}) {
 if(process.platform!=='win32')throw fail();
 const enrolled=new Map();
 for(const r of records){
  if(!r||Object.keys(r).sort().join()!=='approvalRevision,binding,bindingV1,file,ownerSid,revision,sha256,sourceId'||!/^[a-zA-Z0-9_-]{1,100}$/.test(r.sourceId)||!Number.isSafeInteger(r.revision)||r.revision<1||
   !/^S-1-(?:\d+-)+\d+$/.test(r.ownerSid)||! /^[a-f0-9]{64}$/.test(r.sha256)||
   typeof r.file!=='string'||enrolled.has(r.sourceId.toLowerCase()))throw fail();
  enrolled.set(r.sourceId.toLowerCase(),Object.freeze({...r}));
 }
 const a=approval?Object.freeze({...approval}):null;
 if(a&&(Object.keys(a).sort().join()!=='abi,artifact,chain,imports,reviewId,revision,sha256'||typeof a.reviewId!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(a.reviewId)||a.abi!=='broker-v1-x64'||!Number.isSafeInteger(a.revision)||a.revision<1||
 !/^[a-f0-9]{64}$/.test(a.sha256)||typeof a.chain!=='string'||typeof a.artifact!=='string'))throw fail();
 if(a)for(const [key,r] of enrolled)enrolled.set(key,Object.freeze({...r,bindingV1:bindingV1(r.bindingV1,r,a)}));
 let closed=false;const jobs=new Set();
 const emit=x=>{try{diagnostics(x);}catch{}};
 return Object.freeze({
 read(entry,{signal}={}){
  const r=enrolled.get(entry.sourceId?.toLowerCase());
  if(closed||!a||!r||r.sourceId!==entry.sourceId||r.revision!==entry.revision||r.ownerSid!==entry.ownerSid||
   r.approvalRevision!==a.revision||typeof r.binding!=='string'||!r.binding.startsWith(r.ownerSid+'|')||
   !r.binding.endsWith('|'+r.sha256)||signal?.aborted)return Promise.reject(fail());
  return new Promise((resolve,reject)=>{
   let chunks=[],size=0,cancelled=false;
   const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(verifier,'utf16le').toString('base64')],
    {windowsHide:true,cwd:'C:\\Windows\\System32',env:{SystemRoot:'C:\\Windows'},stdio:['pipe','pipe','pipe']});
   let drain;const drained=new Promise(res=>drain=res);
   let killTimer;
   const abort=()=>{cancelled=true;if(!child.stdin.writableEnded)child.stdin.end('cancel\n');killTimer??=setTimeout(()=>child.kill(),250);};
   jobs.add({abort,drained});
   const job=[...jobs].at(-1);
   const timer=setTimeout(abort,10000);
   signal?.addEventListener('abort',abort,{once:true});
   child.stdin.on('error',()=>{});child.on('error',()=>{cancelled=true;});
   child.stderr.on('data',b=>{for(const line of b.toString().trim().split(/\r?\n/))if(['VERIFIED','EXECUTED','DENIED'].includes(line))emit(line);});
   child.stdout.on('data',b=>{size+=b.length;if(cancelled||size>65536){b.fill(0);abort();}else chunks.push(b);});
   child.on('close',code=>{
    clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);jobs.delete(job);
    const ok=!cancelled&&!closed&&code===0&&size>=24&&size<=65536;
    const value=ok?Buffer.concat(chunks):null;for(const b of chunks)b.fill(0);chunks=[];
    emit('DRAINED');drain();if(ok)resolve(value);else reject(fail());
   });
   child.stdin.write(JSON.stringify({...a,file:r.file,binding:r.binding,bindingV1:r.bindingV1,ownerSid:r.ownerSid})+'\n');
   if(signal?.aborted)abort();
  });
 },
 async close(){closed=true;for(const j of jobs)j.abort();await Promise.all([...jobs].map(j=>j.drained));}
 });
}
