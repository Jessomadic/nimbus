// Test-only entrypoint: holds admission, not lifecycle reconciliation.
// Waiting statuses are simulated; ownership is obtained through the real queue.
// No production bypass, listener, configuration flag, provider or tool execution.
import {workerSlots} from '../../runtime/slots.js';
for(let i=0;i<workerSlots.limit;i++)await workerSlots.acquire();
await import('../../server.js');
const {runBot,reconcileRunOwnership}=await import('../../runner.js');
const {q}=await import('../../db.js');
if(!process.send)throw Error('Context fixture requires IPC');
process.on('message',async({id,command,args})=>{
  try {
    let value;
    if(command==='seed'){
      if(!['waiting_approval','waiting_cloud','waiting_input','waiting_tool'].includes(args.status))throw Error('Unsupported fixture status');
      value=runBot({...args,prompt:'Keep the existing task'});
      // Let execute pass its queued-state guard and reach held admission.
      await new Promise(resolve=>setImmediate(resolve));
      q('UPDATE runs SET status=? WHERE id=?').run(args.status,value);
    }else if(command==='consume'){
      const {consumeRunContext}=await import('../../runtime/run-context.js');
      const state=JSON.parse(q('SELECT checkpoint FROM runs WHERE id=?').get(args.runId).checkpoint||'{"messages":[]}');
      value=consumeRunContext(args.runId,state);
    }else if(command==='reconcile')value=reconcileRunOwnership();
    else throw Error('Unsupported fixture command');
    process.send({id,value});
  }catch(error){process.send({id,error:error.message});}
});
