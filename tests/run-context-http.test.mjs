import {artifactDirectory} from './helpers/artifact-directory.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {chromium} from 'playwright';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('/compact runs without inference, archives history and is idempotent over HTTP',async t=>{
  const {api,database,bots,seedOwnedRun,reconcileFixture}=await sidebarFixture(t,{ownedContext:true}),botId=bots.builder.id,thread='bot:'+botId;
  const messages=[{role:'user',content:'KEEP_ALL_CONSTRAINTS'}];
  for(let i=0;i<25;i++)messages.push({role:'assistant',tool_calls:[{id:'archive-'+i,type:'function',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'archive-'+i,content:JSON.stringify({text:'E'.repeat(15000)})});
  database(db=>db.prepare('INSERT INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(botId,thread,JSON.stringify(messages)));
  const route='/api/threads/'+encodeURIComponent(thread)+'/messages',request={text:'/compact',requestId:'manual-compact-fixture'};
  const response=await api(route,'POST',request);assert.equal(response.status,200);
  assert.equal((await api(route,'POST',request)).value.replayed,true);
  database(db=>{
    assert.equal(db.prepare('SELECT count(*) n FROM runs').get().n,0);
    const next=JSON.parse(db.prepare('SELECT messages FROM worker_history WHERE bot_id=?').get(botId).messages);
    assert.equal(next[0].content,'KEEP_ALL_CONSTRAINTS');assert.ok(JSON.stringify(next).length<=240000);
    const note=db.prepare("SELECT body FROM messages WHERE author='system' ORDER BY id DESC LIMIT 1").get().body;assert.match(note,/Context compacted/);assert.match(note,/Full history/);
  });
  const saved=await api('/api/runtime/config','PUT',{context:{automaticCompression:false,maxHistoryChars:48000,maxToolChars:1024}});assert.equal(saved.status,200);
  const config=await api('/api/runtime/config');assert.equal(config.value.context.automaticCompression,false);assert.equal(config.value.context.maxHistoryChars,48000);
  assert.equal((await api('/api/runtime/config','PUT',{context:{maxHistoryChars:10}})).status,500);
});
test('context settings are visible, editable and persisted through the actual settings form',async t=>{
  const {api}=await sidebarFixture(t,{ownedContext:true}),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000);
  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
  const ticket=await api('/api/admin/login-ticket','POST',{});await page.goto(ticket.value.url);
  await page.locator('[data-act="user-menu"]').click();await page.locator('[data-act="server"]').click();
  await page.getByRole('heading',{name:'Context and memory'}).waitFor();
  await page.locator('#rt-context-auto').uncheck();await page.locator('#rt-context-history').fill('96000');await page.locator('#rt-context-tool').fill('2048');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.getByText('Nimbus settings saved',{exact:true}).waitFor();
  const c=(await api('/api/runtime/config')).value.context;assert.deepEqual(c,{automaticCompression:false,maxHistoryChars:96000,maxToolChars:2048});
});

test('chat messages add durable context to the exact active user run, with idempotency and an explicit new-task option',async t=>{
  const {base,api,database,bots,seedOwnedRun,reconcileFixture}=await sidebarFixture(t,{ownedContext:true}),botId=bots.builder.id,thread='bot:'+botId;
  const seed=seedOwnedRun;
  const parked=await seed(botId,thread,'waiting_tool');
  const runId=await seed(botId,thread),other=await seed(botId,'room:999');
  const route='/api/threads/'+encodeURIComponent(thread)+'/messages';
  assert.equal((await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'Unauthorized context'})})).status,401);
  const request={text:'Create a PR after the existing work',requestId:'context-fixture'};
  const response=await api(route,'POST',request);assert.equal(response.status,200);
  const retry=await api(route,'POST',request);assert.equal(retry.value.id,response.value.id);assert.equal(retry.value.replayed,true);
  assert.equal((await api(route,'POST',{...request,mode:'task'})).status,409);
  database(db=>{
    assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status,'waiting_approval');
    assert.equal(db.prepare('SELECT count(*) AS n FROM runs WHERE bot_id=?').get(botId).n,3);
    const rows=db.prepare('SELECT * FROM run_context').all();assert.equal(rows.length,1);assert.equal(rows[0].run_id,runId);assert.equal(rows[0].message_id,response.value.id);assert.equal(rows[0].prompt,request.text);
    assert.equal(db.prepare('SELECT count(*) AS n FROM run_context WHERE run_id=?').get(other).n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM run_context WHERE run_id=?').get(parked).n,0);
  });
  assert.equal((await api(route,'POST',{text:'Independent assignment',mode:'task'})).status,200);
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs WHERE bot_id=?').get(botId).n),4);
  assert.equal((await api(route,'POST',{text:'Invalid',mode:'interrupt'})).status,400);
  const delegated=await seed(bots.qa.id,'bot:'+bots.qa.id,'waiting_input','user',runId);
  await api('/api/threads/bot%3A'+bots.qa.id+'/messages','POST',{text:'Separate user request'});
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM run_context WHERE run_id=?').get(delegated).n),0);
  // Redacting a chat input also removes its pending inference copy.
  assert.equal((await api('/api/messages/'+response.value.id+'/redact','POST',{text:request.text})).status,200);
  assert.equal(database(db=>db.prepare('SELECT prompt FROM run_context WHERE run_id=?').get(runId).prompt),'[REDACTED]');
});

