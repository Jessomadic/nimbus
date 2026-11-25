import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import http from 'node:http';
import {defaults} from '../runtime/config.js';
import {localChat} from '../runtime/local.js';
import {fitInferenceMessages,inferenceView} from '../runtime/inference-context.js';
import {compactConversation} from '../runtime/compact.js';

const settings={automaticCompression:true,maxHistoryChars:24000,maxToolChars:1024};
function history(){const messages=[{role:'user',content:'Original goal and constraints must stay exact.'}];for(let i=0;i<80;i++){
  if(i%10===0)messages.push({role:'user',content:'User clarification '+i});
  messages.push({role:'assistant',content:null,tool_calls:[{id:'action-'+i,type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'proof-'+i,content:'A'.repeat(2000)})}}]},{role:'tool',tool_call_id:'action-'+i,content:JSON.stringify({path:'proof-'+i,content:'R'.repeat(4000)})});
}messages.push({role:'assistant',content:'Observed work retained.'},{role:'user',content:'LATEST_USER_REQUEST'});return messages;}

test('aggregate fitting keeps all user instructions, recent pairs and canonical evidence unchanged',()=>{
  const original=history(),before=JSON.stringify(original),view=fitInferenceMessages(original,{maxChars:24000,maxToolChars:1024});
  assert.ok(JSON.stringify(view).length<=24000);assert.equal(JSON.stringify(original),before);
  assert.deepEqual(view.filter(m=>m.role==='user'),original.filter(m=>m.role==='user'));
  assert.equal(view.at(-1).content,'LATEST_USER_REQUEST');assert.ok(view.some(m=>m.tool_calls?.some(call=>call.id==='action-79')));
  assert.match(view.find(m=>m.content?.startsWith('Partial inference history')).content,/not actions to replay/);
  for(const m of view.filter(m=>m.role==='tool'))assert.ok(view.some(a=>a.tool_calls?.some(call=>call.id===m.tool_call_id)));
  assert.match(JSON.stringify(view),/action-0/);
});
test('pending, uncertain, mismatched and duplicate call exchanges never disappear to fit a limit',()=>{
  for(const suffix of [
    [{role:'assistant',tool_calls:[{id:'unfinished',function:{name:'write_file',arguments:'X'.repeat(30000)}}]}],
    [{role:'assistant',tool_calls:[{id:'unknown',function:{name:'write_file',arguments:'X'.repeat(30000)}}]},{role:'tool',tool_call_id:'unknown',content:'{"uncertain":true}'}],
    [{role:'assistant',tool_calls:[{id:'expected',function:{name:'write_file',arguments:'X'.repeat(30000)}}]},{role:'tool',tool_call_id:'different',content:'{}'}],
  ])assert.throws(()=>fitInferenceMessages([...history(),...suffix],{maxChars:24000}),/unfinished actions exceed/);
});
test('disabled automatic compression asks for manual compact; oversized user text is never silently cut',()=>{
  assert.throws(()=>inferenceView(history(),{...settings,automaticCompression:false}),/Use \/compact/);
  assert.throws(()=>fitInferenceMessages([{role:'user',content:'U'.repeat(25000)}],{maxChars:24000}),/user instructions/);
});
test('local adapter fits history to the actually loaded context and reserves generation space',async t=>{
  let body;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.method==='GET')return res.end(JSON.stringify({models:[{key:'local-fixture',max_context_length:131072,loaded_instances:[{id:'loaded',config:{context_length:8192}}]}]}));
    let raw='';for await(const chunk of req)raw+=chunk;body=JSON.parse(raw);
    res.end(JSON.stringify({model:'local-fixture',choices:[{finish_reason:'stop',message:{role:'assistant',content:'READY'}}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const c=structuredClone(defaults);Object.assign(c.local,{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'local-fixture',approvedModels:['local-fixture'],tokenEnv:'NIMBUS_UNSET_CONTEXT_FIXTURE',tokenDpapiFile:''});
  const messages=history().slice(0,31),before=JSON.stringify(messages);
  const result=await localChat(messages,{c,getConfig:()=>c,guard:async()=>{}});
  assert.equal(result.contextTokens,8192);assert.equal(body.max_tokens,4096);assert.ok(JSON.stringify(body.messages).length<(8192-4096)*2.5);
  assert.equal(body.messages[0].content,messages[0].content);assert.equal(JSON.stringify(messages),before);
});
test('manual compact archives exact history and paused checkpoints and refuses to interrupt active tasks',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-context-')),db=new DatabaseSync(':memory:');
  t.after(()=>{db.close();fs.rmSync(directory,{recursive:true,force:true});});
  db.exec('CREATE TABLE worker_history(bot_id INTEGER,thread TEXT,messages TEXT,updated_at INTEGER);CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,status TEXT,checkpoint TEXT);');
  const raw=JSON.stringify(history()),checkpoint=JSON.stringify({messages:history(),steps:9,instructions:'KEEP_EXACT_BRIEF'});
  db.prepare('INSERT INTO worker_history VALUES(?,?,?,0)').run(1,'bot:1',raw);
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(11,1,'bot:1','paused',checkpoint);
  const args={query:sql=>db.prepare(sql),botId:1,thread:'bot:1',dataDir:directory,settings};
  const result=compactConversation(args),archive=JSON.parse(fs.readFileSync(result.archive,'utf8'));
  assert.equal(result.changed,true);assert.equal(archive.history,raw);assert.equal(archive.runs[0].checkpoint,checkpoint);
  assert.ok(result.afterCharacters<=24000);const retained=JSON.parse(db.prepare('SELECT checkpoint FROM runs').get().checkpoint);
  assert.equal(retained.steps,9);assert.equal(retained.instructions,'KEEP_EXACT_BRIEF');assert.equal(db.prepare('SELECT status FROM runs').get().status,'paused');
  db.prepare("UPDATE runs SET status='running'").run();assert.throws(()=>compactConversation(args),/current task/);
  assert.throws(()=>compactConversation({...args,thread:'bot:2'}),/worker chat/);
});
