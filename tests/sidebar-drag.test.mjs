import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {sidebarFixture,repository} from './helpers/sidebar-fixture.mjs';

test('real browser sidebar supports cross-group agents, nested groups, keyboard moves and mobile touch', {timeout:90000},async t=>{
  const fixture=await sidebarFixture(t),{api,bots,snapshot}=fixture,baseline=snapshot();
  const artifacts=path.join(repository,'.dev','sidebar-verification');fs.mkdirSync(artifacts,{recursive:true});
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:1100}}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await context.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
  let mutations=0;page.on('request',request=>{if(request.url().endsWith('/api/sidebar/move')&&request.method()==='POST')mutations++;});
  const signIn=async target=>{const ticket=await api('/api/admin/login-ticket','POST',{});assert.equal(ticket.status,200);await target.goto(ticket.value.url);await target.locator('#side [data-key="bot:'+bots.root.id+'"]').waitFor();};
  await signIn(page);
  const heading=(id,target=page)=>target.locator('#side [data-display-group="'+id+'"]'),agent=(id,target=page)=>target.locator('#side [data-key="bot:'+id+'"]');
  const expand=async(id,target=page)=>{const h=heading(id,target);if(await h.getAttribute('aria-expanded')!=='true')await h.click();};
  const idle=async(target=page)=>target.waitForFunction(()=>!document.querySelector('#side')?.hasAttribute('aria-busy'));
  const drag=async(source,target,{zone='middle',save=true}={})=>{
    await source.waitFor({state:'visible'});await source.evaluate(element=>element.scrollIntoView({block:'nearest'}));const s=await source.boundingBox();assert.ok(s);
    await page.mouse.move(s.x+Math.min(s.width/2,70),s.y+s.height/2);await page.mouse.down();await page.mouse.move(s.x+Math.min(s.width/2,70)+10,s.y+s.height/2+8);
    await page.locator('body.reordering').waitFor();await target.evaluate(element=>element.scrollIntoView({block:'nearest'}));const d=await target.boundingBox();assert.ok(d);
    const x=d.x+(zone==='middle'?Math.min(d.width/2,70):8),y=d.y+d.height*(zone==='before'?.1:zone==='after'?.9:.5);
    await page.mouse.move(x,y,{steps:8});
    if(!save){await page.locator('.side-drop-invalid').waitFor();await page.mouse.up();return;}
    const response=page.waitForResponse(response=>response.url().endsWith('/api/sidebar/move')&&response.request().method()==='POST');await page.mouse.up();assert.equal((await response).status(),200);await idle();
  };
  const state=async()=>(await api('/api/state')).value;
  await t.test('an agent can be dragged onto a collapsed destination group and retain its complete state',async()=>{
    await expand('engineering');assert.equal(await heading('quality').getAttribute('aria-expanded'),'false');
    await drag(agent(bots.builder.id),heading('quality'));
    await page.waitForFunction(id=>document.querySelector('#side [data-key="bot:'+id+'"]')?.closest('[data-display-section]')?.dataset.displaySection==='quality',bots.builder.id);
    assert.equal((await state()).bots.find(bot=>bot.id===bots.builder.id).display_group,'quality');assert.deepEqual(snapshot(),baseline);
  });
  await t.test('same-group dragging still reorders agents',async()=>{
    await drag(agent(bots.builder.id),agent(bots.qa.id),{zone:'before'});
    const order=(await state()).sideOrder;assert.ok(order.indexOf('bot:'+bots.builder.id)<order.indexOf('bot:'+bots.qa.id));
  });
  await t.test('a group can be dragged inside another and retains its displayed subagent branch',async()=>{
    await drag(heading('github'),heading('engineering'));
    assert.equal((await state()).sidebarLayout.groups.find(group=>group.id==='github').parent,'engineering');
    assert.equal(await page.locator('#side [data-display-section="engineering"] [data-display-section="github"]').count(),1);
    assert.equal((await state()).bots.find(bot=>bot.id===bots.sync.id).parent_bot_id,bots.github.id);
  });
  await t.test('dragging a group above a sibling changes heading order',async()=>{
    await drag(heading('research'),heading('quality'),{zone:'before'});
    const roots=(await state()).sidebarLayout.groups.filter(group=>group.parent===null).map(group=>group.id);assert.ok(roots.indexOf('research')<roots.indexOf('quality'));
  });
  await t.test('a group cannot be dropped into its own descendant',async()=>{
    await expand('engineering');const before=(await state()).sidebarLayout,count=mutations;
    await drag(heading('engineering'),heading('github'),{save:false});assert.equal(mutations,count);assert.deepEqual((await state()).sidebarLayout,before);
  });
  await t.test('a nested group can be dragged back to the top level',async()=>{
    await expand('engineering');await drag(heading('github'),page.locator('#side [data-sidebar-root-drop]'));
    assert.equal((await state()).sidebarLayout.groups.find(group=>group.id==='github').parent,null);
  });
  await t.test('empty Other agents is a drop target and a visible parent carries its displayed children',async()=>{
    await expand('github');await drag(agent(bots.github.id),heading(''));
    const s=await state();for(const id of [bots.github.id,bots.sync.id])assert.equal(s.bots.find(bot=>bot.id===id).display_group,'');assert.deepEqual(snapshot(),baseline);
  });
  await t.test('keyboard shortcuts nest and unnest groups without opening a chat',async()=>{
    const priorHash=await page.evaluate(()=>location.hash);await heading('research').focus();const nested=page.waitForResponse(r=>r.url().endsWith('/api/sidebar/move')&&r.request().method()==='POST');await page.keyboard.press('Alt+ArrowRight');await nested;await idle();
    assert.notEqual((await state()).sidebarLayout.groups.find(group=>group.id==='research').parent,null);
    await heading('research').focus();const response=page.waitForResponse(r=>r.url().endsWith('/api/sidebar/move')&&r.request().method()==='POST');await page.keyboard.press('Alt+ArrowLeft');await response;await idle();
    assert.equal((await state()).sidebarLayout.groups.find(group=>group.id==='research').parent,null);assert.equal(await page.evaluate(()=>location.hash),priorHash);
  });
  await t.test('cancel and invalid room destinations never save an agent move',async()=>{
    await expand('engineering');const count=mutations;await drag(agent(bots.architect.id),heading('rooms'),{save:false});assert.equal(mutations,count);
    const s=await agent(bots.architect.id).boundingBox();await page.mouse.move(s.x+60,s.y+s.height/2);await page.mouse.down();await page.mouse.move(s.x+70,s.y+s.height/2+10);await page.locator('body.reordering').waitFor();await page.keyboard.press('Escape');await page.mouse.up();assert.equal(mutations,count);assert.equal(await page.locator('.sidebar-drag-ghost').count(),0);
  });
  await t.test('layout persists for a different browser session and mobile long-press moves an agent',async()=>{
    await drag(heading('quality'),heading('engineering'));
    const mobileContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true}),mobile=await mobileContext.newPage();mobile.on('pageerror',error=>errors.push(error.message));await signIn(mobile);
    await mobile.locator('[data-act="menu"]').first().click();await mobile.locator('#side.open').waitFor();await expand('engineering',mobile);
    assert.equal(await mobile.locator('#side [data-display-section="engineering"] [data-display-section="quality"]').count(),1);
    assert.equal(await agent(bots.github.id,mobile).evaluate(element=>element.closest('[data-display-section]').dataset.displaySection),'');
    const source=agent(bots.architect.id,mobile);await source.scrollIntoViewIfNeeded();const s=await source.boundingBox(),session=await mobileContext.newCDPSession(mobile);
    await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:s.x+60,y:s.y+s.height/2}]});await mobile.locator('body.reordering').waitFor();
    await heading('operations',mobile).scrollIntoViewIfNeeded();const d=await heading('operations',mobile).boundingBox();await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:d.x+65,y:d.y+d.height/2}]});
    const response=mobile.waitForResponse(r=>r.url().endsWith('/api/sidebar/move')&&r.request().method()==='POST');await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});assert.equal((await response).status(),200);await idle(mobile);
    assert.equal((await state()).bots.find(bot=>bot.id===bots.architect.id).display_group,'operations');await mobile.screenshot({path:path.join(artifacts,'nested-groups-mobile.png')});await mobileContext.close();assert.deepEqual(snapshot(),baseline);
  });
  await t.test('nested group badges include descendant activity and filtering prevents accidental drags',async()=>{
    fixture.database(db=>db.prepare('INSERT INTO approvals(bot_id,thread,tool,input) VALUES(?,?,?,?)').run(bots.qa.id,'bot:'+bots.qa.id,'fixture-review','{}'));
    await page.reload();await page.locator('#side [data-key="bot:'+bots.root.id+'"]').waitFor();
    assert.equal(await page.locator('#side [data-display-section="engineering"] [data-display-section="quality"]').count(),1);
    assert.equal(await heading('engineering').locator('[data-group-badge="approval"]').textContent(),'1 approval');
    assert.equal(await heading('quality').locator('[data-group-badge="approval"]').textContent(),'1 approval');
    await page.screenshot({path:path.join(artifacts,'nested-groups-desktop.png')});
    const count=mutations;await page.locator('#side-search').fill('Builder');await agent(bots.builder.id).waitFor({state:'visible'});const s=await agent(bots.builder.id).boundingBox();await page.mouse.move(s.x+50,s.y+s.height/2);await page.mouse.down();await page.mouse.move(s.x+65,s.y+s.height/2+15);await page.mouse.up();assert.equal(mutations,count);assert.equal(await page.locator('body.reordering').count(),0);
    await page.locator('#side-search').fill('');assert.deepEqual(snapshot(),baseline);assert.deepEqual(errors,[]);
  });
});
