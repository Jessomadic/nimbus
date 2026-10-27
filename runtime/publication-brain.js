// Operator-only bridge. No raw database access and no HTTP-controlled paths.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function createBrainPublicationAdapter({python,brainRoot,home}){
 for(const p of [python,brainRoot,home]){
  if(!path.isAbsolute(p)||/^[/\\]{2}/.test(p))throw Error('Trusted absolute local paths required');
  for(let x=p;;x=path.dirname(x)){
   if(fs.existsSync(x)&&fs.lstatSync(x).isSymbolicLink())throw Error('Links forbidden');
   if(path.dirname(x)===x)break;
  }
 }
 function invoke(operation,value){return new Promise((resolve,reject)=>{
  const child=spawn(python,[fileURLToPath(new URL('./publication-brain.py',import.meta.url)),'--brain-root',brainRoot,'--home',home,'--operation',operation],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',size=0,done=false;
  const timer=setTimeout(()=>finish(Error('Brain outcome unknown; status required')),120000);
  function finish(e,r){if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(r);}
  child.stdout.on('data',b=>{size+=b.length;if(size>1000000)finish(Error('Brain output overflow'));else out+=b;});
  child.stderr.resume();child.stdin.on('error',()=>{});
  child.on('error',e=>finish(e));
  child.on('close',code=>{try{if(code!==0)throw Error('Brain validation/write failed; reconcile submitted links');finish(null,JSON.parse(out));}catch(e){finish(e);}});
  child.stdin.end(JSON.stringify(value));
 });}
 return {validate:c=>invoke('validate',c),prepare:(receipt,citations)=>invoke('prepare',{receipt,citations}),write:p=>invoke('write',p),status:p=>invoke('status',p)};
}
