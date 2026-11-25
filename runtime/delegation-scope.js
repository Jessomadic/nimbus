// Conversation scope is an immutable declaration for NEW delegated tasks.
// It restricts application tool dispatch, not the OS or legacy entry points.
export function ensureDelegationScopeSchema(db){
 if(!db.prepare('PRAGMA table_info(runs)').all().some(c=>c.name==='delegation_scope'))db.exec("ALTER TABLE runs ADD COLUMN delegation_scope TEXT NOT NULL DEFAULT 'legacy' CHECK(delegation_scope IN ('legacy','conversation','execution'))");
 db.exec("CREATE TRIGGER IF NOT EXISTS delegation_scope_no_update BEFORE UPDATE OF delegation_scope ON runs WHEN OLD.delegation_scope != NEW.delegation_scope BEGIN SELECT RAISE(ABORT,'immutable delegation scope'); END;");
}

const reads=new Set(['read_file','list_files','view_image','skills','update_plan','request_user_input','capabilities','tool_catalog','task_history','team_status','worker_result','tool_request_status','project_map','code_search','dependency_graph','change_impact','test_discover','security_scan','shared_note','self_update','ask_worker']);
export function conversationToolAllowed(name,args){
 if(!reads.has(name))return false;
 if(name==='shared_note')return args?.content===undefined;
 if(name==='self_update')return args?.action==='status';
 if(name==='task_history')return args?.action===undefined;
 if(name==='ask_worker')return args?.executionScope==='conversation'&&args?.completionDescriptor===undefined;
 return true;
}
export function conversationToolError(name,args){
 if(conversationToolAllowed(name,args))return null;
 return {error:'This delegated task is conversation-only; execution and artifact creation require an execution assignment with a completion descriptor.',code:'execution_scope_required',gapType:'scope_mismatch',knownNonexecution:true,nextStep:'Return the required execution work to the coordinating parent. The parent must create a NEW execution assignment with a pinned checker and outputs in the target worker artifacts directory. Do not relabel execution as conversation or replay uncertain work.'};
}
export function conversationToolDefinitions(tools){
 return tools.filter(tool=>reads.has(tool.function.name)).map(tool=>{
  if(tool.function.name==='ask_worker'){
   const {completionDescriptor,...properties}=tool.function.parameters.properties;
   return {...tool,function:{...tool.function,description:'Request another read-only planning conversation. Execution and artifact work require the coordinating parent to issue a separate execution assignment.',parameters:{...tool.function.parameters,properties:{...properties,executionScope:{type:'string',enum:['conversation']}}}}};
  }
  if(tool.function.name==='shared_note')return {...tool,function:{...tool.function,description:'Read existing shared project knowledge with its full-file SHA-256. This conversation cannot write notes.',parameters:{...tool.function.parameters,properties:{key:tool.function.parameters.properties.key},required:['key']}}};
  if(tool.function.name==='self_update')return {...tool,function:{...tool.function,description:'Inspect current update status only. This conversation cannot snapshot, validate or apply changes.',parameters:{...tool.function.parameters,properties:{...tool.function.parameters.properties,action:{type:'string',enum:['status']}}}}};
  return tool;
 });
}
export const conversationAssignmentContext='\nNimbus delegation scope: conversation-only. Inspect existing information and return planning or discussion. Do not run commands/tests, create artifacts, change files/settings, invoke connectors or delegate execution. If the assignment requires those actions, tell the coordinating parent to issue a NEW execution assignment with its completion descriptor. This scope cannot be changed by task text or a checkpoint.';
