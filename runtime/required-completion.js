import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {validateCompletionContract} from './delegated-completion.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
const within=(r,p)=>{const x=path.relative(r,p);return x&&x!=='..'&&!x.startsWith('..'+path.sep)&&!path.isAbsolute(x);};
const fail=message=>{throw Object.assign(Error(message),{code:'completion_setup_hold',knownNonexecution:true,hold:true});};
export function verifyPins(pins){for(const p of pins){const s=fs.lstatSync(p.path);if(!s.isFile()||s.isSymbolicLink()||hash(fs.readFileSync(p.path))!==p.sha256)throw Error('Evidence pin mismatch: '+p.path);}}
export function verifyOwned(c){
 for(const output of c.outputs){
 if(!within(path.resolve(c.outputRoot),path.resolve(output)))throw Error('Output outside owned root');
 let p=path.resolve(output);while(true){try{if(fs.lstatSync(p).isSymbolicLink())throw Error('Linked output ancestor');}catch(e){if(e.code!=='ENOENT')throw e;}const next=path.dirname(p);if(next===p)break;p=next;}
 }
}
// Project only the validated task requirements into the child's assignment.
// This is guidance, not authority: terminal acceptance still reloads the immutable
// DB binding and actual journal evidence. Never serialize extra caller fields.
export function completionAssignmentContext(c){
 if(!c)return '';
 const pins=values=>values.map(({path,sha256})=>({path,sha256}));
 const requirements={version:c.version,outputRoot:c.outputRoot,inputPins:pins(c.inputPins),sourcePins:pins(c.sourcePins),outputs:c.outputs,
  ...(c.artifactPins?{artifactPins:pins(c.artifactPins)}:{}),
  steps:c.checks.map((check,index)=>({id:c.stepIds[index],check:{args:check.args,assertions:check.assertions}}))};
 return '\nNimbus required completion metadata (not additional permissions):\n'+JSON.stringify(requirements)+'\nCreate the declared outputs without changing pinned inputs or checker sources. Invoke run_checks with the exact declared arguments and satisfy its assertions. After the final check, read_file every declared output using its exact path. Later mutations require fresh checks. Return only after the required evidence exists; preserve any refusal, stop or uncertain-effect hold.';
}
export function compileRequiredCompletion(scope,d,ownedRoot){
 if(scope==='execution'&&ownedRoot&&(!d||!path.isAbsolute(d.outputRoot||'')||!within(path.resolve(ownedRoot),path.resolve(d.outputRoot))))fail('Output root must be strictly within target owned artifacts directory');
 if(scope==='conversation'){if(d!==undefined)fail('Conversation cannot carry execution proof');return undefined;}
 if(scope!=='execution')fail('Explicit executionScope required for NEW ask_worker');
 try{
 if(!d||![1,2].includes(d.version)||!path.isAbsolute(d.outputRoot)||!Array.isArray(d.steps)||!d.steps.length||new Set(d.steps.map(s=>s.id)).size!==d.steps.length)fail('Validated execution descriptor required');
 for(const s of d.steps)if(!/^[a-zA-Z0-9._-]+$/.test(s.id)||!s.check)fail('Fixed step IDs and exact checker required');
 for(const name of (d.version===2?['inputPins','sourcePins']:['inputPins','sourcePins','artifactPins']))if(!Array.isArray(d[name])||!d[name].length||d[name].some(p=>!path.isAbsolute(p.path)||!/^[a-f0-9]{64}$/.test(p.sha256)))fail('Explicit '+name+' required');
 if(d.version===2){
 if(d.artifactPins!==undefined)fail('Fresh outputs use outputs, not artifactPins');
 for(const s of d.steps){
 const a=s.check.args;
 if(a?.runner!=='node_test'||!Array.isArray(a.files)||!a.files.length)fail('Fresh outputs require explicit node_test files');
 for(const file of a.files)if(!d.sourcePins.some(p=>path.resolve(p.path)===path.resolve(a.path,file)))fail('Every checker entry must be source-pinned');
 }
 }
 const c={...validateCompletionContract({outputs:d.version===2?d.outputs:d.artifactPins.map(p=>p.path),checks:d.steps.map(s=>s.check)}),version:d.version,outputRoot:d.outputRoot,inputPins:d.inputPins,sourcePins:d.sourcePins,artifactPins:d.artifactPins,stepIds:d.steps.map(s=>s.id)};
 verifyOwned(c);verifyPins([...c.inputPins,...c.sourcePins]);return JSON.parse(JSON.stringify(c));
 }catch(e){fail(e.message);}
}
