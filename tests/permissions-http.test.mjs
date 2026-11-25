import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('permission settings require authentication, persist and release only active pending approvals',async t=>{
  const {base,api,data,database,bots}=await sidebarFixture(t);
  const before=(await api('/api/state')).value.bots;
  assert.equal((await api('/api/runtime/config')).value.workers.permissionMode,'rules');
  const unauthorized=await fetch(base+'/api/runtime/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({workers:{permissionMode:'all'}})});
  assert.equal(unauthorized.status,401);
  for(const permissionMode of ['never',true,null])assert.notEqual((await api('/api/runtime/config','PUT',{workers:{permissionMode}})).status,200);
  const ids=database(db=>{
    const result=[];
    for(const status of ['waiting_approval','needs_review']){
      const runId=Number(db.prepare('INSERT INTO runs(bot_id,thread,status) VALUES(?,?,?)').run(bots.builder.id,'bot:'+bots.builder.id,status).lastInsertRowid);
      const approvalId=Number(db.prepare("INSERT INTO approvals(run_id,bot_id,thread,tool,input) VALUES(?,?,?,'write_file','{}')").run(runId,bots.builder.id,'bot:'+bots.builder.id).lastInsertRowid);
      db.prepare("INSERT INTO messages(thread,author,kind,body,run_id) VALUES(?,?,'approval',?,?)").run('bot:'+bots.builder.id,String(bots.builder.id),JSON.stringify({approvalId,status:'pending'}),runId);
      result.push({runId,approvalId});
    }
    return result;
  });
  const enabled=await api('/api/runtime/config','PUT',{workers:{permissionMode:'all'}});assert.equal(enabled.status,200);
  assert.equal((await api('/api/runtime/config')).value.workers.permissionMode,'all');
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'..','config.json'),'utf8')).workers.permissionMode,'all');
  database(db=>{
    assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(ids[0].approvalId).status,'approved');
    assert.equal(db.prepare('SELECT status FROM approvals WHERE id=?').get(ids[1].approvalId).status,'pending');
    assert.equal(JSON.parse(db.prepare("SELECT body FROM messages WHERE run_id=? AND kind='approval'").get(ids[0].runId).body).status,'approved');
    assert.equal(db.prepare("SELECT count(*) AS n FROM task_events WHERE run_id=? AND type='approval.auto_approved'").get(ids[0].runId).n,1);
  });
  assert.equal((await api('/api/runtime/config','PUT',{workers:{permissionMode:'rules'}})).status,200);
  const after=(await api('/api/state')).value.bots;
  assert.deepEqual(after.map(b=>[b.id,b.tools,b.approval_rules,b.allow_rules]),before.map(b=>[b.id,b.tools,b.approval_rules,b.allow_rules]));
});
