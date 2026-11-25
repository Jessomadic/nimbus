import {createHash} from 'node:crypto';
function semanticStatus(value){
  if(Array.isArray(value))return value.map(semanticStatus);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['observedAt','updatedAt','updated_at','elapsedMs','durationMs'].includes(key)).map(([key,item])=>[key,semanticStatus(item)]));
}
export function observeProgress(state,name,args,result,{childProgress=null,ownedChildWaiting=false}={}) {
  // Runner-authoritative passive waiting does not accumulate a loop exclusion.
  if(name==='worker_result'&&ownedChildWaiting)return;
  // JSON-safe checkpoint fields; only identical malformed read observations count.
  if(name==='read_file'&&result?.code==='missing_path'){
    const malformedFingerprint=createHash('sha256').update(JSON.stringify([args,result])).digest('hex');
    const previous=state.malformedReadStreak;
    state.malformedReadStreak={fingerprint:malformedFingerprint,count:previous?.fingerprint===malformedFingerprint?previous.count+1:1};
    if(state.malformedReadStreak.count>=3){
      state.noProgress=true;
      state.repairReason='Three identical malformed read_file requests returned missing_path. Inspect the checkpoint and supply an explicit valid file path; no automatic retry.';
      throw Object.assign(new Error(state.repairReason),{pause:true,code:'no_progress'});
    }
  }else{
    delete state.malformedReadStreak;
  }
  if(!Array.isArray(state.progressRecent))state.progressRecent=[];
  // Diagnostics are observations, not an error/action budget.
  const fingerprint=createHash('sha256').update(JSON.stringify([name,args,['team_status','worker_result'].includes(name)?semanticStatus(result):result,childProgress])).digest('hex');
  const recent=state.progressRecent||[];
  recent.push(fingerprint);state.progressRecent=recent.slice(-128);
  // Require three repetitions and at least 16 observations. Bounded history
  // recognizes periods up to 32 actions without treating unique errors as stalls.
  const history=state.progressRecent;
  let repeated=false;
  for(let period=1;period<=Math.min(32,Math.floor(history.length/3));period++){
    const length=Math.max(16,period*3);
    if(history.length<length)continue;
    let matches=true;
    for(let i=history.length-length+period;i<history.length;i++){
      if(history[i]!==history[i-period]){matches=false;break;}
    }
    if(matches){repeated=true;break;}
  }
  if(repeated){
    state.noProgress=true;
    throw Object.assign(new Error(name==='read_file'&&result?.code==='missing_path'?'Repeated malformed read_file calls without a valid path; supply an exact file path after checkpoint inspection. Checkpoint retained; no automatic retry.':'Repeated no-progress tool loop; checkpoint retained for inspection'),{pause:true,code:'no_progress'});
  }
}
export function taskTimeExceeded(workers,elapsed) {
  return workers.executionMode!=='progress' && elapsed>workers.timeoutMinutes*60000;
}
