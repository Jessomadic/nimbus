import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {chromium,webkit} from 'playwright';

for(const [name,engine] of Object.entries({chromium,webkit})){
  test(name+' public PWA startup works after sign-out without importing protected shell modules',async()=>{
    const browser=await engine.launch({headless:true});
    try{
      const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
      await page.addInitScript(()=>{
        window.registrations=[];
        Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:async script=>{window.registrations.push(script);return{};}}});
      });
      const errors=[],requested=[];
      page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>requested.push(new URL(request.url()).pathname));
      await page.route('https://nimbus.test/**',async route=>{
        const pathname=new URL(route.request().url()).pathname;
        if(pathname==='/pwa.js')return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../public/pwa.js',import.meta.url))});
        if(pathname==='/login')return route.fulfill({contentType:'text/html',body:'<meta name="viewport" content="width=device-width,initial-scale=1"><h1>Sign in to Nimbus</h1><button data-reconnect>Reconnect</button><script type="module" src="/pwa.js"></script>'});
        return route.fulfill({status:302,headers:{location:'/login'}});
      });
      await page.goto('https://nimbus.test/login');
      await page.waitForFunction(()=>window.registrations.length===1);
      assert.deepEqual(await page.evaluate(()=>window.registrations),['/sw.js']);
      assert.equal(await page.getByRole('heading',{name:'Sign in to Nimbus'}).isVisible(),true);
      assert.equal(requested.includes('/mobile-shell.js'),false);
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  });
}

test('public worker evicts previous cache and never caches protected shell or authenticated pages',async()=>{
  const handlers={},cached=[],deleted=[];let waited;
  const sandbox={URL,self:{location:{origin:'https://nimbus.test'},addEventListener:(name,fn)=>{handlers[name]=fn;},skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{open:async()=>({addAll:async assets=>cached.push(...assets)}),keys:async()=>['nimbus-public-v2','nimbus-public-v3','unrelated-cache'],delete:async key=>deleted.push(key)}};
  vm.runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),sandbox);
  handlers.install({waitUntil:promise=>{waited=promise;}});await waited;
  assert.ok(cached.includes('/offline.html'));
  assert.ok(cached.includes('/pwa.js'));
  assert.equal(cached.some(p=>/^\/(?:api(?:\/|$)|app\.js$|mobile-shell\.js$|panel-gestures\.js$|mobile-interactions\.js$|$)/.test(p)),false);
  handlers.activate({waitUntil:promise=>{waited=promise;}});await waited;
  assert.deepEqual(deleted,['nimbus-public-v2']);
});
