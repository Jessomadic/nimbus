// Lumos on Nimbus: receives the relay's iMessage webhooks, turns each request into
// a Nimbus run in its topic room, sends the reply back through the OpenBubbles
// bridge, and reports the outcome to the relay's /complete ledger.
//
// Safety rules (same as the relay and Hermes):
// - 200 is returned only after the request is durably stored; 503 before any write
//   while Lumos is disabled or not ready.
// - A bridge send is never repeated automatically. Each bubble has a deterministic
//   tempGuid and goes through the OpenBubbles outbox; a send whose result is
//   unknown becomes uncertain and the relay asks the owner, nothing is resent.
// - The /complete report has no side effects and is retried until recorded.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {timingSafeEqual,createHash} from 'node:crypto';
import {MIME,MAX_FILE,chunks} from './openbubbles-protocol.js';
import {OpenBubblesStore} from './openbubbles-store.js';
import {hostAuthority,attachHostRun,dispatchOpenBubbles} from './openbubbles-dispatch.js';
import {LumosTopics} from './lumos-topics.js';

export const LUMOS_SCHEMA=`CREATE TABLE IF NOT EXISTS lumos_inbox(guid TEXT PRIMARY KEY,received_at INTEGER NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,run_id INTEGER,topic TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS lumos_delivery(run_id INTEGER PRIMARY KEY,guid TEXT NOT NULL,state TEXT NOT NULL,outcome TEXT,complete_state TEXT NOT NULL DEFAULT 'none',pause_noted INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lumos_notes(id TEXT PRIMARY KEY,guid TEXT,text TEXT NOT NULL,state TEXT NOT NULL,updated_at INTEGER NOT NULL);`;
const BINDING='lumos',GENERATION=1;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL={done:'success',error:'failure',needs_review:'failure',stopped:'cancelled',interrupted:'failure'};
const now=()=>Math.floor(Date.now()/1000);
const digest=value=>createHash('sha256').update(value).digest('hex');

