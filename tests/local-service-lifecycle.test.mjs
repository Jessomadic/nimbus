import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createLocalService} from '../runtime/local-service.js';
import {createConfigUpdater} from '../runtime/local-service-config.js';
test('ordinary configuration validation errors are not marked as startup unavailable',async()=>{
  const invalid=new Error('invalid context config');let starts=0,saves=0;
  const update=createConfigUpdater({read:()=>({local:{enabled:false}}),save:()=>{saves++;throw invalid;},start:async()=>{starts++;}});
  await assert.rejects(update({context:{maxHistoryChars:10}}),error=>error===invalid&&error.statusCode===undefined);
  assert.equal(starts,0);assert.equal(saves,1);
});
test('boot off, concurrent enable, queued disable, in-flight preservation, reenable and shutdown',async()=>{
  let c={local:{enabled:false,baseUrl:'http://127.0.0.1:0/v1',model:'external',timeoutSeconds:5,managed:{enabled:true,lmsBin:'stub',upstreamUrl:'http://127.0.0.1:1/v1'}}};
  let commands=0,entered,release;
  const admitted=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const service=createLocalService({getConfig:()=>structuredClone(c),getToken:async()=> 'test',
    run:async(bin,args)=>{commands++;assert.deepEqual(args,['ps','--json']);return '[{"identifier":"external"}]';},
    guard:async()=>{entered();await hold;},
    request:async()=>new Response('{}',{headers:{'content-type':'application/json'}})});
  try{
    assert.equal(await service.start(),null);
    c.local.enabled=true;
    const servers=await Promise.all(Array.from({length:10},()=>service.start()));
    assert.ok(servers.every(s=>s===servers[0]));assert.equal(commands,0);
    const base='http://127.0.0.1:'+servers[0].address().port;
    assert.equal((await fetch(base+'/health')).status,200);
    const post=()=>fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test'},body:'{"model":"external"}'});
    const first=post();await admitted;
    const queued=post();
    await new Promise(r=>setTimeout(r,50));
    c.local.enabled=false;
    assert.equal((await post()).status,503);
    release();
    assert.equal((await first).status,200);
    assert.equal((await queued).status,503);
    assert.equal(commands,1);
    c.local.enabled=true;
    assert.equal(await service.start(),servers[0]);
    assert.equal((await post()).status,200);
    await service.close();
    assert.equal(servers[0].listening,false);
    await assert.rejects(service.start(),/shutting down/);
  }finally{release?.();await service.close();}
});
test('bind failure is honest, retry bounded to explicit new call, config updates serialize and disable failed enable',async()=>{
  const blocker=http.createServer();await new Promise(r=>blocker.listen(0,'127.0.0.1',r));
  let c={local:{enabled:true,baseUrl:'http://127.0.0.1:'+blocker.address().port+'/v1',managed:{enabled:true}}};
  const service=createLocalService({getConfig:()=>c});
  try{await assert.rejects(service.start(),/EADDRINUSE/);}
  finally{await new Promise(r=>blocker.close(r));}
  const s=await service.start();assert.equal(s.listening,true);await service.close();
  c={local:{enabled:false}};
  let active=0,max=0;
  const update=createConfigUpdater({read:()=>structuredClone(c),save:p=>{c.local={...c.local,...p.local};return structuredClone(c);},
    start:async next=>{active++;max=Math.max(active,max);await new Promise(r=>setTimeout(r,5));active--;if(next.local.enabled)throw Error('bind failed');}});
  const results=await Promise.allSettled([update({local:{enabled:true}}),update({local:{enabled:false}})]);
  assert.equal(results[0].status,'rejected');assert.equal(results[0].reason.statusCode,503);assert.match(results[0].reason.message,/bind failed/);assert.equal(results[1].value.local.enabled,false);
  assert.equal(max,1);assert.equal(c.local.enabled,false);
});
