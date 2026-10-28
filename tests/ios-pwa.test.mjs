import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
const publicRoot = new URL('../public/', import.meta.url);
test('isolated PWA shell: phone, landscape, keyboard geometry, navigation and desktop', async () => {
  const browser = await chromium.launch({headless:true});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    const page = await context.newPage();
    const errors=[];
    page.on('pageerror', e => { errors.push(e.message); console.error('Fixture page error:',e.stack); });
    page.setDefaultTimeout(5000);
    await page.route('**/*', async route => {
      const url=new URL(route.request().url());
      if(url.hostname!=='nimbus.test') return route.abort();
      if(url.pathname.startsWith('/api/')) {
        const state={bots:[{id:1,name:'Orchestrator',role:'orchestrator',is_orchestrator:true,plugins:[],status:{state:'idle'},color:'#3b82f6',effort:'medium'}],rooms:[],last:{},routines:[],upNext:[],learned:[],approvals:[],computers:[],usage:{},settings:{}};
        const data=url.pathname==='/api/state'?state:url.pathname.endsWith('/messages')?[]:{};
        return route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
      }
      try {
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        const body=await readFile(new URL(file,publicRoot));
        const ext=file.split('.').at(-1);
        return route.fulfill({body,contentType:({html:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',webp:'image/webp'})[ext]||'application/json'});
      } catch { return route.fulfill({status:404,body:'Not found'}); }
    });
    const artifacts=process.env.NIMBUS_PWA_ARTIFACTS;
    if(artifacts) await mkdir(artifacts,{recursive:true});
    for(const [width,height] of [[320,568],[390,844],[844,390],[1280,800]]) {
      await page.setViewportSize({width,height});
      await page.goto('http://nimbus.test/#bot:1');
      await page.waitForSelector('#msg');
      // Wait for the shell's resize signal, not for composer visibility to pass.
      await page.waitForFunction(()=>parseFloat(document.documentElement.style.getPropertyValue('--app-height'))===visualViewport.height);
      assert.deepEqual(errors,[]);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth), 'document overflow');
      const box=await page.locator('.composer').boundingBox();
      const geometry=await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight,visualHeight:visualViewport.height,top:visualViewport.offsetTop},appHeight:getComputedStyle(document.documentElement).getPropertyValue('--app-height'),ready:document.readyState,styles:[...document.styleSheets].map(s=>s.href)}));
      console.log('PWA geometry',JSON.stringify({width,height,box,...geometry}));
      if(artifacts) await page.screenshot({path:artifacts+'/'+width+'x'+height+'-geometry.png'});
      assert.ok(box.y+box.height<=height+1,'composer visible '+JSON.stringify({width,height,box,...geometry}));
      assert.ok(box.y>=0 && Math.abs(box.y+box.height-height)<=1,'composer anchored to current viewport');
      assert.equal(Math.round((await page.locator('.app').boundingBox()).height),height,'shell fits current viewport');
      const mobile = width<=760 || (width<=960 && height<=500 && width>height);
      assert.equal(await page.locator('#msg').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)),mobile?16:14);
      if(width===320) {
        assert.equal(await page.locator('.head .title b').evaluate(el=>el.scrollWidth<=el.clientWidth),true,'320px title not truncated');
      }
      if(mobile) {
        assert.ok(await page.getByRole('button',{name:'Menu',exact:true}).isVisible());
        assert.equal(Math.round((await page.locator('#main').boundingBox()).width),width,'full-width mobile conversation');
        assert.equal(await page.locator('#side').evaluate(el=>el.inert),true);
        await page.getByRole('button',{name:'Menu',exact:true}).click();
        await page.waitForFunction(()=>document.querySelector('[data-act="menu"]').getAttribute('aria-expanded')==='true');
        assert.equal(await page.locator('#main').evaluate(el=>el.inert),true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>!document.querySelector('#main').inert);
        assert.equal(await page.locator('[data-act="menu"]').evaluate(el=>el===document.activeElement),true);
        await page.getByRole('button',{name:'Menu',exact:true}).click();
        await page.locator('.mobile-backdrop').click({position:{x:width-5,y:height/2}});
        await page.waitForFunction(()=>!document.querySelector('#side').classList.contains('open'));
      } else assert.equal(await page.locator('#side').evaluate(el=>el.inert),false);
      await page.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
      if(!mobile) assert.ok((await page.locator('#side').boundingBox()).x>=0,'desktop sidebar not clipped');
      if(artifacts) await page.screenshot({path:artifacts+'/'+width+'x'+height+'.png'});
    }
    // Deterministic VisualViewport signal: geometry, not a claim of native keyboard behavior.
    await page.setViewportSize({width:390,height:844});
    await page.goto('http://nimbus.test/#bot:1');
    await page.waitForSelector('#msg');
    await page.evaluate(()=>{
      Object.defineProperty(visualViewport,'height',{configurable:true,value:400});
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--app-height')==='400px');
    if(artifacts) await page.screenshot({path:artifacts+'/keyboard-390x400.png'});
    console.log('PWA keyboard geometry',JSON.stringify(await page.locator('.composer').boundingBox()));
    assert.equal(Math.round((await page.locator('.app').boundingBox()).height),400);
    assert.ok(await page.locator('.composer').evaluate(el=>el.getBoundingClientRect().bottom<=401));
    await page.goto('http://nimbus.test/login.html');
    await page.locator('#userbox').evaluate(el=>el.hidden=false);
    await page.locator('#username').fill('fixture-user');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.equal(await page.locator('#username').evaluate(el=>getComputedStyle(el).fontSize),'16px');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
