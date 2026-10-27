import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {execute,tools} from '../runtime/toolsets/operations.js';
import {isValidCron,cronMatches,nextRun} from '../runtime/cron.js';
import {cleanConnectorError} from '../runtime/mcp.js';
function fixture(t){
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-ops-test-')),db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO bots VALUES(1,'Operator'),(2,'Other');CREATE TABLE routines(id INTEGER PRIMARY KEY,bot_id INTEGER,cron TEXT,prompt TEXT,enabled INTEGER,quiet INTEGER,last_run INTEGER);CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,status TEXT,source TEXT,requested_model TEXT,actual_model TEXT,last_error TEXT,input_tokens INTEGER,output_tokens INTEGER,started_at INTEGER,ended_at INTEGER);CREATE TABLE task_events(id INTEGER PRIMARY KEY,run_id INTEGER,type TEXT,body TEXT,created_at INTEGER);");
  t.after(()=>{db.close();assert.equal(path.dirname(workspace),os.tmpdir());assert.match(path.basename(workspace),/^nimbus-ops-test-/);fs.rmSync(workspace,{recursive:true,force:true});});
  return{workspace,dataDir:workspace,botId:1,query:sql=>db.prepare(sql),availableTools:tools,db};
}
test('tool catalogue reflects enabled tools and connector inventory never returns transport secrets',async t=>{
  const ctx=fixture(t);ctx.availableTools=[...tools,{function:{name:'mcp__test__lookup',description:'Lookup fixture'}}];ctx.bindings=new Map([['mcp__test__lookup',{readOnly:true,secret:'PRIVATE'}]]);
  const catalog=await execute('tool_catalog',{query:'schedule',details:true},ctx);assert.ok(catalog.tools.some(t=>t.name==='automation_schedule'&&t.parameters));
  ctx.connectorErrors=[{server:'test',error:'Authorization: Bearer PRIVATE_MARKER'}];
  const inventory=await execute('connector_inventory',{},ctx);assert.equal(inventory.tools.length,1);assert.equal(inventory.tools[0].readOnly,true);assert.ok(!JSON.stringify(inventory).includes('PRIVATE'));
  assert.ok(!cleanConnectorError('Failure for https://user:private@example.com/?api_key=PRIVATE_MARKER').includes('PRIVATE_MARKER'));
  assert.ok(!cleanConnectorError('Failed: private-value',{env:{TOKEN:'private-value'}}).includes('private-value'));
});
test('health probes record real redirects, JSON evidence, truncation and cancellation',async t=>{
  const ctx=fixture(t),server=http.createServer((req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/json'});return res.end();}
    res.setHeader('content-type','application/json');res.end(req.url==='/big'?JSON.stringify({text:'x'.repeat(5000)}):'{"healthy":true}');
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});const url=`http://127.0.0.1:${server.address().port}`;
  const probe=await execute('health_probe',{url:url+'/redirect'},ctx);assert.equal(probe.json.healthy,true);assert.equal(probe.redirects.length,1);
  const limited=await execute('health_probe',{url:url+'/big',maxBytes:100},ctx);assert.equal(limited.truncated,true);assert.equal(limited.bytesRead,100);assert.equal(limited.json,undefined);
  await assert.rejects(execute('health_probe',{url:'file:///private'},ctx),/HTTP/);
  const controller=new AbortController();controller.abort();await assert.rejects(execute('health_probe',{url},{...ctx,signal:controller.signal}));
});
test('log tail and manifests preserve file integrity and artifact boundaries',async t=>{
  const ctx=fixture(t),file=path.join(ctx.workspace,'server.log');fs.writeFileSync(file,Array.from({length:1000},(_,i)=>`line-${i}`).join('\n'));
  const result=await execute('log_read',{path:file,lines:3,contains:'99',maxBytes:1024},ctx);assert.equal(result.byteTruncated,true);assert.equal(result.lines.length,3);assert.match(result.lines.at(-1).text,/999/);
  const inventory=await execute('file_manifest',{path:ctx.workspace,maxFiles:5},ctx);assert.equal(inventory.files.length,1);assert.match(inventory.files[0].sha256,/^[a-f0-9]{64}$/);
  await assert.rejects(execute('artifact_inventory',{path:'../'},ctx),/workspace/);
  assert.equal((await execute('artifact_inventory',{},ctx)).files.length,0);
});
test('manifest traversal counts empty/skipped directory entries against a streaming visit budget',async t=>{
  const ctx=fixture(t);for(let i=0;i<60;i++)fs.mkdirSync(path.join(ctx.workspace,'empty-'+i));
  const result=await execute('file_manifest',{path:ctx.workspace,maxFiles:5,maxEntries:10},ctx);
  assert.equal(result.limited,true);assert.equal(result.visitedEntries,10);assert.ok(result.visitedDirectories<=10);assert.equal(result.files.length,0);
});
test('schedule definitions preview real dates, deduplicate, stay disabled and enforce worker ownership',async t=>{
  const ctx=fixture(t),preview=await execute('automation_schedule',{action:'preview',cron:'*/15 * * * *'},ctx);assert.equal(preview.next.length,5);assert.ok(preview.timeZone);
  assert.equal(ctx.query('SELECT count(*) n FROM routines').get().n,0);
  const input={action:'create',cron:'0 9 * * 1-5',task:'Synthetic disabled routine'};
  const created=await execute('automation_schedule',input,ctx);assert.equal(created.enabled,false);
  const repeated=await execute('automation_schedule',input,ctx);assert.equal(repeated.replayed,true);assert.equal(repeated.id,created.id);
  assert.equal(ctx.query('SELECT count(*) n FROM routines').get().n,1);
  await assert.rejects(execute('automation_schedule',{action:'enable',workerId:2,scheduleId:created.id},ctx),/belong/);
  ctx.query('INSERT INTO routines(bot_id,cron,prompt,enabled) VALUES(?,?,?,?)').run(2,'* * * * *','PRIVATE_OTHER_WORKER',1);
  await assert.rejects(execute('automation_schedule',{action:'list',workerId:2},ctx),/belong/);
  assert.equal((await execute('automation_schedule',{action:'enable',scheduleId:created.id},ctx)).enabled,true);
  assert.equal((await execute('automation_schedule',{action:'disable',scheduleId:created.id},ctx)).enabled,false);
  await assert.rejects(execute('automation_schedule',{action:'preview',cron:'bad'},ctx),/cron/);
});
test('task history only exposes the current worker\'s runs',async t=>{
  const ctx=fixture(t);ctx.db.exec("INSERT INTO runs(id,bot_id,status) VALUES(11,1,'done'),(12,2,'done');INSERT INTO task_events(id,run_id,type,body) VALUES(1,11,'task.completed','{\"ok\":true}')");
  assert.equal((await execute('task_history',{},ctx)).runs.length,1);
  assert.equal((await execute('task_history',{runId:11},ctx)).events[0].data.ok,true);
  await assert.rejects(execute('task_history',{runId:12},ctx),/owned/);
});
test('shared cron parser retains weekday, ranges and invalid-step behavior',()=>{
  assert.equal(isValidCron('*/15 9-17 * * 1-5'),true);assert.equal(isValidCron('*/0 * * * *'),false);
  const monday=new Date(2026,9,26,9,30,0);assert.equal(cronMatches('*/15 9-17 * * 1-5',monday),true);
  assert.equal(nextRun('*/15 * * * *',monday).getMinutes(),45);
});
