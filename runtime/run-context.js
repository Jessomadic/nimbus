import {db,q} from '../db.js';
import crypto from 'node:crypto';
import {broadcast} from '../events.js';
import {redact} from '../redact.js';
import {checkpoint,event} from './journal.js';

// Only user-owned assignments in this exact chat receive implicit context.
export function contextTarget(botId,thread){
  return q(`SELECT id FROM runs WHERE bot_id=? AND thread=? AND parent_run IS NULL
    AND source IN ('user','the user')
    AND status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool')
    ORDER BY CASE status WHEN 'queued' THEN 2 WHEN 'waiting_tool' THEN 1 ELSE 0 END,id LIMIT 1`).get(botId,thread);
}

export function queueRunContext(runId,messageId,prompt,publish){
  q('INSERT INTO run_context(run_id,message_id,prompt) VALUES(?,?,?)').run(runId,messageId,redact(prompt));
  event(runId,'context.queued',{messageId},publish);
}

// Explicit owner delivery never selects another run or performs execution.
// Transaction-scoped notifications are released only after durable commit.
export function queueExplicitRunContext(id,input){
  const fail=(statusCode,message)=>{throw Object.assign(new Error(message),{statusCode});};
  if(!/^[1-9]\d*$/.test(String(id))||!Number.isSafeInteger(Number(id)))fail(400,'Exact positive run ID required');
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['text','requestId'].includes(k)))fail(400,'Only text and requestId are accepted; routing comes from the run');
  const {text,requestId}=input;
  if(typeof text!=='string'||!text.trim()||text.length>32000)fail(400,'Nonempty text of at most 32000 characters required');
  if(typeof requestId!=='string'||!requestId.trim()||requestId.length>200)fail(400,'Stable nonempty requestId of at most 200 characters required');
  const runId=Number(id),key='admin-run-context:'+requestId;
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify({runId,text})).digest('hex');
  const notifications=[];let message,replayed=false;
  db.exec('BEGIN IMMEDIATE');
  try{
    const prior=q('SELECT * FROM message_requests WHERE request_key=?').get(key);
    if(prior){
      if(prior.fingerprint!==fingerprint)fail(409,'requestId was used for different instructions or target');
      message=q('SELECT * FROM messages WHERE id=?').get(prior.message_id);
      if(!message)fail(409,'Retained request message is missing');
      replayed=true;
    }else{
      const run=q('SELECT * FROM runs WHERE id=?').get(runId);
      if(!run)fail(404,'Run not found');
      if(run.parent_run!==null||run.depth!==0||!['api','user','the user'].includes(run.source)||
        run.thread!=='bot:'+run.bot_id||!q('SELECT id FROM bots WHERE id=?').get(run.bot_id)||
        q('SELECT 1 FROM tool_development_stages WHERE run_id=?').get(runId))fail(409,'Target must be an ordinary top-level private-chat run');
      if(!['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool'].includes(run.status)||run.ended_at!==null)fail(409,'Run status is not eligible for context: '+run.status);
      let state;try{state=run.checkpoint?JSON.parse(run.checkpoint):null;}catch{fail(409,'Run checkpoint is invalid');}
      if(state?.noProgress)fail(409,'Run is stopped for no progress');
      const result=q("INSERT INTO messages(thread,author,kind,body,run_id) VALUES(?,'user','text',?,?)").run(run.thread,redact(text),runId);
      message=q('SELECT * FROM messages WHERE id=?').get(result.lastInsertRowid);
      notifications.push(['message',message]);
      queueRunContext(runId,message.id,text,(type,data)=>notifications.push([type,data]));
      q('INSERT INTO message_requests VALUES(?,?,?)').run(key,fingerprint,message.id);
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  for(const [type,data] of notifications)broadcast(type,data);
  return {...message,replayed};
}

// Save the cursor together with the canonical user input. A restart cannot
// acknowledge context without retaining it in the task's checkpoint.
export function consumeRunContext(runId,state){
  const rows=q('SELECT * FROM run_context WHERE run_id=? AND id>? ORDER BY id').all(runId,state.contextCursor||0);
  if(!rows.length)return [];
  for(const row of rows)state.messages.push({role:'user',content:row.prompt});
  state.contextCursor=rows.at(-1).id;
  checkpoint(runId,state);
  event(runId,'context.received',{messageIds:rows.map(row=>row.message_id)});
  return rows;
}
