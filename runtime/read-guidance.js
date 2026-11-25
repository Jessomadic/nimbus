// Advisory data only. No cursor state, filesystem lookup, execution or retry.
export const missingPathGuidance={requiredFields:['path'],message:'Supply the exact file path on every read; no target can be inferred.'};
const valid=(v,s)=>s.type==='integer'?Number.isSafeInteger(v)&&v>=s.minimum&&(s.maximum===undefined||v<=s.maximum):s.type==='string'?typeof v==='string'&&(!s.enum||s.enum.includes(v))&&(!s.pattern||new RegExp(s.pattern).test(v)):false;
export function correctedReadArgs(name,args,properties){
 if(!args||typeof args!=='object'||Array.isArray(args))return;
 const corrected={...args};let changed=false;
 for(const [key,value] of Object.entries(args)){
  const s=properties[key];if(!s)return;
  if(valid(value,s))continue;
  if(!['offset','limit','maxChars'].includes(key)||s.type!=='integer'||!Number.isFinite(value)||!Number.isInteger(value))return;
  corrected[key]=Math.max(s.minimum,Math.min(s.maximum??Number.MAX_SAFE_INTEGER,value));changed=true;
 }
 if(!changed)return;
 if(name==='read_file'){
  if(typeof args.path!=='string'||!args.path.trim())return;
 }else if(name==='task_history'){
  if(args.runId!==undefined&&!valid(args.runId,properties.runId))return;
  if(args.view==='calls'){if(args.runId===undefined||args.callId!==undefined)return;}
  else if(typeof args.callId!=='string'||!args.callId||args.callId.length>256)return;
 }else return;
 return {tool:name,args:corrected};
}
export function historyReadValidation(args,properties){
 for(const key of ['offset','maxChars','limit']){
  if(args[key]===undefined)continue;
  const s=properties[key];
  if(valid(args[key],s))continue;
  // Keep the handler's existing range error; the journal already preserves evidence.
  const error=new Error(`Expected an integer from ${s.minimum} to ${s.maximum}`);
  const nextCall=correctedReadArgs('task_history',args,properties);
  error.evidence={readGuidance:{advisory:true,validRange:{field:key,minimum:s.minimum,maximum:s.maximum},...(nextCall?{nextCall}:{})}};
  throw error;
 }
}
export function historyPageGuidance(args,nextOffset){
 return {advisory:true,complete:nextOffset===null,message:nextOffset===null?'Archive pagination complete; this does not mean the task is complete.':'Use the returned cursor for the next archive page; do not repeat page zero.',...(nextOffset===null?{}:{nextCall:{tool:'task_history',args:{...args,offset:nextOffset}}})};
}
