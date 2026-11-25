import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('real API creates scoped coordinators, retains routing and prevents hierarchy corruption', {timeout:60000},async t=>{
  const {api,bots}=await sidebarFixture(t),coordinators=[];
  for(const name of ['Memory','Skills','Scheduler','MCP']){
    const added=await api('/api/templates/orchestrator/add','POST',{parent_bot_id:bots.root.id});assert.equal(added.status,200,JSON.stringify(added.value));
    const named=await api('/api/bots/'+added.value.id,'PATCH',{name:name+' Orchestrator',role:'Coordinates '+name+' migration',expected_parent_bot_id:bots.root.id});assert.equal(named.status,200);
    coordinators.push(named.value);
  }
  const [memory,skills]=coordinators;
  const assigned=await api('/api/bots/'+bots.builder.id,'PATCH',{parent_bot_id:memory.id,expected_parent_bot_id:bots.root.id});assert.equal(assigned.status,200);
  const stale=await api('/api/bots/'+bots.builder.id,'PATCH',{parent_bot_id:skills.id,expected_parent_bot_id:bots.root.id});assert.equal(stale.status,409);
  const metadata=await api('/api/orchestrator');assert.equal(metadata.status,200);assert.equal(metadata.value.orchestrator.id,bots.root.id);assert.equal(metadata.value.coordinators.length,4);assert.equal(metadata.value.bridge.connected,false);
  const normal=await api('/api/templates/builder/add','POST',{});assert.equal(normal.status,200);assert.equal(normal.value.parent_bot_id,bots.root.id);
  const direct=await api('/api/tasks','POST',{requestId:randomUUID(),botId:memory.id,source:'api',task:'Synthetic fixture; providers are disabled.'});assert.equal(direct.status,202);assert.equal(direct.value.botId,memory.id);
  const canonical=await api('/api/orchestrator/tasks','POST',{requestId:randomUUID(),botId:memory.id,task:'Must not redirect the shared contact.'});assert.equal(canonical.status,400);
  assert.equal((await api('/api/templates/orchestrator/add','POST',{})).status,409);
  assert.equal((await api('/api/bots/'+memory.id,'PATCH',{parent_bot_id:null})).status,409);
  assert.equal((await api('/api/bots/'+bots.root.id,'PATCH',{parent_bot_id:memory.id})).status,400);
  assert.notEqual((await api('/api/bots/'+memory.id,'PATCH',{parent_bot_id:bots.builder.id})).status,200);
  assert.notEqual((await api('/api/bots','POST',{name:'Orphan coordinator',template:'orchestrator',parent_bot_id:999999})).status,200);
  assert.equal((await api('/api/bots/'+memory.id,'DELETE')).status,409);
  assert.equal((await api('/api/bots/'+bots.root.id,'DELETE')).status,409);
  const nested=await api('/api/templates/orchestrator/add','POST',{parent_bot_id:memory.id});assert.equal(nested.status,200);
  assert.notEqual((await api('/api/bots/'+memory.id,'PATCH',{parent_bot_id:nested.value.id})).status,200);
  const state=(await api('/api/state')).value;assert.equal(state.bots.find(b=>b.id===memory.id).parent_bot_id,bots.root.id);assert.equal(state.bots.find(b=>b.id===bots.builder.id).parent_bot_id,memory.id);
});

test('desktop and phone display four team Orchestrators without confusing them with the root', {timeout:90000},async t=>{
  const {api,bots}=await sidebarFixture(t),coordinators=[];
  for(const name of ['Memory','Skills','Scheduler','MCP']){
    const added=await api('/api/bots','POST',{name:name+' Orchestrator',template:'orchestrator',parent_bot_id:bots.root.id,display_group:'',tools:['team_status','ask_worker']});assert.equal(added.status,200);coordinators.push(added.value);
  }
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  for(const width of [1280,390]){
    const context=await browser.newContext({viewport:{width,height:900},isMobile:width<760,hasTouch:width<760});
    await context.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    const ticket=await api('/api/admin/login-ticket','POST',{});assert.equal(ticket.status,200);await page.goto(ticket.value.url);
    await page.locator('#side [data-key="bot:'+bots.root.id+'"]').waitFor({state:'attached'});
    if(width<760)await page.locator('[data-act="menu"]').first().click();
    const team=page.locator('[data-orchestrator-toggle]');if(await team.getAttribute('aria-expanded')!=='true')await team.click();
    const group=page.locator('[data-display-group=""]');if(await group.getAttribute('aria-expanded')!=='true')await group.click();
    assert.equal(await page.locator('.side-item.fixed-root').count(),1);assert.equal(await page.locator('.side-orchestrator-warning').count(),0);
    for(const coordinator of coordinators){
      if(width<760&&!(await page.locator('#side').getAttribute('class'))?.split(' ').includes('open'))await page.locator('[data-act="menu"]').first().click();
      const row=page.locator('#side [data-key="bot:'+coordinator.id+'"]');assert.equal(await row.count(),1);assert.ok(await row.isVisible(),coordinator.name+' at '+width);await row.click();await page.waitForURL('**/#bot:'+coordinator.id);
    }
    assert.deepEqual(errors,[]);await context.close();
  }
});
