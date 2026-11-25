import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';

for(const [name,engine] of Object.entries({chromium,webkit})) {
  test(name+' phone startup remains visible if a module fails and can recover from an initial API failure',async () => {
    const browser=await engine.launch({headless:true});
    try {
      const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
      page.setDefaultTimeout(7000);
      let moduleFailure=true,apiFailure=true,holdState=false,releaseState;
      await page.route('**/*',async route=>{
        const url=new URL(route.request().url());
        if(url.hostname!=='nimbus.test')return route.abort();
        if(url.pathname==='/app.js'&&moduleFailure)return route.abort();
        if(url.pathname.startsWith('/api/')){
          if(url.pathname==='/api/state'&&apiFailure)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture unavailable'})});
          if(url.pathname==='/api/state'&&holdState)await new Promise(resolve=>{releaseState=resolve;});
          if(url.pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:': ready\n\n'});
          const state={bots:[{id:1,name:'Orchestrator',role:'orchestrator',is_orchestrator:true,plugins:[],status:{state:'idle'},color:'#3b82f6',effort:'medium'}],rooms:[],last:{},routines:[],upNext:[],learned:[],approvals:[],computers:[],usage:{},settings:{}};
          return route.fulfill({contentType:'application/json',body:JSON.stringify(url.pathname==='/api/state'?state:url.pathname.endsWith('/messages')?[]:{})});
        }
        try {
          const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
          const body=await readFile(new URL('../public/'+file,import.meta.url));
          return route.fulfill({body,contentType:({html:'text/html',js:'text/javascript',css:'text/css',webp:'image/webp',png:'image/png',svg:'image/svg+xml'})[file.split('.').at(-1)]||'application/json'});
        } catch {return route.fulfill({status:404,body:'Not found'});}
      });
      await page.goto('http://nimbus.test/',{waitUntil:'domcontentloaded'});
      assert.equal(await page.getByRole('status').getByText('Loading your workspace…').isVisible(),true);
      assert.equal(await page.getByRole('link',{name:'refresh Nimbus'}).isVisible(),true);
      moduleFailure=false;
      await page.getByRole('link',{name:'refresh Nimbus'}).click();
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').innerText(),/Check your connection and try again/);
      apiFailure=false;holdState=true;
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      const stateRequest=page.waitForRequest('**/api/state');
      await page.getByRole('link',{name:'Reload Nimbus'}).click();
      await stateRequest;
      await page.evaluate(()=>{location.hash='bot:1';});
      // Let the actual hashchange reach the installed listener while state is
      // still pending, as can happen when a phone restores its previous tab.
      await page.waitForTimeout(50);
      holdState=false;releaseState();
      await page.locator('.phone-dock').waitFor();
      await page.locator('#msg').waitFor();
      assert.equal(await page.getByRole('alert').count(),0);
      assert.match(await page.locator('#main').innerText(),/Orchestrator/);
      assert.deepEqual(errors,[]);
    } finally {await browser.close();}
  });
}
