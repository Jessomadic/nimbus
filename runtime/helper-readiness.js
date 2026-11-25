// Exact reviewed text-only recipe. This is readiness evidence, never authority,
// deployment approval, or an OS sandbox. Broad retained resources stay blocked.
import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import pins from './helper-package-pins.json' with {type:'json'};
import privatePins from './helper-private-package-pins.json' with {type:'json'};
// Cooperative availability bounds, not OS confinement or an atomic snapshot.
export const DEFAULT_LIMITS=Object.freeze({entries:4096,directories:512,files:2000,fileBytes:16*1024*1024,totalBytes:128*1024*1024,elapsedMs:5000});
export function createTraversalBudget({limits={},now=()=>performance.now(),io=fs}={}){
 const cap={...DEFAULT_LIMITS,...limits};
 for(const [k,v] of Object.entries(cap))if(!Number.isSafeInteger(v)||v<0)throw Error('Invalid budget '+k);
 const started=now();if(!Number.isFinite(started))throw Error('Deadline bound');let last=started;
 const counts={entries:0,directories:0,files:0,bytes:0};
 function tick(){const t=now();if(!Number.isFinite(t)||t<last||t-started>cap.elapsedMs)throw Error('Deadline bound');last=t;}
 function charge(k,n){tick();if(n>cap[k]-counts[k])throw Error(k+' bound');counts[k]+=n;}
 function plain(p){for(let q=path.resolve(p);;){tick();if(io.existsSync(q)){tick();if(io.lstatSync(q).isSymbolicLink())throw Error('Linked path');}const up=path.dirname(q);if(up===q)return;q=up;}}
 function consume(p,collect=false){
  plain(p);tick();const s=io.lstatSync(p);if(!s.isFile())throw Error('Unsupported entry');
  if(!Number.isSafeInteger(s.size)||s.size<0||s.size>cap.fileBytes)throw Error('File byte bound');
  charge('files',1);if(s.size>cap.totalBytes-counts.bytes)throw Error('Aggregate byte bound');counts.bytes+=s.size;
  tick();const fd=io.openSync(p,'r');let pos=0;
  try{
   tick();const buffer=Buffer.alloc(Math.min(65536,s.size+1)), chunks=collect?[]:null, digest=collect?null:createHash('sha256');
   while(true){tick();const n=io.readSync(fd,buffer,0,Math.min(buffer.length,s.size-pos+1),pos);if(!n)break;
    if(pos+n>s.size)throw Error('File changed during read');
    tick();if(collect)chunks.push(Buffer.from(buffer.subarray(0,n)));else digest.update(buffer.subarray(0,n));pos+=n;
   }
   if(pos!==s.size)throw Error('File changed during read');
   tick();return collect?Buffer.concat(chunks,s.size):digest.digest('hex');
  }finally{io.closeSync(fd);}
 }
 function inventory(root,skipWork=false){
  const rows={};
  function walk(dir,depth){tick();if(depth>16)throw Error('Depth bound');plain(dir);charge('directories',1);
   tick();const d=io.opendirSync(dir,{bufferSize:1});
   try{while(true){tick();const e=d.readSync();if(!e)break;charge('entries',1);
    const p=path.join(dir,e.name),r=path.relative(root,p).replaceAll('\\','/');plain(p);
    if(skipWork&&r==='runtime/work')continue;
    if(e.isDirectory())walk(p,depth+1);else if(e.isFile()){const h=consume(p);tick();rows[r]=h;}else throw Error('Unsupported entry');
   }}finally{d.closeSync();}
  }walk(root,0);return rows;
 }
 return {inventory,plain,hash:p=>consume(p),read:p=>consume(p,true),counts};
}
export function createHelperReadiness({limits={},now=()=>performance.now(),io=fs,installedPins=pins,candidatePins=privatePins}={}){
 return function helperReadiness(name,skillPath){
 if(name!=='pdf-text-stamp-r2')return null;
 try{
 const b=createTraversalBudget({limits,now,io});
 const root=path.dirname(skillPath);b.plain(root);
 const actual=b.inventory(root,true);
 const matches=rows=>JSON.stringify(Object.entries(actual).sort())===JSON.stringify(Object.entries(Object.fromEntries(rows.map(f=>[f.relative,f.sha256]))).sort());
 const variant=matches(installedPins)?'installed_use':matches(candidatePins)?'private':'unknown';
 if(variant==='unknown')throw Error('Package inventory mismatch');
 const manifestPath=path.join(root,'runtime/environment-manifest.json'),lock=JSON.parse(b.read(manifestPath).toString('utf8'));
 for(const [p,h] of Object.entries(lock.identity)){b.plain(p);if(b.hash(p)!==h)throw Error('Interpreter identity mismatch');}
 b.plain(lock.helper);if(b.hash(lock.helper)!==lock.helperSha256)throw Error('Helper identity mismatch');
 const closure=b.inventory(lock.dependencyRoot);
 if(JSON.stringify(Object.entries(closure).sort())!==JSON.stringify(Object.entries(lock.closure).sort()))throw Error('Dependency closure mismatch');
 return {state:'ready_scoped',scope:'nonempty text only: runtime/run_resource.py pdf pdf_stamp.py',variant,implemented:true,configuration:'selected package and retained support paths checked',dependencyReady:true,installed:'unverified',ordinaryWorkerProof:false,packageFiles:installedPins.length,dependencyFiles:Object.keys(closure).length,externalDependenciesRetained:true,installationApproved:false,executionAuthority:false,limitations:[variant==='private'?'Private author candidate pending independent review/release':'Installed-use contract; host installation receipt required separately','Broad PDF/image/OCR/other resources remain blocked','No global OS sandbox; dispatcher rechecks at use','Ordinary-worker proof must be recorded separately; not established by readiness']};
 }catch(error){return {state:'blocked',reason:error.message,installationApproved:false,executionAuthority:false};}
}

}
export const helperReadiness=createHelperReadiness();
