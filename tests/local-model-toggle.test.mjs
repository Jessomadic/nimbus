import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-toggle-'));
process.env.NIMBUS_CONFIG=path.join(dir,'config.json');
process.env.NIMBUS_DATA=path.join(dir,'data');
const {config,saveConfig}=await import('../runtime/config.js');
const {chooseRoute}=await import('../runtime/router.js');
const {localChat}=await import('../runtime/local.js');
const {startLocalService}=await import('../runtime/local-service.js');
test('boolean persistence, cloud-only routes, no-provider pause, inference and managed-start guards',async()=>{
  for(const enabled of [false,true,false])assert.equal(saveConfig({local:{enabled}}).local.enabled,enabled);
  for(const enabled of ['false',0,null])assert.throws(()=>saveConfig({local:{enabled}}),/boolean/);
  assert.equal(config().local.enabled,false);
  let calls=0;const classify=async()=>{calls++;return {message:{content:JSON.stringify({tier:'local',effort:'low',reason:'test',fallbackTier:'local'})}}};
  for(const pinned of ['', 'local',config().local.model,'sol']) {
    const r=await chooseRoute({task:'test',role:'builder',preferredTier:'sol',pinned,c:config(),classify});
    assert.equal(r.tier,'sol');assert.notEqual(r.fallbackTier,'local');
  }
  await assert.rejects(chooseRoute({task:'test',role:'builder',cloudAvailable:false,c:config(),classify}),e=>e.pause&&/No model provider/.test(e.message));
  await assert.rejects(localChat([],{c:config(),guard:()=>{calls++;}}),/disabled/);
  assert.equal(await startLocalService(),null);assert.equal(calls,0);
  const c=config();c.local.enabled=true;
  assert.equal((await chooseRoute({task:'test',role:'builder',c,classify})).tier,'local');
  assert.equal(calls,1);
});
test('desktop and phone: persisted switch, narrow immediate save, authoritative response, rollback and form preservation',async()=>{
  const browser=await chromium.launch({headless:true});
  try {for(const viewport of [{width:1280,height:900},{width:390,height:844}]) {
    const page=await browser.newPage({viewport});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',async route=>{
      const u=new URL(route.request().url());
      if(u.hostname==='toggle.test'&&u.pathname==='/runtime.js')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('../public/runtime.js',import.meta.url),'utf8')});
      if(u.hostname==='toggle.test'&&u.pathname==='/')return route.fulfill({contentType:'text/html',body:'<main></main>'});
      return route.abort();
    });
    await page.goto('http://toggle.test');
    await page.evaluate(async c=>{
      const {createRuntimeUI}=await import('/runtime.js');
      window.saved=c;window.puts=[];window.fail=false;window.hold=false;window.authoritative=null;
      window.ui=createRuntimeUI({
        api:async(url,o={})=>{
          if(!o.method)return url==='/api/settings'?{}:structuredClone(window.saved);
          if(url==='/api/runtime/config'){
            window.puts.push(o.body);
            if(window.hold)await new Promise(r=>window.release=r);
            if(window.fail)throw Error('fixture rejected');
            if(o.body.local?.enabled!==undefined)window.saved.local.enabled=window.authoritative??o.body.local.enabled;
            return structuredClone(window.saved);
          }return {};
        },
        esc:s=>String(s),modal:html=>{document.querySelector('main').innerHTML=html;return document.querySelector('main');},
        closeModal:()=>{},toast:()=>{},refreshState:async()=>{}
      });await window.ui.settings();
    },config());
    const sw=page.getByRole('switch',{name:'Use local models'});
    assert.equal(await sw.isChecked(),false);
    await page.locator('#rt-url').fill('http://unsaved.test/v1');
    await page.evaluate(()=>window.hold=true);
    await sw.check();
    assert.equal(await sw.isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Save changes'}).isDisabled(),true);
    assert.deepEqual(await page.evaluate(()=>window.puts),[{local:{enabled:true}}]);
    await page.evaluate(()=>{window.hold=false;window.release();});
    await page.waitForFunction(()=>!document.querySelector('#rt-local-enabled').disabled);
    assert.equal(await sw.isChecked(),true);
    await page.evaluate(()=>window.fail=true);await sw.click();
    await page.waitForFunction(()=>document.querySelector('#rt-local-status').textContent.includes('fixture rejected'));
    assert.equal(await sw.isChecked(),true);
    await page.evaluate(()=>{window.fail=false;window.authoritative=true;});await sw.click();
    await page.waitForFunction(()=>!document.querySelector('#rt-local-enabled').disabled);
    assert.equal(await sw.isChecked(),true);
    await page.getByRole('button',{name:'Save changes'}).click();
    const form=await page.evaluate(()=>window.puts.at(-1));
    assert.equal(form.local.baseUrl,'http://unsaved.test/v1');
    assert.equal(Object.hasOwn(form.local,'enabled'),false); // merge preserves latest server state, never stale form value
    await page.evaluate(()=>window.ui.settings());assert.equal(await sw.isChecked(),true);
    assert.deepEqual(errors,[]);await page.close();
  }}finally{await browser.close();}
});
