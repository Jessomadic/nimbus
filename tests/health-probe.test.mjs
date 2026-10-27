import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execute} from '../runtime/toolsets/operations.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-health-probe-'));
const oldData=process.env.NIMBUS_DATA,oldConfig=process.env.NIMBUS_CONFIG;
process.env.NIMBUS_DATA=path.join(directory,'data');process.env.NIMBUS_CONFIG=path.join(directory,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,'{}');
const {journalTool,UncertainAction,events}=await import('../runtime/journal.js');
const {db,q}=await import('../db.js');
const botId=Number(q('INSERT INTO bots(name) VALUES(?)').run('Synthetic health test').lastInsertRowid);
function newRun(){return Number(q('INSERT INTO runs(bot_id,thread,status) VALUES(?,?,?)').run(botId,'fixture','running').lastInsertRowid);}
async function listen(t,handler){
  const server=http.createServer(handler);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return{server,url:'http://127.0.0.1:'+server.address().port};
}
async function refusedURL(){
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port+'/health';await new Promise(resolve=>server.close(resolve));return url;
}
function failedObservation(result,kind){
  assert.equal(result.ok,false);assert.equal(result.completed,true);assert.equal(result.readOnly,true);assert.equal(result.uncertain,false);assert.equal(result.failure.kind,kind);assert.equal(result.error,undefined);assert.ok(result.elapsedMs>=0);
}

test('a real refused GET is a definitive failed probe, not a thrown uncertain action',async()=>{
  const url=await refusedURL(),result=await execute('health_probe',{url,timeoutMs:1000});
  failedObservation(result,'connection_refused');assert.equal(result.failure.code,'ECONNREFUSED');assert.equal(result.url,url);assert.equal(result.requestUrl,url);assert.equal(result.status,null);assert.equal(result.responseReceived,false);assert.equal(result.bytesRead,0);assert.equal(result.bodyComplete,false);assert.match(result.note,/does not establish/);
});

test('the probe-owned timeout returns a diagnostic result before any response',async t=>{
  const {url}=await listen(t,()=>{}),result=await execute('health_probe',{url,timeoutMs:100});
  failedObservation(result,'timeout');assert.equal(result.failure.code,'PROBE_TIMEOUT');assert.equal(result.status,null);assert.equal(result.responseReceived,false);assert.equal(result.bodyComplete,false);
});

test('HTTP failures retain actual status and bounded body evidence',async t=>{
  const {url}=await listen(t,(req,res)=>{res.writeHead(req.url==='/missing'?404:503,{'content-type':'application/json'});res.end(JSON.stringify({healthy:false,detail:'x'.repeat(300)}));});
  const unavailable=await execute('health_probe',{url,timeoutMs:1000}),missing=await execute('health_probe',{url:url+'/missing',maxBytes:100,timeoutMs:1000});
  failedObservation(unavailable,'http_error');assert.equal(unavailable.status,503);assert.equal(unavailable.failure.code,'HTTP_503');assert.equal(unavailable.outcome,'http_error');assert.equal(unavailable.json.healthy,false);assert.equal(unavailable.responseReceived,true);assert.equal(unavailable.bodyComplete,true);
  failedObservation(missing,'http_error');assert.equal(missing.status,404);assert.equal(missing.bytesRead,100);assert.equal(missing.truncated,true);assert.equal(missing.bodyComplete,false);assert.equal(missing.json,undefined);
});

test('redirect provenance survives a later refused endpoint and keeps GET-only transport',async t=>{
  const target=await refusedURL(),{url}=await listen(t,(req,res)=>{assert.equal(req.method,'GET');assert.equal(req.headers.authorization,undefined);res.writeHead(302,{location:target});res.end();});
  const result=await execute('health_probe',{url:url+'/start',timeoutMs:1000});
  failedObservation(result,'connection_refused');assert.equal(result.requestUrl,url+'/start');assert.equal(result.url,target);assert.equal(result.status,null);assert.deepEqual(result.redirects,[{from:url+'/start',to:target,status:302}]);
});

test('a body transport failure reports known response metadata and partial byte count honestly',async t=>{
  const timers=new Set();t.after(()=>{for(const timer of timers)clearTimeout(timer);});
  const {url}=await listen(t,(_req,res)=>{
    res.writeHead(200,{'content-type':'application/json','content-length':500});res.flushHeaders();res.write('{"part":');
    const timer=setTimeout(()=>{timers.delete(timer);res.destroy();},60);timers.add(timer);
  });
  const result=await execute('health_probe',{url,timeoutMs:1000});
  failedObservation(result,'transport_error');assert.equal(result.responseReceived,true);assert.equal(result.status,200);assert.equal(result.contentType,'application/json');assert.equal(result.bytesRead,8);assert.equal(result.bodyComplete,false);assert.equal(result.truncated,true);assert.equal(result.text,undefined);assert.equal(result.json,undefined);
});

test('DNS and TLS fetch causes return bounded static explanations without leaking raw errors',async t=>{
  const errors=[{code:'ENOTFOUND',kind:'dns_error'},{code:'EAI_AGAIN',kind:'dns_error'},{code:'CERT_HAS_EXPIRED',kind:'tls_error'},{code:'ETIMEDOUT',kind:'timeout'}];let current;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    assert.equal(options.redirect,'manual');assert.equal(options.headers,undefined);assert.equal(options.method,undefined);
    throw new TypeError('fetch failed',{cause:new AggregateError([Object.assign(new Error('PRIVATE_TRANSPORT_DETAIL'),{code:current.code})],'PRIVATE_AGGREGATE_DETAIL')});
  });
  for(current of errors){const result=await execute('health_probe',{url:'http://synthetic.invalid/health'});failedObservation(result,current.kind);assert.equal(result.failure.code,current.code);assert.ok(!JSON.stringify(result).includes('PRIVATE'));}
});

