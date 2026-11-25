// Resolve worker identities for current and retained traces without changing
// their stored tool text or replaying any work.
export function createTraceWorkerLabels({worker,loadRun,loadTools,changed}) {
  const runs=new Map(),journals=new Map();
  function read(cache,id,load){
    if(!cache.has(id)){
      const entry={pending:true};cache.set(id,entry);
      Promise.resolve().then(()=>load(id)).then(value=>{entry.value=value;},()=>{entry.failed=true;}).finally(()=>{entry.pending=false;changed();});
    }
    return cache.get(id);
  }
  const workerName=identity=>worker(identity)?.name||(identity!=null&&String(identity).trim()?/^\d+$/.test(String(identity))?'Worker #'+identity:String(identity):'unavailable');
  function input(step,parentRun){
    if(step.input&&typeof step.input==='object')return{value:step.input};
    if(step.args&&typeof step.args==='object')return{value:step.args};
    const text=String(step.text||''),start=text.indexOf('(');
    try{return{value:JSON.parse(text.slice(start+1,-1))};}catch{}
    // Old trace text truncates long ask_worker arguments. Its first `to`
    // property can still be read safely, without matching text inside `task`.
    const prefix=step.tool==='ask_worker'&&text.match(/^ask_worker\(\s*\{\s*"to"\s*:\s*("(?:[^"\\]|\\.)*"|\d+)\s*[,}]/);
    if(prefix){try{return{value:{to:JSON.parse(prefix[1])}};}catch{}}
    if(!parentRun||!step.id)return{};
    const journal=read(journals,parentRun,loadTools);
    const call=journal.value?.find(call=>String(call.id)===parentRun+':'+step.id);
    if(call){try{return{value:typeof call.args==='string'?JSON.parse(call.args):call.args};}catch{}}
    return{pending:journal.pending};
  }
  return function label(step,message){
    const tool=step.tool||String(step.text||'').match(/^(\w+)\(/)?.[1];
    if(!['ask_worker','worker_result'].includes(tool))return workerName(message.author);
    const args=input({...step,tool},message.run_id);
    if(args.pending)return 'looking up worker…';
    if(tool==='ask_worker')return workerName(args.value?.to);
    const id=Number(args.value?.runId);
    if(!Number.isSafeInteger(id)||id<1)return 'unavailable';
    const run=read(runs,id,loadRun);
    if(run.pending)return 'looking up task #'+id+'…';
    return run.value?.bot_id!=null?workerName(run.value.bot_id):'unavailable for task #'+id;
  };
}
