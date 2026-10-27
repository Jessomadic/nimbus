export function toolRequestSummary(request){
  return{id:request.id,title:request.title,tool_name:request.tool_name,domain:request.domain,status:request.status,phase:request.phase,message:request.message,version:request.version,error:request.error,origin_run_id:request.origin_run_id,origin:request.origin,snapshot_id:request.snapshot_id,created_at:request.created_at,updated_at:request.updated_at,
    activation_state:request.activation_state,verification:request.activation_result?{pass:request.activation_result.pass,assertions:request.activation_result.assertions}:undefined,
    stages:(request.stages||[]).map(stage=>({role:stage.role||stage.phase,runId:stage.runId||stage.run_id,status:stage.status,phase:stage.phase,botId:stage.bot_id}))};
}
