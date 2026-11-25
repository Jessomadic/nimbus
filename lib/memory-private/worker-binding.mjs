import {createPrivateRouter} from './routing.mjs';
let dispatch=null;
export function configureMemoryWorkers({ownerId,pins,enabled,workerAllowed,scopes}){
 const live=new WeakSet();
 const authorize=(p,s)=>live.has(p)&&enabled()&&workerAllowed(p.botId,p.runId)&&scopes.includes(s);
 const route=createPrivateRouter({pins,authorize,resolvePrincipal:p=>p});
 dispatch=(botId,runId,args)=>{const p={ownerId,botId,runId};live.add(p);try{return route(p,'recall',args);}finally{live.delete(p);}};
}
export function workerRecall(botId,runId,args){if(!dispatch)throw Error('FORBIDDEN');return dispatch(botId,runId,args);}
