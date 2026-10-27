import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
fs.mkdirSync(DATA,{recursive:true});
const lock=path.join(DATA,'supervisor.lock'),stop=path.join(DATA,'stop.request');
if(fs.existsSync(lock)){
  const old=JSON.parse(fs.readFileSync(lock,'utf8'));let alive=false;try{process.kill(old.pid,0);alive=true;}catch(e){if(e.code==='EPERM')alive=true;}
  if(alive){console.log('Nimbus is already supervised.');process.exit(0);}fs.unlinkSync(lock);
}
fs.writeFileSync(lock,JSON.stringify({pid:process.pid,root:ROOT}),{flag:'wx'});
let child,stopping=false;
const out=fs.openSync(path.join(DATA,'server.stdout.log'),'a'),err=fs.openSync(path.join(DATA,'server.stderr.log'),'a');
const watcher=setInterval(()=>{if(fs.existsSync(stop))stopping=true;},500);
try{
  let failures=0;
  while(!stopping){
    child=spawn(process.execPath,['--no-warnings','--env-file-if-exists=.env',path.join(ROOT,'server.js')],{cwd:ROOT,windowsHide:true,stdio:['ignore',out,err]});
    fs.writeFileSync(path.join(DATA,'server.pid'),String(child.pid));
    const start=Date.now();
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    if(fs.existsSync(stop)||code===0)break;
    failures=Date.now()-start>60000?0:failures+1;
    if(failures>=5)throw new Error('Nimbus stopped after five rapid startup failures. See server.stderr.log.');
    await new Promise(r=>setTimeout(r,code===75?250:Math.min(30000,failures*2000)));
  }
}catch(e){fs.appendFileSync(path.join(DATA,'supervisor.errors.log'),new Date().toISOString()+' '+e.message+'\n');process.exitCode=1;}
finally{clearInterval(watcher);fs.closeSync(out);fs.closeSync(err);if(fs.existsSync(lock))fs.unlinkSync(lock);}
