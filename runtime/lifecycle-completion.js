import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
const sourceHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value);
const stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const volatile=new Set(['observedAt','updatedAt','updated_at','createdAt','startedAt','endedAt','elapsedMs','durationMs','duration_ms','pid','nextOffset','sessionId']);
function semantic(value){
  if(Array.isArray(value))return value.map(semantic);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!volatile.has(key)&&!(key==='id'&&('sessionId'in value||'pid'in value))).map(([key,item])=>[key,semantic(item)]));
  if(typeof value==='string')return value.replace(/(^|\n)([ \t]*(?:[#ℹ][ \t]*)?duration_ms(?::)?[ \t]+)[\d.]+/g,'$1$2[duration]').replace(/(^|\n)([✔✖].*) \([\d.]+ms\)(?=\n|$)/g,'$1$2 ([duration])');
  return value;
}
function decode(value){try{return JSON.parse(value);}catch{return value;}}
function sameReceiptPath(candidate,expected){
  if(typeof candidate!=='string'||typeof expected!=='string')return false;
  if(process.platform==='win32')return path.win32.isAbsolute(candidate)&&path.win32.isAbsolute(expected)&&path.win32.resolve(candidate).toLowerCase()===path.win32.resolve(expected).toLowerCase();
  return path.isAbsolute(candidate)&&path.isAbsolute(expected)&&path.resolve(candidate)===path.resolve(expected);
}

// Read-only contract inspection. This does not accept a lifecycle stage or edit
// evidence. A well-formed rejection is terminal even without approval fields.
export function inspectStageCompletion({request,stage,currentSourceHash,qaSourceHash}){
  let bytes,receipt;
  const incomplete=(code,feedback)=>({complete:false,code,feedback,receiptHash:bytes?digest(bytes):null,
    contractFingerprint:receipt?digest(stable({requestId:receipt.requestId,phase:receipt.phase,approved:receipt.approved,summaryValid:typeof receipt.summary==='string'&&!!receipt.summary.trim()&&receipt.summary.length<=4000,sourceHash:receipt.sourceHash,verification:receipt.verification})):null});
  try{
    const stat=fs.lstatSync(stage.artifact_path);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64000)return{...incomplete('unsafe_receipt','The receipt must be a regular JSON file no larger than 64 KB. Preserve the existing evidence and report the unsafe artifact.'),hold:true};
    bytes=fs.readFileSync(stage.artifact_path);
    receipt=JSON.parse(bytes.toString('utf8'));
  }catch(error){
    if(error.code==='ENOENT')return incomplete('missing_receipt','The required stage receipt has not been written. Finish the remaining actionable work and write the new receipt.');
    if(error instanceof SyntaxError)return incomplete('invalid_receipt','The stage receipt is not valid JSON. Preserve its content, correct its format and read it back.');
    return{...incomplete('receipt_unavailable','The required receipt could not be inspected: '+error.message),hold:true};
  }
  if(!receipt||receipt.requestId!==request.id||receipt.phase!==stage.phase||typeof receipt.approved!=='boolean'||typeof receipt.summary!=='string'||!receipt.summary.trim()||receipt.summary.length>4000)
    return incomplete('invalid_receipt','The receipt must match the assigned requestId and phase and contain approved:boolean and a nonempty summary of at most 4000 characters.');
  if(receipt.approved===false)return{complete:true,rejected:true,receiptHash:digest(bytes)};
  if(['testing','reviewing'].includes(stage.phase)){
    if(!sourceHash(receipt.sourceHash))return incomplete('missing_source_hash','The approved receipt needs the actual exact 64-hex host sourceHash at TOP LEVEL. Obtain current before/after source observations, complete checks on unchanged source, and write/read back your own fresh receipt. Never infer or backfill an older receipt.');
    if(!sourceHash(currentSourceHash)||receipt.sourceHash!==currentSourceHash)return incomplete('source_drift','Receipt provenance does not match the current source. Reinspect the candidate and repeat checks affected by source changes; do not reuse old approval or substitute a hash without fresh checks.');
    if(stage.phase==='reviewing'&&qaSourceHash!==receipt.sourceHash)return incomplete('qa_source_mismatch','Reviewer and current QA receipt source hashes differ. Report the source drift as a real rejection; do not overwrite QA evidence or approve mismatched source.');
  }
  if(stage.phase==='testing'){
    const v=receipt.verification;
    if(!v||!v.args||typeof v.args!=='object'||Array.isArray(v.args)||!Array.isArray(v.assertions)||!v.assertions.length||v.assertions.length>20||v.assertions.some(a=>!a||typeof a.path!=='string'||!a.path||a.path.length>500||!Object.hasOwn(a,'equals')))
      return incomplete('invalid_verification','The QA receipt needs one actual candidate invocation in verification.args and 1 to 20 direct-result path/equals assertions. Complete the smoke check and read back the JSON.');
  }
  return{complete:true,rejected:false,receiptHash:digest(bytes)};
}

// Count semantic evidence, not tool IDs, timestamps, repeated reads or prose.
// A second unfinished final with no new evidence is a loop, not a larger budget.
export function completionDecision(inspection,checkpoint,{requestId,phase,currentSourceHash,receiptPath}={}){
  if(inspection.complete)return{action:'complete',requestId,phase};
  if(inspection.hold)return{action:'hold',...inspection,requestId,phase};
  const calls=new Map(),evidence=new Set();
  for(const message of checkpoint.messages||[]){
    for(const call of message.tool_calls||[])calls.set(call.id,{name:call.function?.name,args:semantic(decode(call.function?.arguments||'{}'))});
    if(message.role==='tool'){
      const call=calls.get(message.tool_call_id);
      const ownReceipt=receiptPath&&['read_file','write_file'].includes(call?.name)&&sameReceiptPath(call?.args?.path,receiptPath);
      if(call&&!ownReceipt)evidence.add(stable({call,result:semantic(decode(message.content))}));
    }
  }
  const fingerprint=digest(stable({requestId,phase,currentSourceHash,code:inspection.code,receipt:inspection.contractFingerprint||inspection.receiptHash,evidence:[...evidence].sort()}));
  const prior=checkpoint.lifecycleCompletion;
  checkpoint.lifecycleCompletion={requestId,phase,fingerprint};
  if(prior?.requestId===requestId&&prior?.phase===phase&&prior?.fingerprint===fingerprint){
    checkpoint.noProgress=true;
    return{action:'hold',code:'no_progress',feedback:'The lifecycle stage returned incomplete again without new receipt or execution evidence. Its checkpoint and all results are retained for inspection.',requestId,phase};
  }
  return{action:'continue',code:inspection.code,requestId,phase,feedback:`Lifecycle completion check: ${inspection.feedback} This is continuation of the SAME stage and checkpoint. Completed results are evidence, not actions to replay. Do not force approval: preserve an actual rejection or report a concrete blocker. Finish available checks before returning; progress mode has no arbitrary action/time cap.`};
}
