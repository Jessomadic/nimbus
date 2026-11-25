import {artifactDirectory} from './helpers/artifact-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
const artifacts=artifactDirectory('panel-gestures',{exportRoot:process.env.NIMBUS_GESTURE_ARTIFACTS || process.env.NIMBUS_TEST_ARTIFACTS});
for(const [name,engine] of Object.entries({chromium,webkit})) test(name+' panel gestures (WebKit synthetic routing only)',async()=>{
 const browser=await engine.launch({headless:true});
 try{
 const context=await browser.newContext({hasTouch:true,isMobile:true,serviceWorkers:'block'});
 const page=await context.newPage();
 await page.addInitScript(()=>{const Native=window.EventSource;window.EventSource=class extends Native{constructor(...args){super(...args);window.testEventSource=this;}};});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async r=>{
 const u=new URL(r.request().url());
 if(u.hostname!=='nimbus.test')return r.abort();
 if(u.pathname==='/api/events' || r.request().resourceType()==='eventsource')return r.fulfill({contentType:'text/event-stream',body:'retry: 600000\n: fixture\n\n'});
 if(u.pathname==='/api/runtime/config')return r.fulfill({json:{local:{baseUrl:'http://127.0.0.1:8080',model:'fixture'},workers:{maxConcurrent:4,permissionMode:'rules'},cloud:{maxConcurrent:2},browser:{headless:true},context:{automaticCompression:true,maxHistoryChars:240000,maxToolChars:12000}}});
 if(u.pathname==='/api/runtime')return r.fulfill({json:{workers:[],queue:[],local:{available:true,model:'fixture'},cloud:{available:false},browser:{headless:true}}});
 if(u.pathname.startsWith('/api/'))return r.fulfill({contentType:'application/json',body:JSON.stringify(u.pathname==='/api/state'?{bots:[{id:1,name:'Orchestrator',role:'orchestrator',is_orchestrator:true,plugins:[],approval_rules:[],allow_rules:[],status:{state:'idle'},color:'#3b82f6',effort:'medium'}],rooms:[],last:{},routines:[],upNext:[],learned:[],approvals:[],computers:[],usage:{},settings:{}}:u.pathname.endsWith('/messages')?[]:{})});
 try{const f=u.pathname==='/'?'index.html':u.pathname.slice(1);return r.fulfill({body:await readFile(new URL('../public/'+f,import.meta.url)),contentType:({js:'text/javascript',css:'text/css',html:'text/html'})[f.split('.').at(-1)]||'application/octet-stream'});}catch{return r.fulfill({status:404,body:''});}
 });
 await mkdir(artifacts,{recursive:true});
 const cdp=name==='chromium'?await context.newCDPSession(page):null;

 async function drag(x,y,dx,dy,{cancel=false,type='touch'}={}) {
 if(cdp && type==='touch') {
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 for(let i=1;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+dx*i/8,y:y+dy*i/8}]});await page.waitForTimeout(16);}
 await cdp.send('Input.dispatchTouchEvent',{type:cancel?'touchCancel':'touchEnd',touchPoints:[]});
 } else await page.evaluate(({x,y,dx,dy,cancel,type})=>{
 const el=document.elementFromPoint(x,y);
 const emit=(t,xx,yy)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerType:type,pointerId:7,clientX:xx,clientY:yy}));
 emit('pointerdown',x,y);emit('pointermove',x+dx,y+dy);emit(cancel?'pointercancel':'pointerup',x+dx,y+dy);
 },{x,y,dx,dy,cancel,type});
 await page.waitForTimeout(300);
 }
 // #msg is rendered by app.js independently of pwa.js's dynamic shell import.
 // The dock is mounted synchronously before gesture installation in that same task.
 async function waitForGestureReady() {
 await page.waitForSelector('#msg');
 await page.waitForSelector('.phone-dock',{state:'attached'});
 // Cross the layout/render boundary so queued viewport resize cannot cancel contact.
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
 }
 const isOpen=id=>page.locator(id).evaluate(e=>e.classList.contains('open'));
 for(const [width,height] of [[320,568],[393,844],[844,393]]) {
 await page.setViewportSize({width,height});await page.goto('http://nimbus.test/#bot:1');await waitForGestureReady();
 for(const y of [90,Math.round(height/2),height-120]) {
 await drag(36,y,90,0);assert.equal(await isOpen('#side'),true,'left zone opens '+width+'/'+y);
 await drag(160,y,-90,0);assert.equal(await isOpen('#side'),false,'ordinary panel closes '+width+'/'+y);
 const b=await page.locator('[data-phone=settings]').boundingBox();
 await page.touchscreen.tap(b.x+b.width/2,b.y+b.height/2);
 await page.waitForSelector('body>.popover');await page.keyboard.press('Escape');
 await drag(width-36,y,-90,0);assert.equal(await isOpen('#aside'),true,'right zone opens');
 await drag(width-160,y,90,0);assert.equal(await isOpen('#aside'),false,'activity closes');
 }
 for(const [x,y,dx,dy,opts] of [[36,180,20,0,{}],[36,180,-20,0,{}],[36,180,90,100,{}],[12,180,90,0,{}],[36,height-10,90,0,{}],[36,180,90,0,{cancel:true}],[36,180,90,0,{type:'mouse'}]]) {
 await drag(x,y,dx,dy,opts);assert.equal(await isOpen('#side'),false,'guard');
 }
 assert.equal(await page.locator('.panel-swipe-handle').count(),0);
 await page.screenshot({path:artifacts+'/'+name+'-'+width+'.png'});
 }

 await page.setViewportSize({width:393,height:844});await page.goto('http://nimbus.test/#bot:1');await waitForGestureReady();
 // Ordinary SSE-style leaf refresh must not cancel a stable pane's swipe.
 await drag(36,200,90,0);
 if(cdp){
 const row=await page.locator('#side .side-item').first().boundingBox();
 const x=row.x+row.width/2,y=row.y+row.height/2;
 await page.evaluate(({x,y})=>window.heldRow=document.elementFromPoint(x,y).closest('.side-item'),{x,y});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-20,y}]});
 const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');
 await page.evaluate(()=>window.testEventSource.dispatchEvent(new Event('state_changed')));
 await response;await page.waitForTimeout(35);
 assert.equal(await page.evaluate(()=>window.heldRow.isConnected),true,'real SSE refresh preserves touched row');
 for(let i=3;i<=8;i++){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-90*i/8,y}]});await page.waitForTimeout(16);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(100);
 assert.equal(await page.evaluate(()=>window.heldRow.isConnected),false,'coalesced row refresh after release');
 } else await drag(160,200,-90,0);
 await page.waitForTimeout(300);assert.equal(await isOpen('#side'),false,'same-host child refresh closes');
 // A structural host replacement is not an ordinary refresh and must cancel.
 if(cdp){
 await drag(36,200,90,0);
 const b=await page.locator('#side .side-item').first().boundingBox(),x=b.x+b.width/2,y=b.y+b.height/2;
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-25,y}]});
 await page.locator('#side').evaluate(e=>e.replaceWith(e.cloneNode(true)));
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-90,y}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(100);
 assert.equal(await isOpen('#side'),true,'native host replacement cancels closing');
 // Same-hash goto is not a reload: discard the deliberately replaced open host.
 await page.reload();await waitForGestureReady();
 }
 // Real controls: an edge tap remains a tap, whereas a swipe must not activate it.
 await page.evaluate(()=>{
  const b=document.createElement('button');b.id='edge-test';b.textContent='Edge control';b.style.cssText='position:fixed;left:24px;top:160px;width:32px;height:44px;z-index:30';
  window.edgeHits=0;b.onclick=()=>window.edgeHits++;document.querySelector('#main').append(b);
 });
 await page.touchscreen.tap(36,180);assert.equal(await page.evaluate(()=>window.edgeHits),1);
 await drag(36,180,90,0);assert.equal(await isOpen('#side'),true);assert.equal(await page.evaluate(()=>window.edgeHits),1,'no clickthrough');
 await drag(160,180,-90,0);await page.locator('#edge-test').evaluate(e=>e.remove());
 for(const mode of ['selection','multi','replace','resize','overlay','pending-contact','pending-resize']) {
 await page.evaluate(mode=>{
  const el=document.elementFromPoint(36,200);
  const emit=(t,x=36,y=200,id=81)=>el.dispatchEvent(new PointerEvent(t,{bubbles:true,pointerType:'touch',pointerId:id,clientX:x,clientY:y}));
  if(mode==='selection'){const r=document.createRange();r.selectNodeContents(document.querySelector('.head .title'));getSelection().addRange(r);}
  emit('pointerdown');emit('pointermove',126);
  if(mode==='multi'){emit('pointerdown',60,200,82);emit('pointerup',60,200,82);}
  if(mode==='replace'){const host=document.querySelector('#main');host.replaceWith(host.cloneNode(true));}
  if(mode==='resize')window.dispatchEvent(new Event('resize'));
  if(mode==='overlay'){const p=document.createElement('div');p.className='popover';document.body.append(p);}
  emit('pointerup',126);
  if(mode==='pending-contact'){document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerType:'mouse'}));}
  if(mode==='pending-resize')window.dispatchEvent(new Event('resize'));
  getSelection().removeAllRanges();
 },mode);
 await page.waitForTimeout(100);assert.equal(await isOpen('#side'),false,mode);
 await page.locator('body>.popover').evaluateAll(es=>es.forEach(e=>e.remove()));
 }
 await page.goto('http://nimbus.test/#bot:1');await waitForGestureReady();
 await page.locator('.thread').evaluate(e=>{e.innerHTML='<pre id="horizontal" style="width:250px;overflow:auto;white-space:pre">'+('code '.repeat(200))+'</pre><div style="height:2400px">Scrollable text</div>';});
 // The chat follows newly inserted content to the bottom. Bring the test
 // target into view before hit-testing; offscreen coordinates hit no element.
 await page.locator('#horizontal').scrollIntoViewIfNeeded();
 const b=await page.locator('#horizontal').boundingBox();
 assert.ok(b.y>=0 && b.y+10<844,'horizontal drag target is onscreen');
 await drag(b.x+200,b.y+10,-120,0);
 if(cdp)assert.ok(await page.locator('#horizontal').evaluate(e=>e.scrollLeft)>20,'native PRE scroll');
 await drag(36,250,0,-100);
 if(cdp)assert.ok(await page.locator('.thread').evaluate(e=>e.scrollTop)>20,'native vertical scroll');
 await page.locator('[data-phone=settings]').click();await page.locator('body>.popover [data-act=server]').click();
 await page.waitForSelector('#rt-context-auto');await page.waitForTimeout(300);
 const bodyField=await page.locator('#rt-url').boundingBox();
 await drag(bodyField.x+bodyField.width/2,bodyField.y+bodyField.height/2,0,90);
 assert.equal(await page.locator('.modal').count(),1,'sheet body does not dismiss');
 const h=await page.locator('.modal-head').boundingBox();
 await drag(h.x+h.width/2,h.y+h.height/2,0,90);
 assert.equal(await page.locator('.modal').count(),0,'normal sheet header dismisses');
 await page.goto('http://nimbus.test/#bot:1');await waitForGestureReady();
 await page.locator('#msg').focus();
 await drag(36,724,90,0);assert.equal(await isOpen('#side'),false,'focused editor');
 await page.locator('#msg').blur();
 if(cdp){
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:36,y:200}]});
 await page.waitForTimeout(750);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:126,y:200}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(300);assert.equal(await isOpen('#side'),false,'native longpress');
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:36,y:200,id:1},{x:70,y:250,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:126,y:200,id:1},{x:160,y:300,id:2}]});
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(300);assert.equal(await isOpen('#side'),false,'native multitouch pinch');
 }
 await page.evaluate(()=>Object.defineProperty(navigator,'standalone',{configurable:true,value:true}));
 await drag(8,200,90,0);assert.equal(await isOpen('#side'),true,'standalone outer edge');
 await drag(160,200,-90,0);
 await page.setViewportSize({width:1280,height:800});
 await drag(36,200,90,0);assert.equal(await isOpen('#side'),false,'desktop ignores swipe');
 assert.deepEqual(errors,[]);
 await context.close();
 }finally{await browser.close();}
});
