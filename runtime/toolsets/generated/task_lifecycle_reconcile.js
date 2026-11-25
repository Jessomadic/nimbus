import {validateArguments} from '../../task-lifecycle-reconcile.js';
export const tools=[{type:'function',function:{name:'task_lifecycle_reconcile',description:'Preview selected task ownership or atomically reconcile proven orphans through the audited host lifecycle service. Unknown ownership blocks mutation.',parameters:{type:'object',additionalProperties:false,required:['action','runIds'],properties:{action:{type:'string',enum:['preview','reconcile']},runIds:{type:'array',minItems:1,maxItems:100,uniqueItems:true,items:{type:'integer',minimum:1}},previewToken:{type:'string',minLength:1,maxLength:256},reason:{type:'string',minLength:1,maxLength:2000}}}}}];
export const roleTools={orchestrator:['task_lifecycle_reconcile']};
export function execute(name,args,context={}) {
  context.signal?.throwIfAborted();
  if(name!=='task_lifecycle_reconcile')throw new Error('Unknown lifecycle tool');
  validateArguments(args);
  if(typeof context.taskLifecycleReconcile!=='function')throw new Error('Host lifecycle ownership service unavailable');
  return context.taskLifecycleReconcile({...args,runIds:[...args.runIds]});
}
