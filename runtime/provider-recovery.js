import {createHash} from 'node:crypto';

const held=()=>Object.assign(new Error('The retained provider or model changed. Recovery is held; no fallback was attempted.'),{pause:true,code:'provider_recovery_route_changed'});
export function assertRecoveryRoute(recovery,{model,backend,provider,fallback=false}){
  if(!recovery)return;
  if(recovery.code!=='provider_inference_silence'||recovery.backend!==backend||recovery.provider!==provider||recovery.model!==model||fallback)throw held();
}
export function recoverySelection(bot){
  return {model:bot.model||bot.runtime||'',defaultModel:bot.default_model||'',effort:bot.effort||''};
}
export function retainedRecoveryRoute(recovery,route,selection){
  if(!route||!(recovery.backend==='codex'&&recovery.provider==='openai'||recovery.backend==='claude'&&recovery.provider==='anthropic')||!recovery.selection||
    Object.keys(selection).some(key=>recovery.selection[key]!==selection[key]))throw held();
  // Use the retained route instead of asking a possibly different routing model.
  // An earlier fallback is historical evidence, not permission for another one.
  return {...route,reason:'Resuming the retained provider and model after inference silence',fallbackReason:undefined,fallbackFrom:undefined};
}

const volatile=/^(?:id|callId|sessionId|timestamp|at|startedAt|finishedAt|endedAt|duration|durationMs|elapsedMs)$/i;
function stable(value){
  if(Array.isArray(value))return value.map(stable);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(key=>!volatile.test(key)).map(key=>[key,stable(value[key])]));
  return value;
}
const output=value=>String(value||'').replace(/^\s*(?:duration_ms:\s*[\d.]+|# duration_ms\s+[\d.]+)\s*$/gm,'').trim();
export function recoveryFingerprint({run,state,query}){
  const receipts=[];
  const rows=query("SELECT name,args,result FROM tool_calls WHERE run_id=? AND state='done'").all(run.id);
  for(const row of rows){
    try{
      const args=JSON.parse(row.args),value=JSON.parse(row.result),name=row.name.replace(/^nimbus(?:__|[._])/,'');
      if(!value||value.error||value.denied||value.uncertain)continue;
      if(name==='worker_result'){
        const id=Number(value.id),child=Number.isSafeInteger(id)&&query('SELECT id,parent_run,status FROM runs WHERE id=?').get(id);
        if(child?.parent_run===run.id&&child.status==='done'&&value.status==='done'&&
          (value.completion?.outputCaptureRecorded===true||typeof value.reply==='string'&&value.reply.trim()))
          receipts.push(JSON.stringify(['worker_result',id,value.reply||'',value.completion?.outputCaptureRecorded===true]));
        continue;
      }
      if(['read_file','write_file'].includes(name)&&/^[a-f0-9]{64}$/.test(value.sha256||'')){
        receipts.push(JSON.stringify([name,stable(args),value.path||args.path,value.sha256]));continue;
      }
      if(['run_checks','shell','exec_command','write_stdin'].includes(name)&&Number.isInteger(value.exitCode)&&
        (typeof value.stdout==='string'||typeof value.output==='string')){
        receipts.push(JSON.stringify([name,stable(args),stable(value.command||{}),value.exitCode,output(value.stdout??value.output),output(value.stderr)]));
      }
      // Planning, status polling and dispatch acknowledgements cannot renew a
      // retry. A completed child's stable outcome is coordinator progress.
    }catch{/* Invalid or incomplete evidence cannot renew recovery. */}
  }
  // Host continuations and model-authored prose are not new owner instructions.
  // Only context rows delivered through the trusted input path can renew work.
  const instructions=query(`SELECT c.prompt FROM run_context c JOIN messages m ON m.id=c.message_id
    WHERE c.run_id=? AND c.id<=? AND m.run_id=c.run_id AND m.author='user' AND m.kind='text' ORDER BY c.id`).all(run.id,Number(state.contextCursor)||0).map(row=>row.prompt);
  return createHash('sha256').update(JSON.stringify([run.backend,run.actual_model,[...new Set(receipts)].sort(),[...new Set(instructions)]])).digest('hex');
}
