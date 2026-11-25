import {ensureCompletionSchema,bindCompletion,validateDispatch} from './completion-binding.js';
// Shared synchronous insertion. Caller owns transaction and post-commit enqueue.
export function insertQueuedRun(db,{botId,thread,prompt,depth=0,source='user',parentRun=null,quiet=false,originMessageId=null,originRequestId=null,completionDescriptor,completionOwnedRoot,delegationScope},sanitize=x=>x){
 ensureCompletionSchema(db);
 const contract=completionDescriptor===undefined?null:validateDispatch(db,parentRun,completionDescriptor,completionOwnedRoot);
 if(delegationScope!==undefined&&!['conversation','execution'].includes(delegationScope))throw new Error('Invalid delegated execution scope');
 const scope=delegationScope??(contract?'execution':'legacy');
 if(scope==='execution'&&!contract||scope==='conversation'&&contract)throw new Error('Delegation scope and completion descriptor disagree');
 if(scope==='conversation'){
  const parent=db.prepare('SELECT status FROM runs WHERE id=?').get(parentRun);
  if(!parent||!['running','routing'].includes(parent.status))throw new Error('Conversation dispatch needs its active parent');
 }
 db.exec('SAVEPOINT completion_insert');try{
 botId=Number(botId);
 if(!Number.isSafeInteger(botId)||!db.prepare('SELECT id FROM bots WHERE id=?').get(botId))throw new Error('Unknown worker');
 if(!/^(bot|room):\d+$/.test(thread)||!String(prompt).trim())throw new Error('A valid thread and task are required');
 if(parentRun){const parent=db.prepare('SELECT origin_message_id,origin_request_id FROM runs WHERE id=?').get(parentRun);originMessageId??=parent?.origin_message_id;originRequestId??=parent?.origin_request_id;}
 const id=Number(db.prepare('INSERT INTO runs (bot_id,thread,prompt,status,parent_run,source,quiet,depth,origin_message_id,origin_request_id,completion_required,delegation_scope) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(botId,thread,sanitize(prompt),'queued',parentRun,source,quiet?1:0,depth,originMessageId??null,originRequestId??null,contract?1:0,scope).lastInsertRowid);
 if(contract)bindCompletion(db,id,parentRun,contract);
 db.exec('RELEASE completion_insert');return id;
 }catch(e){db.exec('ROLLBACK TO completion_insert');db.exec('RELEASE completion_insert');throw e;}
}