test('desktop and mobile composers send attached context without stopping the active task', {timeout:30000},async t=>{
  const {api,database,bots,seedOwnedRun,reconcileFixture}=await sidebarFixture(t,{ownedContext:true}),thread='bot:'+bots.root.id;
  const runId=await seedOwnedRun(bots.root.id,thread,'waiting_cloud');
  assert.deepEqual(await reconcileFixture(),[]);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({viewport:{width:1280,height:900}}),page=await context.newPage(),errors=[];
  page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(10000);
  page.on('pageerror',error=>errors.push(error.message));
  await context.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
  const ticket=await api('/api/admin/login-ticket','POST',{});await page.goto(ticket.value.url);
  await page.locator('#side [data-key="'+thread+'"]').click();
  await page.locator('#thread .empty:not(.small)').waitFor();
  assert.equal(await page.getByRole('combobox',{name:'Message mode'}).inputValue(),'context');
  await page.locator('#file-pick').setInputFiles({name:'additional-context.txt',mimeType:'text/plain',buffer:Buffer.from('Preserve the original task and completed work.')});
  await page.locator('#attach-list .attach:not(.busy)').waitFor();
  await page.locator('#msg').fill('Include this attached context in the current request');
  const response=page.waitForResponse(r=>r.url().includes('/api/threads/')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Send',exact:true}).click();assert.equal((await response).status(),200);
  await page.getByText('Context added to task #'+runId+'. It will be read at the next model step; current work continues.',{exact:true}).waitFor();
  database(db=>{const rows=db.prepare('SELECT * FROM run_context WHERE run_id=?').all(runId);assert.equal(rows.length,1);assert.match(rows[0].prompt,/additional-context\.txt/);assert.match(rows[0].prompt,/Include this attached context/);assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(runId).status,'waiting_cloud');assert.equal(db.prepare('SELECT count(*) AS n FROM runs').get().n,1);});
  const directory=artifactDirectory('run-context-http');
  await page.screenshot({path:path.join(directory,'desktop.png'),animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.getByRole('combobox',{name:'Message mode'}).isVisible());
  assert.ok(await page.getByRole('button',{name:'Send',exact:true}).isVisible());
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(directory,'mobile.png'),animations:'disabled'});
  await page.getByRole('combobox',{name:'Message mode'}).selectOption('task');
  await page.getByText('Queues a separate assignment after current work.',{exact:true}).waitFor();
  await page.locator('#msg').fill('A separate assignment');
  const separate=page.waitForResponse(r=>r.url().includes('/api/threads/')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Send',exact:true}).click();assert.equal((await separate).status(),200);
  assert.equal(database(db=>db.prepare('SELECT count(*) AS n FROM runs').get().n),2);
  assert.deepEqual(errors,[]);
});

test('group context follows mentions and does not spill into another worker or private chat',async t=>{
  const {api,database,bots,seedOwnedRun,reconcileFixture}=await sidebarFixture(t,{ownedContext:true});
  const room=await api('/api/rooms','POST',{name:'Context group',members:[bots.builder.id,bots.qa.id],lead_bot_id:bots.builder.id});assert.equal(room.status,200);
  const thread='room:'+room.value.id;
  const ids=await Promise.all([bots.builder,bots.qa].map(bot=>seedOwnedRun(bot.id,thread,'waiting_cloud','the user')));
  assert.deepEqual(await reconcileFixture(),[]);
  await api('/api/threads/'+encodeURIComponent(thread)+'/messages','POST',{text:'@QA Engineer Add this validation context'});
  database(db=>{const rows=db.prepare('SELECT * FROM run_context').all();assert.equal(rows.length,1);assert.equal(rows[0].run_id,ids[1]);assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(ids[0]).status,'waiting_cloud');});
});