// iMessage shows plain text: drop Markdown markers but keep link targets, then
// one bubble per paragraph (Hermes bluebubbles.py format_message + send).
export function bubbles(text){
  const plain=String(text||'')
    .replace(/```[a-z]*\n?([\s\S]*?)```/gi,'$1')
    .replace(/!?\[([^\]]+)\]\(([^)\s]+)\)/g,(m,label,url)=>label===url?url:`${label} (${url})`)
    .replace(/^#{1,6}[ \t]+/gm,'').replace(/(\*\*|__)(.+?)\1/g,'$2').replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g,'$1$2')
    .replace(/`([^`]+)`/g,'$1').replace(/^[ \t]*[-*][ \t]+/gm,'• ').trim();
  return plain.split(/\n\s*\n/).map(p=>p.trim()).filter(Boolean).flatMap(p=>Buffer.byteLength(p)>4000?chunks(p):[p]);
}
const safeName=name=>String(name||'attachment').replace(/[\p{C}/\\:<>"|?*&]/gu,'_').slice(0,120)||'attachment';

export function createLumos({db,getConfig,loadRoute,insertRun,enqueue,stopRun,parseBot,dataDir,fetchImpl=globalThis.fetch,classify,memory={prefetch:async()=>[],extract:async()=>{}},log=console,clock={setInterval,clearInterval}}){
  db.exec(LUMOS_SCHEMA);
  const store=new OpenBubblesStore(db,()=>{throw new Error('Lumos creates runs itself');});
  const q=sql=>db.prepare(sql);
  const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;}};
  let server=null,timer=null,route=null,authority=null,working=null,lastInboundAt=null,lastError=null;
  const cfg=()=>getConfig().lumos;
  const recent=topicId=>{
    const thread=q('SELECT thread FROM ob_topic WHERE binding=? AND generation=? AND topic=?').get(BINDING,GENERATION,topicId)?.thread;
    if(!thread)return [];
    return q("SELECT author,body FROM messages WHERE thread=? AND kind='text' ORDER BY id DESC LIMIT 6").all(thread).reverse()
      .map(m=>({role:m.author==='user'?'user':'assistant',text:String(m.body).slice(0,700)}));
  };
  const topics=new LumosTopics(db,{classify,recent});
  const bridge=async(pathname,{method='GET',body,headers={},raw=false,signal}={})=>{
    const response=await fetchImpl(cfg().bridgeUrl+pathname,{method,headers:{authorization:'Bearer '+route.token,...(body&&!headers['content-type']?{'content-type':'application/json'}:{}),...headers},
      body:body===undefined?undefined:typeof body==='string'||body instanceof ReadableStream?body:JSON.stringify(body),duplex:body instanceof ReadableStream?'half':undefined,signal});
    if(raw)return response;
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw Object.assign(new Error(`Bridge ${pathname} returned HTTP ${response.status}`),{status:response.status,value});
    return value;
  };
  const ready=()=>!!(cfg().enabled&&route&&authority&&cfg().botId&&q('SELECT id FROM bots WHERE id=?').get(cfg().botId));
  function ensureBinding(){
    const l=cfg();
    store.bind({id:BINDING,generation:GENERATION,owner:route.owner,chat:route.chat,botId:l.botId});
    authority=hostAuthority({store,reader:ref=>readContent(ref),stage:stageFile,sink:(wire,{signal}={})=>bridge(wire.path,{method:wire.method,body:wire.body,headers:wire.headers,signal})});
    // Runs that were active before a restart regain their bridge tools.
    for(const r of q("SELECT run_id FROM lumos_inbox WHERE state='ingested' AND run_id IN (SELECT id FROM runs WHERE status NOT IN ('done','error','stopped','needs_review'))").all())attachHostRun(r.run_id,authority);
  }
  const EXT={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.heic':'image/heic','.webp':'image/webp','.mp4':'video/mp4','.mov':'video/quicktime','.mp3':'audio/mpeg','.m4a':'audio/x-m4a','.pdf':'application/pdf','.txt':'text/plain'};
  // Copy a local file into private content so its exact bytes are what gets sent.
  function stageFile(file,c){
    const mime=EXT[path.extname(file).toLowerCase()];
    if(!mime)throw new Error('Unsupported file type for iMessage: '+path.basename(file));
    const bytes=fs.readFileSync(file);
    if(!bytes.length||bytes.length>MAX_FILE)throw new Error('iMessage files must be 1 byte to 25 MB: '+path.basename(file));
    const sha256=digest(bytes),ref='lf'+sha256.slice(0,30)+Date.now().toString(36);
    q('INSERT INTO ob_content(ref,binding,generation,topic,sequence,run_id,sha256,bytes) VALUES(?,?,?,?,NULL,?,?,?)').run(ref,c.binding,c.generation,c.topic,c.runId,sha256,bytes);
    return {ref,name:safeName(path.basename(file)),mime,size:bytes.length,sha256};
  }
  async function* readContent(ref){
    const row=q('SELECT bytes,sha256 FROM ob_content WHERE ref=?').get(ref);
    if(!row)throw new Error('Unknown staged file');
    const bytes=Buffer.from(row.bytes);if(digest(bytes)!==row.sha256)throw new Error('Staged file changed');
    yield bytes;
  }

  // --- Webhook ---------------------------------------------------------------
  function handleWebhook(headers,rawBody){
    if(!ready())return {status:503,body:{error:'Lumos on Nimbus is not enabled'}};
    const supplied=Buffer.from(String(headers['x-password']||'')),expected=Buffer.from(route.token);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return {status:401,body:{error:'unauthorized'}};
    let payload;try{payload=JSON.parse(rawBody);}catch{return {status:400,body:{error:'invalid JSON'}};}
    const data=payload?.data;
    if(payload?.type!=='new-message'||payload._lumos_relay!==true||!data||!UUID.test(String(data.guid||''))||data.isFromMe!==false||data.sender!==route.owner)
      return {status:422,body:{error:'not an approved owner message'}};
    const event=payload._lumos_event;
    if(event&&(event.chat_guid!==route.chat||event.guid!==data.guid||event.sender!==route.owner||event.is_from_me!==false))return {status:422,body:{error:'event does not match the approved chat'}};
    const guid=data.guid.toLowerCase();
    const inserted=q("INSERT OR IGNORE INTO lumos_inbox(guid,received_at,payload,state) VALUES(?,?,?,'pending')").run(guid,now(),JSON.stringify(payload)).changes;
    lastInboundAt=Date.now();
    queueWork();
    return {status:200,body:inserted?{ok:true}:{ok:true,duplicate:true}};
  }

  // --- Inbox processing (serialized) -------------------------------------
  function queueWork(){working=(working||Promise.resolve()).then(processInbox).catch(error=>{lastError=error.message;log.error('Lumos inbox:',error.message);});return working;}
  async function processInbox(){
    if(!ready())return;
    for(const row of q("SELECT * FROM lumos_inbox WHERE state='pending' ORDER BY received_at,guid").all()){
      try{await processOne(row);}
      catch(error){
        q("UPDATE lumos_inbox SET state='failed',error=? WHERE guid=? AND state='pending'").run(String(error.message).slice(0,500),row.guid);
        note(row.guid,'failed-'+row.guid,"I couldn't start that request: "+String(error.message).slice(0,200)+". Ask me again if you want me to retry.",'failure');
      }
    }
  }
  async function processOne(row){
    const payload=JSON.parse(row.payload),data=payload.data,text=String(data.text||'').trim(),l=cfg();
    bridge(`/api/v1/chat/${encodeURIComponent(route.chat)}/read`,{method:'POST',body:{messageGuid:data.guid}}).catch(()=>{});
    if(/^\/new\s*$/i.test(text)){topics.forceNew();q("UPDATE lumos_inbox SET state='command' WHERE guid=?").run(row.guid);return note(row.guid,'cmd-'+row.guid,'Started a new conversation.','success');}
    if(/^\/stop\s*$/i.test(text)){
      const active=q("SELECT id FROM runs WHERE bot_id=? AND source='lumos' AND status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','paused')").all(l.botId);
      for(const r of active)stopRun(r.id);
      q("UPDATE lumos_inbox SET state='command' WHERE guid=?").run(row.guid);
      return note(row.guid,'cmd-'+row.guid,active.length?'Stopped.':'Nothing was running.','success');
    }
    const files=await downloadAttachments(row.guid,data.attachments||[]);
    const {topic}=await topics.choose(text,{timeoutMs:l.topicTimeoutSeconds*1000});
    const context=files.length?'\n\nAttached files (use view_image for images, read_file or shell for other formats):\n'+files.map(f=>`- ${f.path||'(not downloaded: '+f.reason+')'} (${f.mime}, ${f.name})`).join('\n'):'';
    // Like the Hermes holographic provider: a few relevant remembered facts per turn.
    let facts=[];try{facts=text?await memory.prefetch(text):[];}catch{}
    const recall=facts.length?'\n\nRemembered facts that may be relevant (from your memory; verify before relying on them):\n'+facts.map(f=>'- '+String(f).slice(0,400)).join('\n'):'';
    const prompt=(text||'[The owner sent attachments without text.]')+context+recall;
    const runId=tx(()=>{
      let mapping=q('SELECT thread FROM ob_topic WHERE binding=? AND generation=? AND topic=?').get(BINDING,GENERATION,topic.id);
      if(!mapping){
        const room=Number(q('INSERT INTO rooms(name,lead_bot_id,bots_can_talk) VALUES(?,?,0)').run('Lumos: '+topic.label.slice(0,60),l.botId).lastInsertRowid);
        q('INSERT INTO room_members(room_id,bot_id) VALUES(?,?)').run(room,l.botId);
        mapping={thread:'room:'+room};q('INSERT INTO ob_topic VALUES(?,?,?,?)').run(BINDING,GENERATION,topic.id,mapping.thread);
      }
      const id=insertRun({botId:l.botId,thread:mapping.thread,prompt,source:'lumos',originRequestId:'lumos:'+row.guid});
      const b=q('SELECT cursor FROM ob_binding WHERE id=? AND generation=?').get(BINDING,GENERATION);
      const sequence=Number.isSafeInteger(payload._lumos_event?.sequence)&&payload._lumos_event.sequence>b.cursor?payload._lumos_event.sequence:b.cursor+1;
      q("INSERT INTO ob_inbox VALUES(?,?,?,?,?,?,?,'text',?)").run(BINDING,GENERATION,sequence,row.guid,digest(row.payload),topic.id,id,JSON.stringify({guid:row.guid,text:text.slice(0,2000),attachments:files.map(f=>({name:f.name,mime:f.mime}))}));
      q('UPDATE ob_binding SET cursor=? WHERE id=? AND generation=?').run(sequence,BINDING,GENERATION);
      q("UPDATE lumos_inbox SET state='ingested',run_id=?,topic=? WHERE guid=?").run(id,topic.id,row.guid);
      q("INSERT INTO lumos_delivery(run_id,guid,state,updated_at) VALUES(?,?,'waiting',?)").run(id,row.guid,now());
      return id;
    });
    attachHostRun(runId,authority);
    bridge(`/api/v1/chat/${encodeURIComponent(route.chat)}/typing`,{method:'POST',body:{}}).catch(()=>{});
    enqueue(runId);
  }
  async function downloadAttachments(guid,attachments){
    const out=[],dir=path.join(dataDir,'bots',String(cfg().botId),'inbox',guid);
    for(const a of attachments.slice(0,10)){
      const mime=String(a.mimeType||'').split(';')[0].trim().toLowerCase(),name=safeName(a.transferName);
      if(!MIME.includes(mime)){out.push({name,mime,reason:'unsupported type'});continue;}
      try{
        const response=await bridge(`/api/v1/attachment/${encodeURIComponent(a.guid)}/download`,{raw:true});
        if(!response.ok)throw new Error('HTTP '+response.status);
        const length=Number(response.headers.get('content-length')||0);if(length>MAX_FILE)throw new Error('larger than 25 MB');
        const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>MAX_FILE)throw new Error('larger than 25 MB');
        fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,out.length+'-'+name);fs.writeFileSync(file,bytes,{flag:'wx'});
        out.push({name,mime,path:file,size:bytes.length});
      }catch(error){out.push({name,mime,reason:error.message});}
    }
    return out;
  }

  // --- Plain notes (commands, start failures, pause notices) -------------
  // A note has a deterministic tempGuid, so the bridge recognises a repeat of the
  // same note and does not send it twice.
  async function sendNote(id,text){
    const row=q('SELECT state FROM lumos_notes WHERE id=?').get(id);
    if(row&&row.state!=='queued')return row.state;
    q("INSERT INTO lumos_notes(id,text,state,updated_at) VALUES(?,?,'queued',?) ON CONFLICT(id) DO NOTHING").run(id,text,now());
    if(q("UPDATE lumos_notes SET state='sending',updated_at=? WHERE id=? AND state='queued'").run(now(),id).changes!==1)return 'busy';
    try{
      const ack=await bridge('/api/v1/message/text',{method:'POST',body:{chatGuid:route.chat,message:text.slice(0,3900),tempGuid:'nimbus-note-'+digest(id).slice(0,40)}});
      if(ack.status!==200)throw new Error('bridge did not confirm the note');
      q("UPDATE lumos_notes SET state='sent',updated_at=? WHERE id=?").run(now(),id);return 'sent';
    }catch(error){q("UPDATE lumos_notes SET state='uncertain',updated_at=? WHERE id=?").run(now(),id);lastError=error.message;return 'uncertain';}
  }
  async function note(guid,id,text,outcome){
    const state=await sendNote(id,text);
    await complete(guid,state==='sent'?outcome:'failure');
  }
  async function complete(guid,outcome){
    try{
      const response=await fetchImpl(cfg().completeUrl,{method:'POST',headers:{'content-type':'application/json','x-lumos-relay-token':route.token},body:JSON.stringify({guid,outcome})});
      // 404 means the relay already finished this request (or never had it).
      return response.ok||response.status===404;
    }catch(error){lastError='relay completion: '+error.message;return false;}
  }

  // --- Delivery ------------------------------------------------------------
  // An uncertain send blocks the outbox (no automatic replay). Resolve it by
  // reading the bridge's own ledger: if the tempGuid is there the bubble was
  // sent; if it is still absent after a minute it was not. Nothing is resent.
  async function reconcile(){
    const rows=q("SELECT * FROM ob_outbox WHERE binding=? AND generation=? AND state='uncertain'").all(BINDING,GENERATION);
    if(!rows.length)return;
    // The bridge event feed holds inbound and outbound events in one sequence;
    // scan forward from just before the last inbound request this binding saw.
    const sent=new Map();
    let after=Math.max(0,(q('SELECT cursor FROM ob_binding WHERE id=? AND generation=?').get(BINDING,GENERATION)?.cursor||0)-50);
    for(let page=0;page<50;page++){
      const events=(await bridge(`/api/v1/events?after=${after}&limit=1000`)).data||[];
      for(const e of events){if(e.temp_guid)sent.set(e.temp_guid,e.guid);after=Math.max(after,e.sequence||after);}
      if(events.length<1000)break;
    }
    for(const row of rows){
      const temp=JSON.parse(row.plan).body?.tempGuid,c={binding:BINDING,generation:GENERATION};
      if(temp&&sent.has(temp))store.review(c,row.operation,row.chunk,row.epoch,{decision:'submitted',reviewer:'lumos-reconcile',evidence:'bridge ledger has tempGuid '+temp,nativeGuid:sent.get(temp)||'unknown'});
      else if(q('SELECT updated_at FROM lumos_delivery WHERE run_id=?').get(row.run_id)?.updated_at<now()-60)
        store.review(c,row.operation,row.chunk,row.epoch,{decision:'not_submitted',reviewer:'lumos-reconcile',evidence:'tempGuid absent from the bridge ledger after 60 s'});
    }
  }
  async function deliver(){
    if(!route)return;
    try{await reconcile();}catch(error){lastError='reconcile: '+error.message;}
    for(const d of q("SELECT * FROM lumos_delivery WHERE state IN ('waiting','replying') OR complete_state='pending'").all()){
      const run=q('SELECT id,status,bot_id,last_error FROM runs WHERE id=?').get(d.run_id);
      if(d.complete_state==='pending'){
        if(await complete(d.guid,d.outcome))q("UPDATE lumos_delivery SET complete_state='done',updated_at=? WHERE run_id=?").run(now(),d.run_id);
        else q('UPDATE lumos_delivery SET attempts=attempts+1,updated_at=? WHERE run_id=?').run(now(),d.run_id);
        continue;
      }
      if(d.state==='replying'){
        // A reply was being sent when Nimbus stopped. Its result is unknown, so
        // nothing is resent; the relay asks the owner.
        finish(d.run_id,'uncertain','failure','Reply delivery was interrupted');continue;
      }
      if(!run){finish(d.run_id,'completed','failure','Run disappeared');continue;}
      if(run.status==='paused'&&!d.pause_noted&&cfg().enabled){
        q('UPDATE lumos_delivery SET pause_noted=1 WHERE run_id=?').run(d.run_id);
        await sendNote('pause-'+d.run_id,'I paused this request: '+String(run.last_error||'it needs attention').replace(/\s+/g,' ').slice(0,300)+' It will continue when that is resolved.');
        continue;
      }
      const outcome=TERMINAL[run.status];if(!outcome)continue;
      if(run.status!=='done'){finish(d.run_id,'completed',outcome,run.last_error);continue;}
      const reply=q("SELECT body FROM messages WHERE run_id=? AND kind IN ('text','quiet') ORDER BY id DESC LIMIT 1").get(d.run_id)?.body||'';
      const parts=bubbles(reply);
      if(!parts.length){finish(d.run_id,'completed','success',null);continue;}
      if(q("UPDATE lumos_delivery SET state='replying',updated_at=? WHERE run_id=? AND state='waiting'").run(now(),d.run_id).changes!==1)continue;
      const bot=parseBot(q('SELECT * FROM bots WHERE id=?').get(run.bot_id));
      try{
        for(let i=0;i<parts.length;i++)await dispatchOpenBubbles(bot,{operationId:`reply-${d.run_id}-${i}`,kind:'text',text:parts[i]},{runId:d.run_id,openBubblesAuthority:authority});
        finish(d.run_id,'replied','success',null);
        // Learn durable facts from the owner's message (best effort, like Hermes auto-extract).
        const asked=q('SELECT payload FROM lumos_inbox WHERE run_id=?').get(d.run_id);
        if(asked)memory.extract([{role:'user',content:String(JSON.parse(asked.payload).data?.text||'')}]).catch(()=>{});
      }catch(error){finish(d.run_id,'uncertain','failure',error.message);}
    }
  }
  function finish(runId,state,outcome,error){q("UPDATE lumos_delivery SET state=?,outcome=?,complete_state='pending',last_error=?,updated_at=? WHERE run_id=?").run(state,outcome,error?String(error).slice(0,500):null,now(),runId);}

  // --- Lifecycle -------------------------------------------------------------
  let delivering=null;
  const tick=async()=>{if(delivering)return delivering;delivering=(async()=>{try{await deliver();if(ready())await queueWork();}catch(error){lastError=error.message;log.error('Lumos delivery:',error.message);}finally{delivering=null;}})();return delivering;};
  async function start(){
    const l=cfg();
    try{route=loadRoute(l);ensureBinding();lastError=null;}catch(error){route=null;authority=null;lastError=error.message;}
    if(!server){
      server=http.createServer((req,res)=>{
        const send=(status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
        if(req.method==='GET'&&req.url==='/health')return send(200,{ok:true,platform:'nimbus-lumos',ready:ready(),botId:cfg().botId});
        if(req.method!=='POST'||req.url!=='/bluebubbles-webhook')return send(404,{error:'not found'});
        let raw='',size=0;
        req.on('data',chunk=>{size+=chunk.length;if(size>1048576){send(413,{error:'too large'});req.destroy();}else raw+=chunk;});
        req.on('end',()=>{if(res.headersSent)return;try{const r=handleWebhook(req.headers,raw);send(r.status,r.body);}catch(error){lastError=error.message;send(500,{error:'internal error'});}});
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(l.ingressPort,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    }
    timer??=clock.setInterval(()=>{tick();},2000);timer.unref?.();
    tick();
    return status();
  }
  async function stop(){
    if(timer){clock.clearInterval(timer);timer=null;}
    if(server){await new Promise(resolve=>server.close(()=>resolve()));server=null;}
    await delivering;await working;
  }
  function status(){
    const count=sql=>q(sql).get().n;
    return {enabled:!!cfg().enabled,ready:ready(),listening:!!server,botId:cfg().botId,lastInboundAt,lastError,
      pendingRequests:count("SELECT COUNT(*) n FROM lumos_inbox WHERE state='pending'"),
      waitingReplies:count("SELECT COUNT(*) n FROM lumos_delivery WHERE state='waiting'"),
      uncertain:count("SELECT COUNT(*) n FROM lumos_delivery WHERE state='uncertain'")+count("SELECT COUNT(*) n FROM ob_outbox WHERE state='uncertain' AND binding='lumos'")};
  }
  // Re-read config (after enable/disable) and pick up a changed route.
  async function reconfigure(){try{route=loadRoute(cfg());ensureBinding();lastError=null;}catch(error){route=null;authority=null;lastError=error.message;}tick();return status();}
  return {start,stop,status,reconfigure,handleWebhook,tick,topics,store,deliver,processInbox:queueWork};
}
