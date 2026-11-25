import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
for(const [name,engine] of Object.entries({chromium,webkit})) test(name+' mobile scroll ownership and zoom policy',async()=>{
 const browser=await engine.launch({headless:true});
 try {
 const context=await browser.newContext({isMobile:true,hasTouch:true,viewport:{width:390,height:844}});
 const page=await context.newPage();
 await page.route('http://fixture/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path!=='/')return r.fulfill({body:await readFile(new URL('../public'+path,import.meta.url)),contentType:path.endsWith('.js')?'text/javascript':'text/css'});
  return r.fulfill({contentType:'text/html',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/mobile.css"><style>
  .app{height:100dvh;display:block}.pane{height:180px;width:260px;overflow:auto;overscroll-behavior:none}.tall{height:900px}.wide{width:900px;height:40px}textarea{font-size:16px}
  </style><div class="app"><header>Header</header><div class="pane" id="pane"><div class="tall">Selectable text</div></div><pre class="pane" id="code"><div class="wide">horizontal code</div></pre><textarea>Editable</textarea><button>Action</button></div><script type="module">
  import {installMobileInteractions} from '/mobile-interactions.js';
  window.policyQuery=matchMedia('(max-width:760px), (max-width:960px) and (max-height:500px) and (orientation:landscape)');installMobileInteractions(window.policyQuery);window.ready=true;
  </script>`});
 });
 await page.goto('http://fixture/');await page.waitForFunction(()=>window.ready);
 const move=async(selector,dx,dy,multi=false)=>page.locator(selector).evaluate((el,{dx,dy,multi})=>{
  const point={clientX:100,clientY:100};
  const send=(type,touches)=>{const e=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'touches',{value:touches});el.dispatchEvent(e);return e.defaultPrevented;};
  send('touchstart',[point]);return send('touchmove',multi?[point,point]:[{clientX:100+dx,clientY:100+dy}]);
 },{dx,dy,multi});
 assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).touchAction),'pan-x pan-y');
 assert.equal(await move('header',0,80),true,'empty/header does not move root');
 assert.equal(await move('#pane',0,80),true,'top edge blocked');
 assert.equal(await move('#pane',0,-80),false,'real overflow allowed');
 await page.locator('#pane').evaluate(e=>e.scrollTop=e.scrollHeight);
 assert.equal(await move('#pane',0,-80),true,'bottom edge blocked');
 assert.equal(await move('#pane',0,80),false,'reverse from bottom allowed');
 assert.equal(await move('#code',-80,0),false,'horizontal overflow allowed');
 assert.equal(await move('#code',80,0),true,'horizontal edge contained');
 assert.equal(await move('header',0,80,true),true,'multitouch canceled');
 assert.equal(await page.evaluate(()=>{const e=new Event('gesturestart',{bubbles:true,cancelable:true});document.dispatchEvent(e);return e.defaultPrevented;}),true);
 await page.locator('textarea').fill('Still editable');
 assert.equal(await page.locator('textarea').inputValue(),'Still editable');
 await page.locator('#pane').evaluate(e=>{const r=document.createRange();r.selectNodeContents(e.firstChild);getSelection().removeAllRanges();getSelection().addRange(r);});
 assert.equal(await move('#pane',0,-80),false,'selection handles exempt');
 await page.evaluate(()=>getSelection().removeAllRanges());
 if(name==='chromium'){
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:100,y:70,id:1},{x:160,y:130,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:50,y:40,id:1},{x:230,y:200,id:2}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  assert.equal(await page.evaluate(()=>visualViewport.scale),1,'native CDP pinch does not zoom');
 }
 await page.setViewportSize({width:1280,height:800});
 // WebKit may resolve resize before its media-query state catches up.
 // Wait on the retained query consumed by the handler, not a newly allocated
 // query: WebKit updates existing MediaQueryList objects asynchronously.
 await page.waitForFunction(()=>innerWidth===1280 && !window.policyQuery.matches);
 assert.equal(await move('header',0,80),false,'desktop not intercepted');
 assert.equal(await page.locator('body').evaluate(e=>getComputedStyle(e).position),'static');
 }finally{await browser.close();}
});
