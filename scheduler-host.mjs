// Host-owned opt-in lifecycle. Worker payloads cannot configure authority.
import {EventEmitter} from 'node:events';
import {registerPrivateScheduler} from './private-scheduler-api.mjs';
import {registerPrivateSchedulerHttp} from './private-scheduler-http.mjs';
export function schedulerHost({db,port,enabled=false,authorize,intervalMs=1000,onError=()=>{}}){
 if(!Number.isSafeInteger(intervalMs)||intervalMs<10)throw Error('invalid pump interval');
 // Disabled startup must not initialize any tables, PRAGMAs, port or jobs.
 if(enabled!==true){
  const denied=()=>{throw Error('scheduler_disabled');};
  return Object.freeze({api:Object.freeze({create:denied,tick:denied,recover:denied,observe:denied}),
   handler:async(req,res)=>{res.writeHead(403,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"denied"}');},
   start(){},async stop(){}});
 }
 let timer=null,pending=null,stopped=true;
 const api=registerPrivateScheduler({db,port,owner:'nimbus-owned'});
 const dedicated=new EventEmitter();
 registerPrivateSchedulerHttp(dedicated,{api,authorize:async req=>enabled===true&&typeof authorize==='function'&&await authorize(req)===true});
 const handler=dedicated.listeners('request')[0];
 async function pump(){
  if(stopped||pending)return pending;
  pending=(async()=>{
   for(const r of api.recover())if(r.action==='observe-or-hold')try{api.observe(r.occurrenceId);}catch(e){onError(e);}
   await api.tick();
  })().catch(onError).finally(()=>{pending=null;});
  return pending;
 }
 return Object.freeze({api,handler,
 start(){if(enabled!==true||!stopped)return;stopped=false;api.recover();timer=setInterval(()=>void pump(),intervalMs);timer.unref();void pump();},
 async stop(){stopped=true;if(timer)clearInterval(timer);timer=null;await pending;},
 });
}
