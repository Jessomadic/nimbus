import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { chromium } from 'playwright';
import { BrowserGroups } from '../runtime/browser.js';
const server=http.createServer((req,res)=>{
 if(req.url==='/wait') return;
 if(req.url.startsWith('/pic')){res.setHeader('Content-Type','image/svg+xml');res.end('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"/>');return;}
 res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Independent fixture</title>
 <button id="ask" onclick="window.calls=(window.calls||0)+1;document.querySelector('output').textContent=prompt('review prompt')">ask</button>
 <button id="ok" onclick="document.querySelector('output').textContent=confirm('review confirm')">ok</button>
 <button id="double" onclick="alert('one');alert('two')">double</button><output></output>
 <img src="/pic?private=synthetic" alt="independent"><img src="data:image/png;base64,AA=="><div style="height:6000px"></div>
 <script>console.log('independent early');setTimeout(()=>{throw new Error('independent pageerror')},10)</script>`);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-review-browser-'));
let forbidden=0, version;
const browserType={launch:async()=>{
 const browser=await chromium.launch({headless:true}); version=browser.version();
 const newContext=browser.newContext.bind(browser);
 browser.newContext=async opts=>{const context=await newContext(opts);await context.route('**/*',route=>{
   if(new URL(route.request().url()).origin===origin) return route.continue();
   forbidden++; return route.abort();
 });return context;};return browser;
}};
const make=()=>new BrowserGroups({dataDir:dir,browserType,protectState:async x=>x,unprotectState:async x=>x});
const b=make(); let a,sibling,other,stale;
const page=async (owner,id)=>(await b.group(owner)).tabs.get(id);
test('Reviewer independent Chromium acceptance',{timeout:60000},async t=>{
 try{
 await t.test('owned pages early console errors and synthetic-only network',async()=>{
 a=(await b.perform(101,{action:'open',url:origin})).tabId;
 sibling=(await b.perform(101,{action:'open',url:origin})).tabId;
 other=(await b.perform(102,{action:'open',url:origin})).tabId;
 await (await page(101,a)).waitForTimeout(50);
 const c=await b.perform(101,{action:'console',tabId:a});
 assert(c.messages.some(x=>x.text==='independent early'));assert(c.messages.some(x=>x.type==='pageerror'));
 });
 await t.test('scroll clamps to top/bottom and rejects bad numeric inputs',async()=>{
 for(const pixels of [0,-1,1.1,'500',2001])await assert.rejects(b.perform(101,{action:'scroll',tabId:a,direction:'down',pixels}),/pixels/);
 for(let i=0;i<5;i++)await b.perform(101,{action:'scroll',tabId:a,direction:'down',pixels:2000});
 const bottom=await b.perform(101,{action:'scroll',tabId:a,direction:'down',pixels:2000});assert(bottom.position.y>0);
 for(let i=0;i<5;i++)await b.perform(101,{action:'scroll',tabId:a,direction:'up',pixels:2000});
 assert.equal((await b.perform(101,{action:'scroll',tabId:a,direction:'up'})).position.y,0);
 });
 await t.test('images real natural dimensions and URL query suppression',async()=>{
 const r=await b.perform(101,{action:'images',tabId:a});assert.equal(r.images.length,1);
 assert.deepEqual(r.images[0],{src:origin+'/pic',alt:'independent',width:7,height:9});
 });
 await t.test('console bounded strings ring and atomic clear',async()=>{
 await (await page(101,a)).evaluate(()=>{for(let i=0;i<110;i++)console.log('z'.repeat(4000));console.warn('Bearer syntheticReviewSecret');});
 const r=await b.perform(101,{action:'console',tabId:a,clear:true});
 assert.equal(r.messages.length,100);assert(r.dropped>=11);assert(r.messages.every(x=>x.text.length<=2048));
 assert(!JSON.stringify(r).includes('syntheticReviewSecret'));
 assert.deepEqual((await b.perform(101,{action:'console',tabId:a})).messages,[]);
 });
 await t.test('cross-owner denial for all new operations and context state isolation',async()=>{
 for(const action of ['images','scroll','console','dialog']) await assert.rejects(b.perform(102,{action,tabId:a,direction:'down',dialogAction:'accept',dialogId:'fake'}),/does not belong/);
 await (await page(101,a)).evaluate(()=>localStorage.setItem('review','owner101'));
 assert.equal(await (await page(102,other)).evaluate(()=>localStorage.getItem('review')),null);
 });
 await t.test('pending prompt exact response once and group effectful gate',async()=>{
 const r=await b.perform(101,{action:'click',tabId:a,selector:'#ask'});assert.equal(r.status,'dialog_pending');stale=r.pending_dialogs[0].id;
 await assert.rejects(b.perform(101,{action:'click',tabId:sibling,selector:'#ok'}),/unfinished/);
 await assert.rejects(b.perform(102,{action:'dialog',tabId:other,dialogAction:'accept',dialogId:stale}),/stale/);
 await assert.rejects(b.perform(101,{action:'dialog',tabId:a,dialogAction:'accept',dialogId:stale,promptText:'x'.repeat(4097)}),/4096/);
 const done=await b.perform(101,{action:'dialog',tabId:a,dialogAction:'accept',dialogId:stale,promptText:'review answer'});
 assert.equal(done.responded,stale);
 assert.equal(await (await page(101,a)).evaluate(()=>window.calls),1);
 assert.match((await b.perform(101,{action:'snapshot',tabId:a})).snapshot,/review answer/);
 await assert.rejects(b.perform(101,{action:'dialog',tabId:a,dialogAction:'accept',dialogId:stale}),/stale/);
 });
 await t.test('confirm dismiss and sequential modal recovery',async()=>{
 let r=await b.perform(101,{action:'click',tabId:a,selector:'#ok'});
 await b.perform(101,{action:'dialog',tabId:a,dialogAction:'dismiss',dialogId:r.pending_dialogs[0].id});
 assert.match((await b.perform(101,{action:'snapshot',tabId:a})).snapshot,/false/);
 r=await b.perform(101,{action:'click',tabId:a,selector:'#double'});
 r=await b.perform(101,{action:'dialog',tabId:a,dialogAction:'accept',dialogId:r.pending_dialogs[0].id});
 assert.equal(r.status,'dialog_pending');
 await b.perform(101,{action:'dialog',tabId:a,dialogAction:'dismiss',dialogId:r.pending_dialogs[0].id});
 });
 await t.test('queued/pre cancellation has no page effects; active cancellation preserves sibling and owner',async()=>{
 const pre=AbortSignal.abort(Error('pre-review'));
 await assert.rejects(b.perform(103,{action:'open',url:origin},{signal:pre}),/pre-review/);assert(!b.groups.has('103'));
 const release=await (await b.group(101)).slots.acquire(),c=new AbortController();
 const queued=b.perform(101,{action:'scroll',tabId:a,direction:'down'},{signal:c.signal});c.abort(Error('queued-review'));release();
 await assert.rejects(queued,/queued-review/);
 const active=new AbortController(),p=b.perform(101,{action:'click',tabId:a,selector:'#never'},{signal:active.signal});
 setTimeout(()=>active.abort(),120);await assert.rejects(p,e=>e.name==='UncertainAction');
 assert.equal((await b.perform(101,{action:'tabs'})).tabs.length,1);
 assert.match((await b.perform(101,{action:'snapshot',tabId:sibling})).snapshot,/ask/);
 assert.match((await b.perform(102,{action:'snapshot',tabId:other})).snapshot,/ask/);
 });
 await t.test('restart restores isolated synthetic state but never old tab/dialog handles',async()=>{
 await b.perform(101,{action:'snapshot',tabId:sibling});await b.close();
 const fresh=make();try{
 const r=await fresh.perform(101,{action:'open',url:origin});
 const p=(await fresh.group(101)).tabs.get(r.tabId);assert.equal(await p.evaluate(()=>localStorage.getItem('review')),'owner101');
 await assert.rejects(fresh.perform(101,{action:'dialog',tabId:a,dialogAction:'accept',dialogId:stale}),/does not belong/);
 }finally{await fresh.close();}
 });
 await t.test('no production network attempted',()=>assert.equal(forbidden,0));
 }finally{await b.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log(JSON.stringify({chromium:version,forbiddenNetworkRequests:forbidden,syntheticStateDir:dir}));}
});
