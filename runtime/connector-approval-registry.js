import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createWindowsConnectorStore} from './connector-store-windows.js';
const fail=()=>{throw new Error('Protected connector credential unavailable');};
const prefix=readFileSync(new URL('./connector-native-verifier.ps1',import.meta.url),'utf8').split('$held=')[0];
const script=prefix+readFileSync(new URL('./connector-approval-registry.ps1',import.meta.url),'utf8');
function validate(m){
 if(!m||Object.keys(m).sort().join()!=='approval,records,revision,version'||m.version!==1||!Number.isSafeInteger(m.revision)||m.revision<1||!m.approval||!Array.isArray(m.records)||!m.records.length)fail();
 const b=createWindowsConnectorStore(m);b.close();return m;
}
function call(directory,action,mapping){
 const r=spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
 ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
 {windowsHide:true,cwd:'C:\\Windows\\System32',env:{SystemRoot:'C:\\Windows'},input:JSON.stringify({directory,action,mapping})+'\n',encoding:'utf8',timeout:10000,maxBuffer:1048576});
 if(r.error||r.status!==0)fail();return r.stdout;
}
export function readApprovalMapping(directory){try{return validate(JSON.parse(call(directory,'read')));}catch{fail();}}
export function commitApprovalMapping(directory,mapping){
 // Validate input and the JSON-normalized persisted value before any durable write.
 let persisted;
 try{validate(mapping);persisted=JSON.parse(JSON.stringify(mapping));validate(persisted);}catch{fail();}
 call(directory,'commit',persisted);
}
export function createPersistedWindowsConnectorStore({directory,diagnostics}){
 // Load protected state at startup. No approval or absent registry is fail-closed.
 const mapping=readApprovalMapping(directory);
 const backend=createWindowsConnectorStore({...mapping,diagnostics});
 const current=()=>{if(JSON.stringify(readApprovalMapping(directory))!==JSON.stringify(mapping))fail();};
 return Object.freeze({
  async read(entry,options){
   current();const value=await backend.read(entry,options);
   try{current();return value;}catch{value.fill(0);fail();}
  },
  close:()=>backend.close()
 });
}
