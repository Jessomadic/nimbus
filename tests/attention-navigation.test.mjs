import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('attention badge opens the request, its blocker and the worker task on desktop and mobile', {timeout:30000}, async t => {
  const {api,database,bots}=await sidebarFixture(t),thread='bot:'+bots.root.id;
  const current={id:'current-request',title:'Task reconciliation needed',tool_name:'task_lifecycle_reconcile',status:'blocked',phase:'blocked',message:'Review the retained candidate.',error_metadata:{priorRequestId:'prior-request'},stages:[]};
  const prior={id:'prior-request',title:'Retained candidate',status:'cancelled',stages:[{runId:72,worker_name:'Builder',phase:'building',status:'error'}]};
  database(db=>db.prepare('INSERT INTO messages(thread,author,kind,body) VALUES(?,?,?,?)').run(thread,'system','capability',JSON.stringify({requestId:current.id,title:current.title,toolName:current.tool_name,status:'blocked',message:current.message,version:2})));
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],requests=[];
  page.setDefaultTimeout(5000);page.on('pageerror',error=>errors.push(error.message));
  await page.route(/https:\/\/fonts\.(?:googleapis|gstatic)\.com\//,route=>route.abort());
  await page.route('**/api/tool-requests/*',route=>{
    requests.push(route.request().method());
    const value=route.request().url().endsWith('/current-request')?current:prior;
    return route.fulfill({json:value});
  });
  await page.route('**/api/runs/72',route=>route.fulfill({json:{id:72,bot_id:bots.builder.id,thread:'bot:'+bots.builder.id,status:'done',reply:'Retained work needs review.',toolRequests:[{...prior,status:'blocked'}]}}));
  await page.route('**/api/tool-requests?runId=72',route=>route.fulfill({json:{requests:[{...prior,status:'blocked'}]}}));
  await page.route('**/api/runs/72/events',route=>route.fulfill({json:{events:[],tools:[]}}));
  const ticket=await api('/api/admin/login-ticket','POST',{});await page.goto(ticket.value.url);
  await page.locator('#side [data-key="'+thread+'"]').click();
  const attention=page.getByRole('button',{name:'Needs attention: open Task reconciliation needed',exact:true});
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900});
    if(width===1280)await attention.click();else{await attention.focus();await page.keyboard.press('Enter');}
    await page.getByRole('heading',{name:'Task reconciliation needed',exact:true}).waitFor();
    await page.getByRole('button',{name:'Open blocking request',exact:true}).click();
    await page.getByRole('heading',{name:'Retained candidate',exact:true}).waitFor();
    await page.getByRole('button',{name:'Open task #72',exact:true}).click();
    await page.getByRole('heading',{name:'Task 72',exact:true}).waitFor();
    await page.getByText('Retained work needs review.',{exact:true}).waitFor();
    await page.getByText('Worker finished · Build needs attention',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Close',exact:true}).last().click();
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.getByRole('button',{name:'View progress',exact:true}).click();
  await page.getByRole('heading',{name:'Task reconciliation needed',exact:true}).waitFor();
  assert.deepEqual(requests,['GET','GET','GET','GET','GET']);assert.deepEqual(errors,[]);
});
