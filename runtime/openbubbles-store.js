import {createHash} from 'node:crypto';
import {normalizeEvent,fileMetadata,MAX_FILE} from './openbubbles-protocol.js';
import {randomUUID} from 'node:crypto';
const receiptHash=({chat,sequence,target,kind})=>hash({chat,sequence,target,kind});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const fail=m=>{throw new Error(m)};
export const OB_SCHEMA=`
PRAGMA busy_timeout=5000;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS ob_binding(id TEXT,generation INTEGER,owner TEXT,chat TEXT,bot_id INTEGER,cursor INTEGER DEFAULT 0,PRIMARY KEY(id,generation));
CREATE TABLE IF NOT EXISTS ob_topic(binding TEXT,generation INTEGER,topic TEXT,thread TEXT,PRIMARY KEY(binding,generation,topic));
CREATE TABLE IF NOT EXISTS ob_inbox(binding TEXT,generation INTEGER,sequence INTEGER,guid TEXT,hash TEXT,topic TEXT,run_id INTEGER,kind TEXT,payload TEXT,PRIMARY KEY(binding,generation,sequence));
CREATE UNIQUE INDEX IF NOT EXISTS ob_request_guid ON ob_inbox(binding,generation,guid) WHERE kind='text';
CREATE TABLE IF NOT EXISTS ob_outbox(binding TEXT,generation INTEGER,operation TEXT,chunk INTEGER,run_id INTEGER,topic TEXT,hash TEXT,plan TEXT,state TEXT,epoch INTEGER DEFAULT 0,native_guid TEXT,PRIMARY KEY(binding,generation,operation,chunk));
CREATE TABLE IF NOT EXISTS ob_review(binding TEXT,generation INTEGER,operation TEXT,chunk INTEGER,epoch INTEGER,decision TEXT,reviewer TEXT,evidence TEXT,PRIMARY KEY(binding,generation,operation,chunk,epoch));
CREATE TABLE IF NOT EXISTS ob_receipt(binding TEXT,generation INTEGER,sequence INTEGER,target TEXT,kind TEXT,hash TEXT,PRIMARY KEY(binding,generation,sequence));
CREATE TABLE IF NOT EXISTS ob_quarantine(id INTEGER PRIMARY KEY,binding TEXT,generation INTEGER,sequence INTEGER,payload_hash TEXT,category TEXT);
CREATE TABLE IF NOT EXISTS ob_review_note(id INTEGER PRIMARY KEY,binding TEXT,generation INTEGER,operation TEXT,chunk INTEGER,epoch INTEGER,reviewer TEXT,evidence TEXT);
CREATE TABLE IF NOT EXISTS ob_projection(run_id INTEGER PRIMARY KEY,result_hash TEXT,state TEXT,correlation TEXT);
CREATE TABLE IF NOT EXISTS ob_projection_resolution(run_id INTEGER PRIMARY KEY,previous_hash TEXT,result_hash TEXT,message_id INTEGER);
CREATE TABLE IF NOT EXISTS ob_content(ref TEXT PRIMARY KEY,binding TEXT,generation INTEGER,topic TEXT,sequence INTEGER,run_id INTEGER,sha256 TEXT,bytes BLOB);
`;
export class OpenBubblesStore{
 constructor(db,createRun,{syntheticInboundReader}={}){this.db=db;this.createRun=createRun;this.inboundReader=syntheticInboundReader;db.exec(OB_SCHEMA);}
 // Host-only synchronous fixture reader. No network fallback or production downloader.
 materialize(e,id,g,topic){
  for(const a of e.attachments){
   if(a.disposition==='unsupported')continue;
   a.disposition='pending';if(!this.inboundReader)continue;
   try{
    if(typeof a.id!=='string'||!a.id)fail('attachment identity required');
    const ref=randomUUID(),meta=fileMetadata({...a,ref,sha256:'0'.repeat(64)});
    const parts=[];let size=0;
    for(const chunk of this.inboundReader(Object.freeze({binding:id,generation:g,topic,sequence:e.sequence,id:a.id}))){
     if(!(chunk instanceof Uint8Array))fail('byte chunks required');size+=chunk.byteLength;
     if(size>meta.size||size>MAX_FILE)fail('inbound overflow');parts.push(Buffer.from(chunk));
    }
    if(size!==meta.size)fail('inbound length mismatch');
    const bytes=Buffer.concat(parts),sha256=createHash('sha256').update(bytes).digest('hex');
    this.q('INSERT INTO ob_content VALUES(?,?,?,?,?,NULL,?,?)').run(ref,id,g,topic,e.sequence,sha256,bytes);
    Object.assign(a,{ref,sha256,disposition:'materialized'});
   }catch{a.disposition='error';}
  }
 }
 readContent(runId,botId,ref){
  const c=this.correlation(runId,botId),r=this.q('SELECT * FROM ob_content WHERE ref=?').get(ref);
  if(!r||r.run_id!==runId||r.binding!==c.binding||r.generation!==c.generation||r.topic!==c.topic)fail('content ownership');
  const bytes=Buffer.from(r.bytes);if(createHash('sha256').update(bytes).digest('hex')!==r.sha256)fail('content integrity');return bytes;
 }
 q(sql){return this.db.prepare(sql);}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 bind({id,generation,owner,chat,botId}){
  if(!id||!owner||!chat||!Number.isSafeInteger(generation)||generation<1||!this.q('SELECT id FROM bots WHERE id=?').get(botId))fail('invalid host binding');
  const old=this.q('SELECT * FROM ob_binding WHERE id=? AND generation=?').get(id,generation);
  if(old){if(old.owner!==owner||old.chat!==chat||old.bot_id!==botId)fail('immutable binding');return;}
  this.q('INSERT INTO ob_binding(id,generation,owner,chat,bot_id) VALUES(?,?,?,?,?)').run(id,generation,owner,chat,botId);
 }
 binding(id,g){const b=this.q('SELECT * FROM ob_binding WHERE id=? AND generation=?').get(id,g);if(!b||this.q('SELECT MAX(generation) g FROM ob_binding WHERE id=?').get(id).g!==g)fail('stale binding');return b;}
 ingest(id,g,topic,raw,{beforeCommit}={}){
  try{return this.tx(()=>{
   const b=this.binding(id,g),e=normalizeEvent(raw,b),digest=hash({raw,topic});
   if(['accepted','apnsConfirmed','delivered','read'].includes(e.kind)){
    if(!e.target)fail('receipt target required');
    const rh=receiptHash({chat:b.chat,...e}),prior=this.q('SELECT hash FROM ob_receipt WHERE binding=? AND generation=? AND sequence=?').get(id,g,e.sequence);
    if(prior&&prior.hash!==rh){const error=new Error('receipt conflict');error.receiptDigest=rh;throw error;}
   }
   if(typeof topic!=='string'||!topic||topic.length>128)fail('invalid topic');
   const old=this.q("SELECT * FROM ob_inbox WHERE binding=? AND generation=? AND (sequence=? OR (kind='text' AND guid=?))").get(id,g,e.sequence,e.kind==='text'?e.guid:null);
   if(old){if(old.hash!==digest)fail('duplicate conflict');return this.identity(old);}
   if(e.sequence!==b.cursor+1)fail('sequence gap');
   let runId=null;
   if(e.kind==='text'){
    let t=this.q('SELECT * FROM ob_topic WHERE binding=? AND generation=? AND topic=?').get(id,g,topic);
    if(!t){const room=Number(this.q('INSERT INTO rooms(name,lead_bot_id,bots_can_talk) VALUES(?,?,0)').run('Private integration topic',b.bot_id).lastInsertRowid);this.q('INSERT INTO room_members(room_id,bot_id) VALUES(?,?)').run(room,b.bot_id);t={thread:'room:'+room};this.q('INSERT INTO ob_topic VALUES(?,?,?,?)').run(id,g,topic,t.thread);}
    this.materialize(e,id,g,topic);
    const context=e.attachments.length?'\n[Private inbound attachments: '+JSON.stringify(e.attachments)+']':'';
    runId=this.createRun({botId:b.bot_id,thread:t.thread,prompt:(e.text||'[Attachment metadata received]')+context,source:'openbubbles',originRequestId:'ob:'+hash([id,g,e.sequence])});
    this.q('UPDATE ob_content SET run_id=? WHERE binding=? AND generation=? AND sequence=?').run(runId,id,g,e.sequence);
    if(e.attachments.some(a=>a.disposition!=='materialized'))this.q("UPDATE runs SET status='needs_review' WHERE id=?").run(runId);
   }
   this.q('INSERT INTO ob_inbox VALUES(?,?,?,?,?,?,?,?,?)').run(id,g,e.sequence,e.guid,digest,topic,runId,e.kind,JSON.stringify(e));
   if(['accepted','apnsConfirmed','delivered','read'].includes(e.kind)){
    if(!e.target)fail('receipt target required');
    this.q('INSERT OR IGNORE INTO ob_receipt VALUES(?,?,?,?,?,?)').run(id,g,e.sequence,e.target,e.kind,receiptHash({chat:b.chat,...e}));
   }
   this.q('UPDATE ob_binding SET cursor=? WHERE id=? AND generation=?').run(e.sequence,id,g);
   beforeCommit?.();return this.identity({binding:id,generation:g,topic,run_id:runId});
  });}catch(error){if(error.receiptDigest)this.q('INSERT INTO ob_quarantine(binding,generation,sequence,payload_hash,category) VALUES(?,?,?,?,?)').run(id,g,raw.sequence,error.receiptDigest,'receipt_conflict');throw error;}
 }
 identity(row){return {runId:row.run_id,topic:row.topic,thread:row.run_id?this.q('SELECT thread FROM runs WHERE id=?').get(row.run_id).thread:null};}
 correlation(runId,botId){
  const run=this.q('SELECT * FROM runs WHERE id=?').get(runId);if(!run||run.bot_id!==botId)fail('run ownership');
  let root=run;const seen=new Set();
  while(root.parent_run){if(seen.has(root.id))fail('parent cycle');seen.add(root.id);root=this.q('SELECT * FROM runs WHERE id=?').get(root.parent_run);if(!root)fail('missing parent');}
  const i=this.q("SELECT * FROM ob_inbox WHERE run_id=? AND kind='text'").get(root.id);if(!i)fail('unbound run');
  const b=this.binding(i.binding,i.generation);
  if(b.bot_id!==botId||run.thread!==root.thread)fail('run ownership');
  return {binding:i.binding,generation:i.generation,topic:i.topic,runId,chat:b.chat,botId};
 }
 ledger(c){
  const own=this.q("SELECT native_guid AS guid,plan FROM ob_outbox WHERE binding=? AND generation=? AND state='submitted' AND native_guid IS NOT NULL").all(c.binding,c.generation).map(r=>({guid:r.guid,chat:c.chat,ownText:JSON.parse(r.plan).kind==='text'}));
  const inbound=this.q("SELECT guid FROM ob_inbox WHERE binding=? AND generation=? AND kind='text'").all(c.binding,c.generation).map(r=>({guid:r.guid,chat:c.chat,ownText:false}));
  return [...own,...inbound];
 }
 prepare(c,operation,plans){
  const trusted=this.correlation(c.runId,c.botId);if(hash(trusted)!==hash(c))fail('correlation mismatch');
  return this.tx(()=>plans.map((plan,chunk)=>{
   const digest=hash({c,plan}),old=this.q('SELECT * FROM ob_outbox WHERE binding=? AND generation=? AND operation=? AND chunk=?').get(c.binding,c.generation,operation,chunk);
   if(old){if(old.hash!==digest)fail('operation conflict');return old;}
   this.q("INSERT INTO ob_outbox(binding,generation,operation,chunk,run_id,topic,hash,plan,state) VALUES(?,?,?,?,?,?,?,?,'queued')").run(c.binding,c.generation,operation,chunk,c.runId,c.topic,digest,JSON.stringify(plan));
   return this.row(c,operation,chunk);
  }));
 }
 row(c,op,chunk){return this.q('SELECT * FROM ob_outbox WHERE binding=? AND generation=? AND operation=? AND chunk=?').get(c.binding,c.generation,op,chunk);}
 claim(c,op,chunk){
  return this.tx(()=>{
   this.binding(c.binding,c.generation);
   if(this.q("SELECT 1 FROM ob_outbox WHERE binding=? AND generation=? AND state IN ('dispatching','uncertain')").get(c.binding,c.generation))fail('effect lane needs review');
   const r=this.q("UPDATE ob_outbox SET state='dispatching',epoch=epoch+1 WHERE binding=? AND generation=? AND operation=? AND chunk=? AND run_id=? AND state='queued'").run(c.binding,c.generation,op,chunk,c.runId);
   if(!r.changes)fail('no automatic replay');return this.row(c,op,chunk);
  });
 }
 finish(c,op,chunk,epoch,state,guid=null){
  const r=this.q("UPDATE ob_outbox SET state=?,native_guid=? WHERE binding=? AND generation=? AND operation=? AND chunk=? AND epoch=? AND state='dispatching'").run(state,guid,c.binding,c.generation,op,chunk,epoch);
  if(!r.changes)fail('attempt conflict');
 }
 recover(){this.q("UPDATE ob_outbox SET state='uncertain' WHERE state='dispatching'").run();}
 cancel(c,op){this.q("UPDATE ob_outbox SET state='cancelled' WHERE binding=? AND generation=? AND operation=? AND run_id=? AND state='queued'").run(c.binding,c.generation,op,c.runId);}
 review(c,op,chunk,epoch,{decision,reviewer,evidence,nativeGuid}){
  if(decision==='inconclusive')return this.tx(()=>{const row=this.row(c,op,chunk);if(!row||row.state!=='uncertain'||row.epoch!==epoch||!reviewer||!evidence)fail('review conflict');this.q('INSERT INTO ob_review_note(binding,generation,operation,chunk,epoch,reviewer,evidence) VALUES(?,?,?,?,?,?,?)').run(c.binding,c.generation,op,chunk,epoch,reviewer,evidence);return {state:'uncertain'};});
  if(!['submitted','not_submitted','abandoned'].includes(decision)||!reviewer||!evidence||(decision==='submitted'&&!nativeGuid))fail('review evidence required');
  return this.tx(()=>{
   const r=this.q("UPDATE ob_outbox SET state=?,native_guid=? WHERE binding=? AND generation=? AND operation=? AND chunk=? AND epoch=? AND state='uncertain'").run(decision,nativeGuid||null,c.binding,c.generation,op,chunk,epoch);
   if(!r.changes)fail('review conflict');
   this.q('INSERT INTO ob_review VALUES(?,?,?,?,?,?,?,?)').run(c.binding,c.generation,op,chunk,epoch,decision,reviewer,evidence);
  });
 }
 receipt(id,g,{chat,sequence,target,kind}){
  const outcome=this.tx(()=>{const b=this.binding(id,g);if(chat!==b.chat||!Number.isSafeInteger(sequence)||sequence<1||!target||!['accepted','apnsConfirmed','delivered','read'].includes(kind))fail('unauthorized receipt');
   const digest=receiptHash({chat,sequence,target,kind}),old=this.q('SELECT hash FROM ob_receipt WHERE binding=? AND generation=? AND sequence=?').get(id,g,sequence);
   if(old){if(old.hash!==digest){this.q('INSERT INTO ob_quarantine(binding,generation,sequence,payload_hash,category) VALUES(?,?,?,?,?)').run(id,g,sequence,digest,'receipt_conflict');return {conflict:true};}return;}
   this.q('INSERT INTO ob_receipt VALUES(?,?,?,?,?,?)').run(id,g,sequence,target,kind,digest);
  });
  if(outcome?.conflict)fail('receipt conflict');
 }
 resultCorrelation(runId){
  let r=this.q('SELECT * FROM runs WHERE id=?').get(runId);const seen=new Set();
  while(r?.parent_run){if(seen.has(r.id))fail('parent cycle');seen.add(r.id);r=this.q('SELECT * FROM runs WHERE id=?').get(r.parent_run);}
  if(!r)fail('missing root run');
  const i=this.q("SELECT * FROM ob_inbox WHERE run_id=? AND kind='text'").get(r.id);if(!i)fail('unbound result');
  return {binding:i.binding,generation:i.generation,topic:i.topic,rootRun:r.id,thread:r.thread};
 }
 project(runId){return this.tx(()=>{
  const r=this.q('SELECT * FROM runs WHERE id=?').get(runId);if(!r)fail('missing run');
  const result=this.q("SELECT id,kind,body FROM messages WHERE run_id=? AND kind IN ('text','error','quiet') ORDER BY id DESC LIMIT 1").get(runId)||null;
  const digest=hash(result??null),old=this.q('SELECT * FROM ob_projection WHERE run_id=?').get(runId);
  if(old){
   if(old.state==='needs_review'&&old.result_hash===hash(null)&&result){
    const changed=this.q("UPDATE ob_projection SET state='prepared',result_hash=? WHERE run_id=? AND state='needs_review' AND result_hash=?").run(digest,runId,hash(null));
    if(!changed.changes)fail('projection transition conflict');
    this.q('INSERT INTO ob_projection_resolution VALUES(?,?,?,?)').run(runId,old.result_hash,digest,result.id);
    return {state:'prepared',correlation:JSON.parse(old.correlation)};
   }
   if(old.result_hash!==digest)fail('result conflict');return {...old,correlation:JSON.parse(old.correlation)};
  }
  const correlation=this.resultCorrelation(runId),state=result?'prepared':'needs_review';this.q('INSERT INTO ob_projection VALUES(?,?,?,?)').run(runId,digest,state,JSON.stringify(correlation));return {state,correlation};
 });}
}
