import {UncertainAction} from './action-error.js';
import {planRequests,serializeRequest,normalizeResponse} from './openbubbles-protocol.js';
// Identity capabilities are created only by host code, never deserialized from config/tool args.
const authorities=new WeakMap(),runs=new Map();
export function hostAuthority(dependencies){const token=Object.freeze({});authorities.set(token,dependencies);return token;}
export function isHostAuthority(token){return !!token&&authorities.has(token);}
export function attachHostRun(runId,token){if(!isHostAuthority(token))throw new Error('host authority required');runs.set(runId,token);}
export function runAuthority(runId){return runs.get(runId);}
export async function dispatchOpenBubbles(bot,args,{runId,signal,openBubblesAuthority}={}){
 const deps=authorities.get(openBubblesAuthority);
 if(!deps)throw new Error('OpenBubbles disabled');
 if(!JSON.parse(bot.tools||'[]').includes('openbubbles_operation'))throw new Error('Tool not enabled for this worker');
 const {store,reader,sink,stage,scratch}=deps,c=store.correlation(runId,bot.id);
 // Lumos runs may name local files; the host stages them as private content refs.
 if(args?.kind==='attachments'&&Array.isArray(args.files)&&typeof stage==='function')args={...args,files:args.files.map(f=>f&&typeof f.path==='string'&&!f.ref?stage(f.path,c):f)};
 const ledger=store.ledger(c);
 const plans=planRequests(args,{chat:c.chat,ledger});
 store.prepare(c,args.operationId,plans);const results=[];
 for(let chunk=0;chunk<plans.length;chunk++){
  let wire;
  try{signal?.throwIfAborted();wire=await serializeRequest(plans[chunk],reader,{signal,...(scratch?{scratch}:{})});}
  catch(e){store.cancel(c,args.operationId);throw e;}
  let attempt;
  try{attempt=store.claim(c,args.operationId,chunk);}catch(e){await wire.cleanup();throw e;}
  try{
   // Claim is durable before any effect; abort from here is conservatively uncertain.
   signal?.throwIfAborted();const ack=normalizeResponse(plans[chunk].kind,await sink(wire,{signal}));
   store.finish(c,args.operationId,chunk,attempt.epoch,ack.state,ack.nativeGuid);results.push({chunk,...ack});
  }catch(e){
   try{store.finish(c,args.operationId,chunk,attempt.epoch,'uncertain');}catch{}
   try{store.cancel(c,args.operationId);}catch{}
   throw new UncertainAction('OpenBubbles attempt needs review; no automatic replay',{operationId:args.operationId,chunk});
  }finally{await wire.cleanup();}
 }
 return {results};
}
