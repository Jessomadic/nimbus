import {createPrivateRouter} from './routing.mjs';
let dispatch=null;
export function configureMemoryWorkers({ownerId,pins,enabled,workerAllowed,scopes}){
 const live=new WeakSet();
 const authorize=(p,s)=>live.has(p)&&enabled()&&workerAllowed(p.botId,p.runId)&&scopes.includes(s);
 const route=createPrivateRouter({pins,authorize,resolvePrincipal:p=>p});
 dispatch=(botId,runId,args)=>{
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('INVALID_ARGUMENTS');
 const {operation='recall',...payload}=args;
 if(!['get','search','recall'].includes(operation))throw Error('OPERATION_DISABLED');
 const p={ownerId,botId,runId};live.add(p);try{return route(p,operation,payload);}finally{live.delete(p);}};
}
export function workerRecall(botId,runId,args){if(!dispatch)throw Error('FORBIDDEN');return dispatch(botId,runId,args);}
