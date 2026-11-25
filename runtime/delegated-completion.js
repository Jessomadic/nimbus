import fs from 'node:fs';
import {verifyOwned,verifyPins} from './required-completion.js';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {completionDecision} from './lifecycle-completion.js';
import {inspectCurrentReadback} from './completion-readback.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
const parse=x=>{try{return JSON.parse(x);}catch{return null;}};
const at=(x,p)=>p.split('.').reduce((v,k)=>v&&Object.hasOwn(v,k)?v[k]:undefined,x);
// Declared-field validation only: no command, package read, discovery or DB access.
// Keep aligned with engineering.run_checks; runtime availability is checked at execution.
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&!!x.trim()&&!x.includes('\0');
export function validateCompletionCheckArgs(args){
  const bad=message=>{throw new Error('Completion contract run_checks: '+message);};
  if(!object(args)||!['node_test','npm_script','python_unittest'].includes(args.runner))bad('choose node_test, npm_script or python_unittest');
  const variant={node_test:['files'],npm_script:['script'],python_unittest:['testDirectory']}[args.runner];
  if(Object.keys(args).some(k=>!['runner','path','timeoutSeconds',...variant].includes(k)))bad('unknown or wrong-variant argument');
  if(!text(args.path)||!path.isAbsolute(args.path))bad('path must be an absolute nonempty string');
  if(Object.hasOwn(args,'timeoutSeconds')&&(!Number.isInteger(args.timeoutSeconds)||args.timeoutSeconds<1||args.timeoutSeconds>180))bad('timeoutSeconds must be an integer from 1 to 180');
  const within=(value,allowRoot)=>{
    if(!text(value))bad('selected path must be a nonempty string');
    const relative=path.relative(args.path,path.resolve(args.path,value));
    if((!allowRoot&&!relative)||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))bad('selected path must stay within the project');
  };
  if(args.runner==='npm_script'){
    if(!text(args.script))bad('npm_script requires a nonempty script');
    // Same supported script-name families as the host; never accept shell text.
    if(!/^(?:test|lint|check|typecheck|validate|verify|build)(?:[:._-][A-Za-z0-9:._-]+)?$/.test(args.script)||/(?:^|[:._-])(?:publish|deploy|release|install|exec|push|merge)(?:$|[:._-])/.test(args.script))bad('unsupported npm check script name');
  }else if(args.runner==='node_test'&&Object.hasOwn(args,'files')){
    if(!Array.isArray(args.files)||args.files.length>100)bad('files must contain up to 100 paths');
    for(const file of args.files)within(file,false);
  }else if(args.runner==='python_unittest'&&Object.hasOwn(args,'testDirectory'))within(args.testDirectory,true);
  return args; // Preserve exact declared args; do not insert defaults or normalize paths.
}
export function validateCompletionContract(c){
  if(c===undefined)return null;
  const bad=()=>{throw new Error('Completion contract requires 1-20 absolute outputs and exact run_checks args with 1-20 path/equals assertions');};
  if(!c||Object.keys(c).some(k=>!['outputs','checks'].includes(k))||!Array.isArray(c.outputs)||!c.outputs.length||c.outputs.length>20||c.outputs.some(p=>typeof p!=='string'||!path.isAbsolute(p))||new Set(c.outputs).size!==c.outputs.length||!Array.isArray(c.checks)||!c.checks.length||c.checks.length>20)bad();
  for(const check of c.checks){
    if(!object(check)||Object.keys(check).some(k=>!['args','assertions'].includes(k))||!Array.isArray(check.assertions)||!check.assertions.length||check.assertions.length>20||check.assertions.some(a=>!a||typeof a.path!=='string'||!a.path||!Object.hasOwn(a,'equals')))bad();
    validateCompletionCheckArgs(check.args);
  }
  // Assignment preflight uses metadata only; future outputs remain valid.
  // Completion inspection must still recheck size before reading later bytes.
  for(const output of c.outputs){
    let stat;
    try{stat=fs.lstatSync(output);}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(stat.size>256000)throw new Error('Completion contract output exceeds 256000 bytes; split larger reports into separately declared outputs: '+output);
  }
  return JSON.parse(JSON.stringify(c));
}
// Only host journal rows count. Nothing here executes a command or changes evidence.
export function inspectDelegatedCompletion({binding,run,rows,signal,requiredCompletion=false}){
  if(!binding)return requiredCompletion?{complete:false,hold:true,code:'completion_setup_hold',knownNonexecution:true,feedback:'NEW execution binding absent; setup review, no replay.'}:{complete:true};
  const hold=feedback=>({complete:false,hold:true,feedback,code:'protected_boundary'});
  if(signal?.aborted||run.status==='stopped')return hold('Owner stop retained; no continuation.');
  if(binding.runId!==run.id||binding.parentRun!==run.parent_run)return hold('Completion contract task/run binding mismatch.');
  if(rows.some(r=>r.run_id!==run.id||!String(r.id).startsWith(run.id+':')||['running','uncertain'].includes(r.state)||parse(r.result)?.denied))return hold('Uncertain, denied or mismatched journal evidence requires review; do not replay.');
  const missing=[],files=[];
  if([1,2].includes(binding.contract.version)){try{verifyOwned(binding.contract);verifyPins([...binding.contract.inputPins,...binding.contract.sourcePins,...(binding.contract.artifactPins||[])]);}catch(e){missing.push(e.message);}}
  let lastCheck=-1;
  const accepted=[];
  const successful=(r,check)=>{const v=parse(r?.result);return r?.state==='done'&&v?.pass===true&&v.exitCode===0&&!v.timedOut&&v.command?.executable&&check.assertions.every(a=>isDeepStrictEqual(at(v,a.path),a.equals));};
  const checks=binding.contract.checks;
  for(let n=0;n<checks.length;n++){
    const check=checks[n];
    const index=rows.findLastIndex(r=>r.name==='run_checks'&&isDeepStrictEqual(parse(r.args),check.args));
    if(index<0||!successful(rows[index],check))missing.push('Check '+n+': latest run_checks must succeed with exact args and assertions');
    else accepted.push(index);
    lastCheck=Math.max(lastCheck,index);
  }
  for(const output of binding.contract.outputs){
    try{
      const stat=fs.lstatSync(output);
      if(!stat.isFile()||stat.isSymbolicLink()||!stat.size||stat.size>256000)throw Error('regular nonempty UTF-8 artifact <=256000 bytes required; split larger reports into separately declared outputs');
      const bytes=fs.readFileSync(output),content=bytes.toString('utf8'),sha256=hash(bytes);files.push([output,sha256]);
      const readback=inspectCurrentReadback({rows,lastCheck,output,content,sha256,bytes:bytes.length});
      if(!readback.complete)missing.push('Read back current output after checks: '+output+
       '. Verified consecutive characters '+readback.coveredCharacters+'/'+readback.totalCharacters+
       '; next missing page: read_file '+JSON.stringify(readback.nextRead)+
       '. Continue from each returned nextOffset until hasMore is false; the first page alone is not complete. After any new check, restart readback at offset 0.');
    }catch(e){missing.push(output+': '+e.message);}
  }
  if(binding.contract.version===2)for(const i of accepted){
 const observation=parse(rows[i].result)?.freshOutputObservation;
 if(!observation||observation.runId!==run.id||observation.parentRun!==run.parent_run||observation.callId!==rows[i].id||observation.contractHash!==hash(JSON.stringify(binding.contract))||!isDeepStrictEqual(observation.files,files))missing.push('Host-observed successful execution on current output bytes required');
 }
  // A later modifying/executing action invalidates earlier successful checks.
  // Read-only inspection is allowed after checks. Conservative on unknown tools.
  const reads=new Set(['read_file','list_files','code_search','project_map','worker_result','tool_catalog','capabilities','update_plan']);
  // Successful required checks form a verification cohort. Other executions,
  // including failed checks, may have side effects and invalidate earlier checks.
  const lastMutation=rows.findLastIndex((r,i)=>!reads.has(r.name)&&!(r.name==='self_update'&&parse(r.args)?.action==='status'&&Object.keys(parse(r.args)||{}).every(k=>['action','snapshotId'].includes(k)))&&!accepted.includes(i));
  if(accepted.some(i=>i<lastMutation))missing.push('Fresh checks required after final modifying/executing action');
  return missing.length?{complete:false,code:'missing_evidence',feedback:missing.join('; '),contractFingerprint:hash(JSON.stringify({files,missing}))}:{complete:true,receipts:accepted.map(i=>rows[i].id),files};
}
export function delegatedCompletionDecision(input,state){
  const inspection=inspectDelegatedCompletion(input);
  // Reuse existing no-progress semantics without overwriting lifecycle state.
  const messages=[];
  for(const row of input.rows||[]){
    messages.push({role:'assistant',tool_calls:[{id:row.id,function:{name:row.name,arguments:row.args}}]},
      {role:'tool',tool_call_id:row.id,content:JSON.stringify({state:row.state,result:parse(row.result)})});
  }
  const local={messages,lifecycleCompletion:state.delegatedProgress};
  const result=completionDecision(inspection,local,{requestId:input.run.id,phase:'delegated'});
  state.delegatedProgress=local.lifecycleCompletion;
  state.delegatedEvidence=inspection;
  if(local.noProgress)state.noProgress=true;
  return result;
}
