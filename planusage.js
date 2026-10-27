import { cloudStatus } from './runtime/codex.js';
export async function getPlanUsage() {
  const state=await cloudStatus();
  if(!state.subscription)return{ok:false,error:state.error||'Sign in with ChatGPT using codex login.',windows:[]};
  const windows=[];
  for(const [index,w] of [state.limits?.rateLimits?.primary,state.limits?.rateLimits?.secondary].entries())if(w){
    windows.push({label:w.windowDurationMins===10080?'Weekly limit':w.windowDurationMins===300?'5-hour limit':`${w.windowDurationMins}-minute limit`,used:w.usedPercent,resets:w.resetsAt?new Date(w.resetsAt*1000).toISOString():null});
  }
  return{ok:true,plan:state.plan,windows,subscription:true};
}
