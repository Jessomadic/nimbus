import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import vm from 'node:vm';
import { BrowserGroups } from '../runtime/browser.js';

test('browser schema advertises only bounded owned-page operations',()=>{
 const source=fs.readFileSync(new URL('../runtime/tools.js',import.meta.url),'utf8');
 const start=source.indexOf("spec('browser',");
 const end=source.indexOf("\n  spec('ask_worker'",start);
 const schema=vm.runInNewContext(source.slice(start,end).trim().replace(/,$/,''),{text:{type:'string'},spec:(name,description,properties,required)=>({name,description,properties,required})});
 for(const action of ['scroll','images','console','dialog']) assert(schema.properties.action.enum.includes(action));
 for(const action of ['cdp','exec','evaluate']) assert(!schema.properties.action.enum.includes(action));
 assert.equal(schema.properties.pixels.maximum,2000);
 assert.equal(schema.properties.promptText.maxLength,4096);
 assert(!schema.properties.expression);assert(!schema.properties.method);
});

const html = `<!doctype html><title>Fixture</title><button id="prompt" onclick="document.querySelector('#result').textContent=prompt('Synthetic question')">Prompt</button>
<button id="confirm" onclick="document.querySelector('#result').textContent=confirm('Synthetic confirm')">Confirm</button>
<button id="two" onclick="alert('First');alert('Second')">Two</button>
<output id="result"></output><img src="/image.svg?token=synthetic-image-token" alt="fixture"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
<div style="height:5000px">Tall</div><script>console.log('fixture ready'); console.warn('password=synthetic-password'); console.log('Bearer synthetic-bearer'); setTimeout(()=>{throw Error('fixture exception')},20);</script>`;
const server = http.createServer((req,res) => {
 if(req.url==='/slow') return;
 if(req.url==='/load-dialog') { res.end('<script>alert("Load dialog")</script><body>Loaded</body>'); return; }
 res.setHeader('Content-Type',req.url.startsWith('/image.svg')?'image/svg+xml':'text/html');
 res.end(req.url.startsWith('/image.svg')?'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="12"></svg>':html);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url = 'http://127.0.0.1:'+server.address().port;
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-owned-browser-'));
const browserType = { launch: () => chromium.launch({headless:true}) };
const make = () => new BrowserGroups({dataDir:dir,browserType,protectState:async s=>s,unprotectState:async s=>s});
const b=make();
const open=()=>b.perform(1,{action:'open',url});
let tab;
test('owned browser candidate actual Chromium',{timeout:30000},async t=>{
 try {
 await t.test('open captures early console and exceptions',async()=>{
  tab=(await open()).tabId;
  const page=(await b.group(1)).tabs.get(tab);
  await page.waitForTimeout(60);
  const r=await b.perform(1,{action:'console',tabId:tab});
  assert(r.messages.some(x=>x.text==='fixture ready'));
  assert(r.messages.some(x=>x.type==='pageerror'));
  assert(!JSON.stringify(r).includes('synthetic-password'));
  assert(!JSON.stringify(r).includes('synthetic-bearer'));
 });
 await t.test('scroll both directions, validation, images metadata and URL policy',async()=>{
  const down=await b.perform(1,{action:'scroll',tabId:tab,direction:'down'});
  assert.equal(down.position.y,500);
  const up=await b.perform(1,{action:'scroll',tabId:tab,direction:'up',pixels:200});
  assert.equal(up.position.y,300);
  await assert.rejects(b.perform(1,{action:'scroll',tabId:tab,direction:'left'}),/direction/);
  await assert.rejects(b.perform(1,{action:'scroll',tabId:tab,direction:'up',pixels:2001}),/pixels/);
  const r=await b.perform(1,{action:'images',tabId:tab});
  assert.equal(r.images.length,1); assert.equal(r.images[0].alt,'fixture');
  assert.equal(r.images[0].width,10); assert(!r.images[0].src.includes('?'));
 });
 await t.test('console bounded retention clear and owner isolation',async()=>{
  const page=(await b.group(1)).tabs.get(tab);
  await page.evaluate(()=>{for(let i=0;i<130;i++)console.log('line '+i)});
  const r=await b.perform(1,{action:'console',tabId:tab,clear:true});
  assert.equal(r.messages.length,100); assert(r.dropped>=30);
  assert.equal((await b.perform(1,{action:'console',tabId:tab})).messages.length,0);
  for(const action of ['console','images','scroll','dialog','close']) await assert.rejects(b.perform(2,{action,tabId:tab}),/does not belong/);
  assert.equal((await b.perform(2,{action:'tabs'})).tabs.length,0);
  await assert.rejects(b.perform(1,{action:'console',tabId:tab,expression:'document.cookie'}),/not enabled/);
  await assert.rejects(b.perform(1,{action:'cdp',tabId:tab,method:'Target.getTargets'}),/not enabled/);
 });
 await t.test('prompt, stale ID, pending action gating and exact response',async()=>{
  const r=await b.perform(1,{action:'click',tabId:tab,selector:'#prompt'});
  assert.equal(r.status,'dialog_pending');const id=r.pending_dialogs[0].id;
  assert.equal((await b.perform(1,{action:'snapshot',tabId:tab})).pending_dialogs[0].id,id);
  await assert.rejects(b.perform(1,{action:'dialog',tabId:tab,dialogAction:'accept',dialogId:'stale'}),/stale/);
  await assert.rejects(b.perform(1,{action:'scroll',tabId:tab,direction:'down'}),/pending/);
  const done=await b.perform(1,{action:'dialog',tabId:tab,dialogAction:'accept',dialogId:id,promptText:'synthetic answer'});
  assert.equal(done.responded,id);
  assert.match((await b.perform(1,{action:'snapshot',tabId:tab})).snapshot,/synthetic answer/);
  await assert.rejects(b.perform(1,{action:'dialog',tabId:tab,dialogAction:'accept',dialogId:id}),/stale/);
 });
 await t.test('dismiss confirm and sequential dialogs do not deadlock slot',async()=>{
  let r=await b.perform(1,{action:'click',tabId:tab,selector:'#confirm'});
  await b.perform(1,{action:'dialog',tabId:tab,dialogAction:'dismiss',dialogId:r.pending_dialogs[0].id});
  assert.match((await b.perform(1,{action:'snapshot',tabId:tab})).snapshot,/false/);
  r=await b.perform(1,{action:'click',tabId:tab,selector:'#two'});
  r=await b.perform(1,{action:'dialog',tabId:tab,dialogAction:'accept',dialogId:r.pending_dialogs[0].id});
  assert.equal(r.status,'dialog_pending');
  await b.perform(1,{action:'dialog',tabId:tab,dialogAction:'dismiss',dialogId:r.pending_dialogs[0].id});
 });
 await t.test('load dialog and bounded images',async()=>{
  const loaded=await b.perform(1,{action:'open',url:url+'/load-dialog'});
  assert.equal(loaded.status,'dialog_pending');
  await assert.rejects(b.perform(1,{action:'open',url}),/unfinished/);
  assert((await b.perform(1,{action:'tabs'})).tabs.some(x=>x.pending_dialogs.length));
  await b.perform(1,{action:'dialog',tabId:loaded.tabId,dialogAction:'dismiss',dialogId:loaded.pending_dialogs[0].id});
  await b.perform(1,{action:'close',tabId:loaded.tabId});
  const page=(await b.group(1)).tabs.get(tab);
  await page.evaluate(()=>{
    console.log('Authorization: Basic synthetic-header');
    console.log('Cookie: sid=synthetic-cookie');
    console.log('password=abc');
    for(let i=0;i<501;i++) {const img=document.createElement('img'); img.src='/image.svg';document.body.append(img);}
  });
  const images=await b.perform(1,{action:'images',tabId:tab});
  assert(images.truncated);assert(images.images.length<=500);
  const output=JSON.stringify(await b.perform(1,{action:'console',tabId:tab}));
  assert(!output.includes('synthetic-header'));assert(!output.includes('synthetic-cookie'));assert(!output.includes('password=abc'));
 });
 await t.test('beforeunload response resumes navigation; persistence failure is uncertain',async()=>{
  const page=(await b.group(1)).tabs.get(tab);
  await page.evaluate(()=>window.addEventListener('beforeunload',event=>{event.preventDefault();event.returnValue='';}));
  const pending=await b.perform(1,{action:'navigate',tabId:tab,url:url+'/?next=1'});
  assert.equal(pending.pending_dialogs[0].type,'beforeunload');
  const done=await b.perform(1,{action:'dialog',tabId:tab,dialogAction:'accept',dialogId:pending.pending_dialogs[0].id});
  assert.match(done.url,/next=1/);
  const protect=b.protectState;
  b.protectState=async()=>{throw Error('synthetic save failure')};
  try { await assert.rejects(b.perform(1,{action:'snapshot',tabId:tab}),/could not be saved/); }
  finally {b.protectState=protect;}
 });
 await t.test('preabort, queued cancel and active cancel close only owned target',async()=>{
  const aborted=AbortSignal.abort(new Error('pre-cancel'));
  await assert.rejects(b.perform(3,{action:'open',url},{signal:aborted}),/pre-cancel/);
  assert(!b.groups.has('3'));
  const group=await b.group(1), release=await group.slots.acquire();
  const queued=new AbortController();
  const promise=b.perform(1,{action:'images',tabId:tab},{signal:queued.signal});
  queued.abort(new Error('queued cancel'));release();
  await assert.rejects(promise,/queued cancel/);
  const controller=new AbortController();
  const active=b.perform(1,{action:'click',tabId:tab,selector:'#absent'},{signal:controller.signal});
  setTimeout(()=>controller.abort(),100);
  await assert.rejects(active,/canceled/);
  await assert.rejects(b.perform(1,{action:'images',tabId:tab}),/does not belong/);
  assert.equal((await b.perform(2,{action:'tabs'})).tabs.length,0);
 });
 await t.test('open navigation cancellation and popup observer cleanup',async()=>{
  const c=new AbortController();
  const p=b.perform(1,{action:'open',url:url+'/slow'},{signal:c.signal});
  setTimeout(()=>c.abort(),150);
  await assert.rejects(p,/canceled/);
  tab=(await open()).tabId;
  const page=(await b.group(1)).tabs.get(tab);
  const popupPromise=page.waitForEvent('popup');
  await page.evaluate(()=>window.open('/','_blank'));const popup=await popupPromise;
  await popup.waitForLoadState();
  assert(b.pageState.has(popup));
  await popup.close();assert(!b.pageState.has(popup));
 });
 await t.test('closed tab, context separation and restart invalidate old dialog IDs',async()=>{
  const other=(await b.perform(2,{action:'open',url})).tabId;
  const p1=(await b.group(1)).tabs.get(tab),p2=(await b.group(2)).tabs.get(other);
  await p1.evaluate(()=>localStorage.setItem('synthetic','one'));
  assert.equal(await p2.evaluate(()=>localStorage.getItem('synthetic')),null);
  const pending=await b.perform(1,{action:'click',tabId:tab,selector:'#prompt'});
  await b.perform(1,{action:'close',tabId:tab});
  assert(!b.pageState.has(p1));
  await assert.rejects(b.perform(1,{action:'snapshot',tabId:tab}),/does not belong/);
  await b.close();
  const restart=make();
  try { await assert.rejects(restart.perform(1,{action:'dialog',tabId:tab,dialogAction:'accept',dialogId:pending.pending_dialogs[0].id}),/does not belong/); }
  finally {await restart.close();}
 });
 await t.test('shutdown with unresolved modal is bounded',async()=>{
  const fresh=make();
  const opened=await fresh.perform(4,{action:'open',url});
  await fresh.perform(4,{action:'click',tabId:opened.tabId,selector:'#prompt'});
  await fresh.close();assert.equal(fresh.groups.size,0);
 });
 } finally {await b.close(); server.closeAllConnections(); await new Promise(r=>server.close(r));}
});
