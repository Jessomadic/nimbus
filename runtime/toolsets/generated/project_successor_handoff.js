// This adapter cannot mint host authority. The runner must inject a scoped service.
export const tools = [{type:'function',function:{
  name:'project_successor_handoff',
  description:'Reserve, inspect or cancel an owner-authorized durable postrestart project handoff. Does not authorize successors or adopt requests.',
  parameters:{type:'object',additionalProperties:false,required:['action','reservationId'],properties:{
    action:{type:'string',enum:['reserve','status','cancel']},
    reservationId:{type:'string',minLength:1,maxLength:200,pattern:'^[a-zA-Z0-9._:-]+$'},
    expectedCheckpointHash:{type:'string',pattern:'^[a-f0-9]{64}$'},
    reason:{type:'string',maxLength:2000}
  }}
}}];
export const roleTools={orchestrator:['project_successor_handoff']};
export function execute(name,args,context={}){
  context.signal?.throwIfAborted();
  if(name!=='project_successor_handoff')throw new Error('Unknown handoff tool');
  if(!args||typeof args!=='object'||Array.isArray(args)||
    Object.keys(args).some(k=>!['action','reservationId','expectedCheckpointHash','reason'].includes(k))||
    !['reserve','status','cancel'].includes(args.action)||
    typeof args.reservationId!=='string'||args.reservationId.length>200||!/^[a-zA-Z0-9._:-]+$/.test(args.reservationId)||
    (args.expectedCheckpointHash!==undefined&&(typeof args.expectedCheckpointHash!=='string'||!/^[a-f0-9]{64}$/.test(args.expectedCheckpointHash)))||
    (args.reason!==undefined&&(typeof args.reason!=='string'||args.reason.length>2000)))
    throw new Error('Invalid handoff arguments');
  if(args.action==='reserve'&&!args.expectedCheckpointHash)throw new Error('reserve requires expectedCheckpointHash');
  if(typeof context.projectSuccessorHandoff!=='function')throw new Error('Host-owned project successor handoff service is unavailable');
  // Copy only schema fields; never forward caller-provided owner/run/worker fields.
  return context.projectSuccessorHandoff({...args});
}
