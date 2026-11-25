import {config,updateMcpScope} from '../../config.js';
import {policyView,policyHash} from '../../mcp-scope.js';
const ids={type:'array',uniqueItems:true,maxItems:1000,items:{type:'integer',minimum:1}};
const names={type:'array',uniqueItems:true,maxItems:1000,items:{type:'string',minLength:1,maxLength:100}};
const selector={type:'object',additionalProperties:false,properties:{workerIds:ids,templates:names,groups:names}};
const groups={type:'object',propertyNames:{pattern:'^[a-z][a-z0-9_-]{0,63}$'},additionalProperties:{type:'object',additionalProperties:false,properties:{workerIds:ids,templates:names}}};
const scope={type:'object',additionalProperties:false,required:['allow'],properties:{allow:selector,tools:{type:'object',additionalProperties:{type:'object',additionalProperties:false,minProperties:1,properties:{allow:selector,deny:selector}}}}};
export const tools=[{type:'function',function:{name:'mcp_connector_scope',description:'Inspect, validate or atomically replace MCP server scope and security groups. Set requires the current policy hash; absent scope retains legacy access. Does not connect servers or change credentials.',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['status','validate','set']},server:{type:'string',minLength:1,maxLength:200},scope,groups,expectedPolicyHash:{type:'string',pattern:'^[0-9a-f]{64}$'}}}}}];
// Consumer activation is host-owned after independent acceptance.
export const roleTools={};
export function execute(name,args={},ctx={}){
  if(name!=='mcp_connector_scope')throw new Error('Unknown scope tool');
  if(!JSON.parse(ctx.bot?.tools||'[]').includes(name))throw new Error('MCP scope management is not enabled for this worker');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['action','server','scope','groups','expectedPolicyHash'].includes(k)))throw new Error('Invalid scope input');
  if(!['status','validate','set'].includes(args.action))throw new Error('Invalid scope action');
  if(args.action==='status'){
    if(Object.keys(args).some(k=>!['action','server'].includes(k)))throw new Error('Status accepts only action and server');
    const c=config(),view=policyView(c);
    if(args.server!==undefined){if(typeof args.server!=='string'||!Object.hasOwn(view.servers,args.server))throw new Error('Unknown configured MCP server');view.servers={[args.server]:view.servers[args.server]};}
    return {supported:true,policyVersion:1,...view,policyHash:policyHash(c),legacyCompatibility:'Servers without scope retain legacy assignment access'};
  }
  if(typeof args.server!=='string'||args.scope===undefined)throw new Error('Server and scope are required');
  if(args.action==='validate'&&Object.hasOwn(args,'expectedPolicyHash'))throw new Error('Validate does not accept expectedPolicyHash');
  const result=updateMcpScope(args,args.action==='set');
  return args.action==='set'?{saved:true,policyHash:result.policyHash,server:args.server,scope:result.servers[args.server]}:{valid:true,candidatePolicyHash:result.policyHash};
}
