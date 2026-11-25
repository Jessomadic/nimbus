import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {EventEmitter} from 'node:events';
import {createLumos,bubbles} from '../runtime/lumos.js';
import {createLumosSchedules,wakes} from '../runtime/lumos-schedules.js';
import {loadLumosRoute,validateLumosConfig,LUMOS_DEFAULTS} from '../runtime/lumos-config.js';
import {LumosTopics} from '../runtime/lumos-topics.js';

const OWNER='tel:+15550000001',BOT='lumos-bot@example.test',CHAT='11111111-2222-4333-8444-555555555555',TOKEN='t'.repeat(32);
const guid=n=>`aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12,'0')}`;
const wait=ms=>new Promise(r=>setTimeout(r,ms));

async function listen(handler){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));return {server,url:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};}
async function fixture(t,{enabled=true,bridgeFails=false,memory}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-lumos-'));
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT,tools TEXT,template TEXT);
CREATE TABLE rooms(id INTEGER PRIMARY KEY,name TEXT,lead_bot_id INTEGER,bots_can_talk INTEGER);
CREATE TABLE room_members(room_id INTEGER,bot_id INTEGER);
CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,prompt TEXT,status TEXT,source TEXT,parent_run INTEGER,last_error TEXT,origin_request_id TEXT);
CREATE TABLE messages(id INTEGER PRIMARY KEY,thread TEXT,author TEXT,kind TEXT,body TEXT,run_id INTEGER);`);
  db.prepare("INSERT INTO bots VALUES(7,'Lumos',?,NULL)").run(JSON.stringify(['openbubbles_operation']));
  const sent=[],completed=[],reads=[];let n=0;
  const bridge=await listen((req,res)=>{
    let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      const send=(s,b)=>{res.writeHead(s,{'content-type':'application/json'});res.end(JSON.stringify(b));};
      if(req.headers.authorization!=='Bearer '+TOKEN)return send(401,{});
      if(req.url==='/api/v1/message/text'){if(bridgeFails)return send(500,{});const b=JSON.parse(raw);sent.push(b);return send(200,{status:200,data:{guid:'native-'+(++n),tempGuid:b.tempGuid,accepted:true}});}
      if(req.url.startsWith('/api/v1/attachment/')){const big=req.url.includes('big');res.writeHead(200,{'content-type':'image/png','content-length':big?String(30*1024*1024):'4'});return res.end(big?'':'PNG!');}
      if(req.url.startsWith('/api/v1/events'))return send(200,{status:200,data:[]});
      if(/\/(read|typing)$/.test(req.url)){reads.push(req.url);return send(200,{status:200,data:{}});}
      send(404,{});
    });
  });
  const relay=await listen((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{completed.push({...JSON.parse(raw),token:req.headers['x-lumos-relay-token']});res.writeHead(200);res.end('{}');});});
  const config={lumos:{...LUMOS_DEFAULTS,enabled,botId:7,homeDir:dir,ingressPort:0,bridgeUrl:bridge.url,completeUrl:relay.url+'/complete',topicTimeoutSeconds:2}};
  const runs=[];let classify=async()=>JSON.stringify({target:'CURRENT'});
  const lumos=createLumos({db,getConfig:()=>config,loadRoute:()=>({chat:CHAT,owner:OWNER,bot:BOT,token:TOKEN}),dataDir:dir,parseBot:b=>b,stopRun:id=>db.prepare("UPDATE runs SET status='stopped' WHERE id=?").run(id),
    insertRun:a=>Number(db.prepare("INSERT INTO runs(bot_id,thread,prompt,status,source,origin_request_id) VALUES(?,?,?,'queued',?,?)").run(a.botId,a.thread,a.prompt,a.source,a.originRequestId).lastInsertRowid),
    enqueue:id=>runs.push(id),classify:(s,p)=>classify(s,p),...(memory?{memory}:{}),log:{error(){}},clock:{setInterval:()=>({unref(){}}),clearInterval(){}}});
  // Use a fixed port-0 listener: start() with port 0 binds an ephemeral port.
  await lumos.start();
  t.after(async()=>{await lumos.stop();await bridge.close();await relay.close();});
  const finishRun=(id,status,body)=>{db.prepare('UPDATE runs SET status=? WHERE id=?').run(status,id);if(body)db.prepare("INSERT INTO messages(thread,author,kind,body,run_id) SELECT thread,'7','text',?,id FROM runs WHERE id=?").run(body,id);};
  const webhook=(n,text,extra={})=>({type:'new-message',_lumos_relay:true,data:{guid:guid(n),chatIdentifier:OWNER,sender:OWNER,text,isFromMe:false,attachments:extra.attachments||[]},_lumos_event:{sequence:100+n,chat_guid:CHAT,guid:guid(n),sender:OWNER,is_from_me:false}});
  const post=(body,password=TOKEN)=>lumos.handleWebhook({'x-password':password},JSON.stringify(body));
  return {db,lumos,config,sent,completed,reads,runs,finishRun,webhook,post,setClassify:f=>{classify=f;},dir};
}
const settle=async f=>{for(let i=0;i<20;i++){await f.lumos.processInbox();await f.lumos.tick();await wait(10);}};

test('disabled or unauthenticated requests are refused before anything is stored',async t=>{
  const f=await fixture(t,{enabled:false});
  assert.equal(f.post(f.webhook(1,'hi')).status,503);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lumos_inbox').get().n,0);
  f.config.lumos.enabled=true;
  assert.equal(f.post(f.webhook(1,'hi'),'wrong-password-wrong-password-xx').status,401);
  assert.equal(f.post({...f.webhook(1,'hi'),data:{...f.webhook(1,'hi').data,sender:'tel:+19990000000'}}).status,422);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM lumos_inbox').get().n,0);
});

test('an owner message becomes one run in a topic room, the reply is sent as bubbles and the relay is told',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.post(f.webhook(1,'What is on my calendar?')),{status:200,body:{ok:true}});
  assert.deepEqual(f.post(f.webhook(1,'What is on my calendar?')).body,{ok:true,duplicate:true});
  await settle(f);
  assert.equal(f.runs.length,1,'exactly one run for a repeated webhook');
  const run=f.db.prepare('SELECT * FROM runs').get();
  assert.equal(run.source,'lumos');assert.match(run.thread,/^room:\d+$/);assert.equal(run.origin_request_id,'lumos:'+guid(1));
  f.finishRun(run.id,'done','**Today:** dentist at 3.\n\nAlso [the map](https://example.test/map).');
  await settle(f);
  assert.deepEqual(f.sent.map(s=>s.message),['Today: dentist at 3.','Also the map (https://example.test/map).']);
  assert.ok(f.sent.every(s=>s.chatGuid===CHAT&&/^[a-f0-9]{64}$/.test(s.tempGuid)));
  assert.deepEqual(f.completed.map(c=>[c.guid,c.outcome,c.token]),[[guid(1),'success',TOKEN]]);
  await settle(f);
  assert.equal(f.sent.length,2,'nothing is sent twice');assert.equal(f.completed.length,1);
});

test('failed and stopped runs report failure or cancelled to the relay without sending a reply',async t=>{
  const f=await fixture(t);
  f.post(f.webhook(1,'one'));f.post(f.webhook(2,'two'));await settle(f);
  const [a,b]=f.db.prepare('SELECT id FROM runs ORDER BY id').all();
  f.finishRun(a.id,'error');f.finishRun(b.id,'stopped');await settle(f);
  assert.equal(f.sent.length,0);
  assert.deepEqual(f.completed.map(c=>c.outcome).sort(),['cancelled','failure']);
});

test('/new and /stop are handled without a model run',async t=>{
  const f=await fixture(t);
  f.post(f.webhook(1,'plan a trip'));await settle(f);
  f.post(f.webhook(2,'/stop'));await settle(f);
  assert.equal(f.db.prepare('SELECT status FROM runs').get().status,'stopped');
  f.post(f.webhook(3,'/new'));await settle(f);
  assert.equal(f.runs.length,1);
  assert.deepEqual(f.sent.map(s=>s.message),['Stopped.','Started a new conversation.']);
  assert.ok(f.completed.filter(c=>c.outcome==='success').length>=2);
});

test('a send whose result is unknown is never repeated and the relay asks the owner',async t=>{
  const f=await fixture(t,{bridgeFails:true});
  f.post(f.webhook(1,'hello'));await settle(f);
  const run=f.db.prepare('SELECT id FROM runs').get();f.finishRun(run.id,'done','Hi there');await settle(f);
  assert.equal(f.db.prepare('SELECT state FROM lumos_delivery').get().state,'uncertain');
  assert.deepEqual(f.completed.map(c=>c.outcome),['failure']);
  assert.equal(f.db.prepare("SELECT state FROM ob_outbox WHERE binding='lumos'").get().state,'uncertain');
  // After a minute with no trace in the bridge ledger it is recorded as not sent, never resent.
  f.db.prepare('UPDATE lumos_delivery SET updated_at=updated_at-120').run();
  await settle(f);
  assert.equal(f.db.prepare("SELECT state FROM ob_outbox WHERE binding='lumos'").get().state,'not_submitted');
  assert.equal(f.completed.length,1);
});

test('a paused run gets one plain-language notice and keeps waiting for its real reply',async t=>{
  const f=await fixture(t);
  f.post(f.webhook(1,'research this'));await settle(f);
  const run=f.db.prepare('SELECT id FROM runs').get();
  f.db.prepare("UPDATE runs SET status='paused',last_error='Waiting for the Claude usage limit to reset' WHERE id=?").run(run.id);
  await settle(f);await settle(f);
  assert.equal(f.sent.length,1);assert.match(f.sent[0].message,/paused this request: Waiting for the Claude usage limit/);
  assert.equal(f.completed.length,0);
  f.finishRun(run.id,'done','Here is the research.');await settle(f);
  assert.equal(f.sent.at(-1).message,'Here is the research.');assert.deepEqual(f.completed.map(c=>c.outcome),['success']);
});

test('attachments are downloaded within limits and their local paths given to the run',async t=>{
  const f=await fixture(t);
  f.post(f.webhook(1,'what is this?',{attachments:[{guid:'img1',mimeType:'image/png',transferName:'photo.png'},{guid:'big',mimeType:'image/png',transferName:'huge.png'},{guid:'x',mimeType:'application/x-msdownload',transferName:'a.exe'}]}));
  await settle(f);
  const prompt=f.db.prepare('SELECT prompt FROM runs').get().prompt;
  const saved=prompt.match(/- (\S+0-photo\.png) \(image\/png/)[1];
  assert.equal(fs.readFileSync(saved,'utf8'),'PNG!');
  assert.match(prompt,/not downloaded: larger than 25 MB/);assert.match(prompt,/not downloaded: unsupported type/);
});

test('unrelated requests get their own topic room; follow-ups stay; a broken classifier falls back safely',async t=>{
  const f=await fixture(t);
  f.post(f.webhook(1,'Find a lasagna recipe'));await settle(f);
  let [r1]=f.db.prepare('SELECT * FROM runs ORDER BY id').all();f.finishRun(r1.id,'done','Here is a recipe.');await settle(f);
  f.setClassify(async()=>JSON.stringify({target:'NEW',label:'Car service'}));
  f.post(f.webhook(2,'When is my car due for service?'));await settle(f);
  f.setClassify(async()=>JSON.stringify({target:'CURRENT'}));
  f.post(f.webhook(3,'Thanks'));await settle(f);
  const runs=f.db.prepare('SELECT thread FROM runs ORDER BY id').all().map(r=>r.thread);
  assert.notEqual(runs[0],runs[1]);assert.equal(runs[1],runs[2]);
  const topics=new LumosTopics(new DatabaseSync(':memory:'),{classify:async()=>{throw new Error('down');},recent:()=>[{role:'user',text:'x'}]});
  const first=(await topics.choose('Book a table')).topic;
  assert.equal((await topics.choose('why is that?')).topic.id,first.id,'short dependent text stays');
  assert.notEqual((await topics.choose('Please summarize the quarterly budget spreadsheet for me in detail')).topic.id,first.id);
});

test('bubble formatting strips Markdown, keeps links and splits paragraphs',()=>{
  assert.deepEqual(bubbles('# Title\n\n- **one**\n- `two`\n\n[a](http://x.test/a)'),['Title','• one\n• two','a (http://x.test/a)']);
  assert.deepEqual(bubbles(''),[]);
});

test('config validation and the relay allowlist rules',()=>{
  assert.throws(()=>validateLumosConfig({...LUMOS_DEFAULTS,enabled:true}),/botId and homeDir/);
  assert.throws(()=>validateLumosConfig({...LUMOS_DEFAULTS,bridgeUrl:'http://example.test:12345'}),/loopback/);
  const files={b:JSON.stringify({bind_host:'127.0.0.1',bind_port:12345,api_token:TOKEN,sender_handle:BOT,allowed_chats:{[CHAT]:{address:'+15550000001'}}}),o:JSON.stringify({chat_guid:CHAT,owner_handle:OWNER,bot_handle:BOT})};
  assert.deepEqual(loadLumosRoute({bridgeConfigPath:'b',ownerConfigPath:'o'},{read:f=>files[f]}),{chat:CHAT,owner:OWNER,bot:BOT,token:TOKEN});
  const two=JSON.stringify({...JSON.parse(files.b),allowed_chats:{[CHAT]:{address:'+15550000001'},other:{address:'+1'}}});
  assert.throws(()=>loadLumosRoute({bridgeConfigPath:'b',ownerConfigPath:'o'},{read:f=>f==='b'?two:files.o}),/allowlist/);
});

test('schedules run a script once per fire, honor the wake gate and report failures',async()=>{
  const db=new DatabaseSync(':memory:'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'lumos-sched-'));
  fs.mkdirSync(path.join(dir,'scripts'));for(const s of ['ok.py','quiet.py','bad.py'])fs.writeFileSync(path.join(dir,'scripts',s),'');
  const sent=[],outputs={'ok.py':[0,'Low tracker risk tonight.'],'quiet.py':[0,'{"wakeAgent": false}'],'bad.py':[2,'']};let envSeen;
  const spawnProcess=(cmd,[file],opts)=>{envSeen=opts.env.HERMES_CRON_EXECUTION_ID;const c=new EventEmitter();c.stdout=new EventEmitter();c.stderr=new EventEmitter();const [code,out]=outputs[path.basename(file)];
    setImmediate(()=>{c.stdout.emit('data',out);if(code)c.stderr.emit('data','boom');c.emit('close',code);});return c;};
  const at=new Date(2026,10,25,18,30,10);
  const cfg={lumos:{...LUMOS_DEFAULTS,enabled:true,schedulesEnabled:true,botId:7,homeDir:dir}};
  const s=createLumosSchedules({db,getConfig:()=>cfg,send:async(text,temp)=>sent.push([text,temp]),clock:()=>new Date(at),spawnProcess,log:{error(){}}});
  for(const [id,script] of [['a','ok.py'],['b','quiet.py'],['c','bad.py']])s.upsert({id,name:id,cron:'30 18 * * *',script,enabled:true});
  const realNow=Date.now;Date.now=()=>at.getTime();
  try{await s.tick();await s.tick();}finally{Date.now=realNow;}
  assert.equal(sent.length,2,'quiet run sends nothing; repeated tick does not re-fire');
  assert.equal(sent[0][0],'Low tracker risk tonight.');assert.match(sent[1][0],/Scheduled check 'c' failed/);
  assert.match(envSeen,/^[0-9a-f]{32}$/);
  assert.equal(new Set(sent.map(x=>x[1])).size,2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lumos_schedule_runs').get().n,3);
  assert.equal(wakes(''),false);assert.equal(wakes('text\n{"wakeAgent": true}'),true);
});

test('each turn gets remembered facts and the owner message is offered for learning after the reply',async t=>{
  const extracted=[];
  const f=await fixture(t,{memory:{prefetch:async text=>text.includes('coffee')?['Jesse drinks oat-milk lattes']:[],extract:async m=>extracted.push(m)}});
  f.post(f.webhook(1,'Order my usual coffee'));await settle(f);
  const run=f.db.prepare('SELECT * FROM runs').get();
  assert.match(run.prompt,/Remembered facts that may be relevant[^]*oat-milk lattes/);
  f.finishRun(run.id,'done','Ordered.');await settle(f);
  assert.deepEqual(extracted,[[{role:'user',content:'Order my usual coffee'}]]);
});