test('unexpected programming errors are not disguised as an endpoint outage',async t=>{
  const reason=new Error('Synthetic programming failure');t.mock.method(globalThis,'fetch',async()=>{throw reason;});
  await assert.rejects(execute('health_probe',{url:'http://synthetic.invalid/health'}),error=>error===reason);
});

test('pre-aborted task cancellation throws the original reason without starting a GET',async t=>{
  const controller=new AbortController(),reason=new Error('Synthetic caller stop');controller.abort(reason);let fetched=false;t.mock.method(globalThis,'fetch',async()=>{fetched=true;throw new Error('Should not execute');});
  await assert.rejects(execute('health_probe',{url:'http://synthetic.invalid/health'},{signal:controller.signal}),error=>error===reason);assert.equal(fetched,false);
});

test('in-flight caller cancellation still throws even though transport also fails',async t=>{
  let received;const arrived=new Promise(resolve=>{received=resolve;}),{url}=await listen(t,()=>received());
  const controller=new AbortController(),reason=new Error('Synthetic in-flight caller stop'),pending=execute('health_probe',{url,timeoutMs:1000},{signal:controller.signal});pending.catch(()=>{});
  await arrived;controller.abort(reason);await assert.rejects(pending,error=>error===reason);
});

test('initial invalid URLs and credential-bearing redirects are rejected before unsafe requests',async t=>{
  let unsafeRequested=false;const {url}=await listen(t,(req,res)=>{
    if(req.url==='/unsafe')unsafeRequested=true;
    res.writeHead(302,{location:url.replace('http://','http://user:PRIVATE@')+'/unsafe'});res.end();
  });
  await assert.rejects(execute('health_probe',{url:'file:///private'}),/HTTP/);
  await assert.rejects(execute('health_probe',{url:'http://user:PRIVATE@example.invalid'}),/credentials/);
  await assert.rejects(execute('health_probe',{url,timeoutMs:1000}),/credentials/);assert.equal(unsafeRequested,false);
});

test('refused and timeout health observations journal as done and are safely replayed from their receipts',async t=>{
  const {url:slow}=await listen(t,()=>{}),inputs=[{url:await refusedURL(),timeoutMs:1000},{url:slow,timeoutMs:100}];
  for(const [index,args] of inputs.entries()){
    const runId=newRun(),id='probe-'+index;let calls=0;
    const result=await journalTool({id,runId,name:'health_probe',args,execute:()=>{calls++;return execute('health_probe',args);}});
    assert.equal(result.ok,false);assert.equal(q('SELECT state FROM tool_calls WHERE id=?').get(runId+':'+id).state,'done');
    assert.equal(events(runId).filter(event=>event.type==='tool.completed').length,1);assert.ok(!events(runId).some(event=>event.type==='tool.uncertain'));
    const replay=await journalTool({id,runId,name:'health_probe',args,execute:()=>{calls++;throw new Error('Completed read must not be repeated');}});
    assert.deepEqual(replay,result);assert.equal(calls,1);
  }
});

test('mutation transport uncertainty and in-flight task cancellation retain journal review gates',async t=>{
  const runId=newRun(),args={path:'synthetic-only.txt'},uncertain=new UncertainAction('Synthetic mutation result unknown');let mutations=0;
  await assert.rejects(journalTool({id:'mutation',runId,name:'write_file',args,execute:async()=>{mutations++;throw uncertain;}}),UncertainAction);
  assert.equal(q('SELECT state FROM tool_calls WHERE id=?').get(runId+':mutation').state,'uncertain');
  await assert.rejects(journalTool({id:'mutation',runId,name:'write_file',args,execute:async()=>{mutations++;return{saved:true};}}),UncertainAction);assert.equal(mutations,1);
  await assert.rejects(journalTool({id:'mutation-transport',runId,name:'write_file',args,execute:async()=>{throw new TypeError('fetch failed');}}),UncertainAction);
  assert.equal(q('SELECT state FROM tool_calls WHERE id=?').get(runId+':mutation-transport').state,'uncertain');
  let received;const arrived=new Promise(resolve=>{received=resolve;}),{url}=await listen(t,()=>received()),controller=new AbortController();
  const cancelled=journalTool({id:'cancelled-probe',runId,name:'health_probe',args:{url},signal:controller.signal,execute:()=>execute('health_probe',{url},{signal:controller.signal})});cancelled.catch(()=>{});
  await arrived;controller.abort(new Error('Synthetic caller stop'));await assert.rejects(cancelled,UncertainAction);
  assert.equal(q('SELECT state FROM tool_calls WHERE id=?').get(runId+':cancelled-probe').state,'uncertain');
});

test.after(()=>{
  db.close();if(oldData===undefined)delete process.env.NIMBUS_DATA;else process.env.NIMBUS_DATA=oldData;if(oldConfig===undefined)delete process.env.NIMBUS_CONFIG;else process.env.NIMBUS_CONFIG=oldConfig;
  const absolute=path.resolve(directory);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^nimbus-health-probe-/);fs.rmSync(absolute,{recursive:true,force:true});
});
