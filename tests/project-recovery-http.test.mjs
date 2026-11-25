import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('owner recovery routes require authentication, explicit arming and source-safe association',async t=>{
  const {base,data,api,database,bots}=await sidebarFixture(t);
  const requestId=randomUUID();
  const ids=database(db=>{
    const insert=db.prepare('INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,?,?,?)');
    const checkpoint=JSON.stringify({messages:[],steps:0});
    const old=Number(insert.run(bots.root.id,'bot:'+bots.root.id,'Historical project owner','done','user',checkpoint).lastInsertRowid);
    const leader=Number(insert.run(bots.root.id,'bot:'+bots.root.id,'Current authorized project','paused','user',checkpoint).lastInsertRowid);
    db.prepare("INSERT INTO tool_development_requests(id,tool_name,title,capability,domain,acceptance_json,effects,gap_type,fingerprint,status,phase,message,origin_run_id,requester_run_id,origin_json) VALUES(?,'fixture_recovery','Recovery','Fixture','engineering','[]','read','missing_tool',?,'blocked','blocked','Retained incomplete source',?,?, '{}')").run(requestId,requestId,old,old);
    return{old,leader,checkpoint};
  });
  const payload={leaderRunId:ids.leader,project:'fixture',reason:'Explicit owner adoption of retained fixture request.'};
  for(const suffix of ['adopt','continue-incomplete','resume-reviewed','review-source']){
    const response=await fetch(base+'/api/tool-requests/'+requestId+'/'+suffix,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
    assert.equal(response.status,401,suffix);
    const crossOrigin=await fetch(base+'/api/tool-requests/'+requestId+'/'+suffix,{method:'POST',headers:{'content-type':'application/json','x-nimbus-admin':fs.readFileSync(path.join(data,'admin.token'),'utf8').trim(),origin:'https://untrusted.invalid'},body:JSON.stringify(payload)});
    assert.equal(crossOrigin.status,403,suffix+' rejects foreign origin even with administration credentials');
  }
  assert.equal((await api('/api/tool-requests/'+requestId+'/adopt','POST',payload)).status,400,'unarmed leader cannot recover');
  assert.equal((await api('/api/runs/'+ids.leader+'/continuation','POST',{project:'fixture',checkpointRef:'fixture/checkpoint.md',mode:'until_complete'})).status,200);
  const adopted=await api('/api/tool-requests/'+requestId+'/adopt','POST',payload);
  assert.equal(adopted.status,200,JSON.stringify(adopted.value));
  assert.equal((await api('/api/tool-requests/'+requestId+'/ownership')).value.leader_run_id,ids.leader);
  database(db=>{
    const request=db.prepare('SELECT * FROM tool_development_requests WHERE id=?').get(requestId);
    assert.equal(request.origin_run_id,ids.old);assert.equal(request.requester_run_id,ids.old);
    assert.equal(db.prepare('SELECT checkpoint FROM runs WHERE id=?').get(ids.leader).checkpoint,ids.checkpoint);
    assert.equal(db.prepare('SELECT consumer FROM tool_development_watchers WHERE request_id=? AND run_id=?').get(requestId,ids.leader).consumer,1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM project_lifecycle_owner_events WHERE request_id=?').get(requestId).n,1);
  });
  const invalid=await api('/api/tool-requests/'+requestId+'/continue-incomplete','POST',{stageRunId:ids.old,expectedSourceHash:'a'.repeat(64),reason:'No linked stage must not revive a completed task.'});
  assert.equal(invalid.status,400);
  assert.equal((await api('/api/runs/'+ids.old)).value.status,'done');
});

test('real runner notifications pause only the actual awaited request and tolerate malformed unrelated history',async t=>{
  const {api,database,bots}=await sidebarFixture(t),requestId=randomUUID();
  const ids=database(db=>{
    const insert=db.prepare('INSERT INTO runs(bot_id,thread,prompt,status,source,checkpoint) VALUES(?,?,?,?,?,?)');
    const rows=['different','matching','malformed'].map(kind=>Number(insert.run(bots.root.id,'bot:'+bots.root.id,'Retained fixture','waiting_tool','api',kind==='malformed'?'{broken':JSON.stringify({messages:[],awaitingToolRequest:kind==='matching'?requestId:'other-request'})).lastInsertRowid));
    db.prepare("INSERT INTO tool_development_requests(id,tool_name,title,capability,domain,acceptance_json,effects,gap_type,fingerprint,status,phase,message,origin_run_id,requester_run_id,origin_json) VALUES(?,'fixture_notice','Notice','Fixture','engineering','[]','read','missing_tool',?,'blocked','blocked','Held',?,?,'{}')").run(requestId,requestId,rows[0],rows[0]);
    for(const id of rows)db.prepare('INSERT INTO tool_development_watchers(request_id,run_id,bot_id,thread,consumer,notified_version) VALUES(?,?,?,?,1,1)').run(requestId,id,bots.root.id,'bot:'+bots.root.id);
    return rows;
  });
  const cancelled=await api('/api/tool-requests/'+requestId+'/cancel','POST',{});assert.equal(cancelled.status,200,JSON.stringify(cancelled.value));
  database(db=>{assert.deepEqual(ids.map(id=>db.prepare('SELECT status FROM runs WHERE id=?').get(id).status),['waiting_tool','paused','waiting_tool']);assert.equal(db.prepare("SELECT count(*) AS n FROM task_events WHERE type='tool.development' AND json_extract(body,'$.requestId')=?").get(requestId).n,3);});
});
