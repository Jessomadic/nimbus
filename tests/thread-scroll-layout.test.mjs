import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';

for(const [name,engine] of Object.entries({chromium,webkit}))test(name+' layout scroll before resize keeps latest view and preserves upward reader movement',async()=>{
  const browser=await engine.launch();
  try{
    const page=await browser.newPage();
    await page.route('http://scroll.test/**',async r=>r.fulfill(new URL(r.request().url()).pathname==='/thread-scroll.js'?{contentType:'text/javascript',body:await readFile(new URL('../public/thread-scroll.js',import.meta.url))}:{contentType:'text/html',body:'<style>#thread{height:200px;width:300px;overflow:auto;overflow-anchor:none}.thread-inner{height:1200px}</style><div id="thread"><div class="thread-inner"></div></div><script type="module">import{followThreadBottom}from"/thread-scroll.js";window.tracker=followThreadBottom(document.querySelector("#thread"));tracker.bottom();</script>'}));
    await page.goto('http://scroll.test/');await page.waitForFunction(()=>window.tracker);
    const change=async(size,top)=>page.evaluate(({size,top})=>{const t=document.querySelector('#thread');t.firstElementChild.style.height=size+'px';if(top!==null)t.scrollTop=top;t.dispatchEvent(new Event('scroll'));},{size,top});
    const settled=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const state=()=>page.evaluate(()=>{const t=document.querySelector('#thread');return{gap:t.scrollHeight-t.scrollTop-t.clientHeight,top:t.scrollTop,following:tracker.following};});
    await change(1400,null);await settled();assert.equal((await state()).gap,0);
    await change(1600,200);await settled();assert.equal((await state()).top,200);assert.equal((await state()).following,false);
    await change(1800,null);await settled();assert.equal((await state()).top,200);
    await page.evaluate(()=>tracker.bottom());await page.evaluate(()=>{const t=document.querySelector('#thread');t.style.height='150px';t.dispatchEvent(new Event('scroll'));});await settled();assert.equal((await state()).gap,0);
  }finally{await browser.close();}
});
