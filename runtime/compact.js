import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fitInferenceMessages} from './inference-context.js';

// The caller owns the database transaction. Write the exact archive first, so a
// rollback or failed SQL update never destroys the source context.
export function compactConversation({query,botId,thread,dataDir,settings}){
  if(!Number.isSafeInteger(botId)||botId<1||thread!=='bot:'+botId)throw Object.assign(new Error('/compact is available in a worker chat.'),{statusCode:400});
  if(query("SELECT id FROM runs WHERE bot_id=? AND thread=? AND status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input') LIMIT 1").get(botId,thread))throw Object.assign(new Error('Wait for the current task to finish or pause before using /compact. Its work has not been interrupted.'),{statusCode:409});
  const history=query('SELECT messages FROM worker_history WHERE bot_id=? AND thread=?').get(botId,thread);
  const runs=query("SELECT id,checkpoint FROM runs WHERE bot_id=? AND thread=? AND status IN ('paused','interrupted') AND checkpoint IS NOT NULL").all(botId,thread);
  const view=messages=>JSON.stringify(fitInferenceMessages(JSON.parse(messages),{maxChars:settings.maxHistoryChars,maxToolChars:settings.maxToolChars}));
  const nextHistory=history&&view(history.messages);
  const nextRuns=runs.map(run=>{const state=JSON.parse(run.checkpoint);state.messages=JSON.parse(view(JSON.stringify(state.messages)));return{id:run.id,checkpoint:JSON.stringify(state)};});
  const changed=(history&&nextHistory!==history.messages)||nextRuns.some((run,i)=>run.checkpoint!==runs[i].checkpoint);
  if(!changed)return{changed:false,beforeCharacters:history?.messages.length||0,afterCharacters:nextHistory?.length||0};
  const archive={version:1,botId,thread,createdAt:new Date().toISOString(),history:history?.messages||null,runs};
  const text=JSON.stringify(archive),directory=path.join(dataDir,'bots',String(botId),'context-archives');fs.mkdirSync(directory,{recursive:true});
  const file=path.join(directory,randomUUID()+'.json');fs.writeFileSync(file,text,{flag:'wx',mode:0o600});
  if(history)query('UPDATE worker_history SET messages=?,updated_at=unixepoch() WHERE bot_id=? AND thread=?').run(nextHistory,botId,thread);
  for(const run of nextRuns)query('UPDATE runs SET checkpoint=? WHERE id=? AND bot_id=?').run(run.checkpoint,run.id,botId);
  return{changed:true,archive:file,sha256:createHash('sha256').update(text).digest('hex'),beforeCharacters:history?.messages.length||0,afterCharacters:nextHistory?.length||0,retainedCheckpoints:runs.length};
}
