import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('explicit admin delivery is exact, durable, idempotent and non-executing',async t=>{
 const f=await sidebarFixture(t,{ownedContext:true});
 const {api,base,headers,bots,seedOwnedRun,database,fixtureCommand}=f;
 const thread='bot:'+bots.root.id;
 const created=await api('/api/tasks','POST',{botId:bots.root.id,task:'Keep original task',requestId:'api-leader'});
 assert.equal(created.status,202,JSON.stringify(created));
 const id=created.value.runId;
 await f.reconcileFixture();
 const route='/api/admin/runs/'+id+'/context',request={text:'Authorized drain instruction',requestId:'host-1'};
 const before=database(db=>db.prepare('SELECT * FROM runs WHERE id=?').get(id));
 assert.equal((await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)})).status,401);
 assert.equal((await fetch(base+route,{method:'POST',headers:{...headers,origin:'https://evil.invalid'},body:JSON.stringify(request)})).status,403);
 const ticket=await api('/api/admin/login-ticket','POST',{});
 const login=await fetch(ticket.value.url,{redirect:'manual'});
 const cookie=login.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(base+route,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify(request)})).status,403);
 const first=await api(route,'POST',request);assert.equal(first.status,200,JSON.stringify(first));
 assert.equal(first.value.thread,thread);assert.equal(first.value.author,'user');assert.equal(first.value.run_id,id);
 const repeat=await api(route,'POST',request);assert.equal(repeat.status,200);assert.equal(repeat.value.id,first.value.id);assert.equal(repeat.value.replayed,true);
 assert.equal((await api(route,'POST',{...request,text:'Different'})).status,409);
 assert.deepEqual(database(db=>db.prepare('SELECT * FROM runs WHERE id=?').get(id)),before);
 assert.equal(database(db=>db.prepare('SELECT count(*) n FROM runs').get().n),1);
 assert.equal(database(db=>db.prepare('SELECT count(*) n FROM tool_calls').get().n),0);
 assert.equal((await fixtureCommand('consume',{runId:id})).length,1);
 assert.equal((await fixtureCommand('consume',{runId:id})).length,0);
 const state=JSON.parse(database(db=>db.prepare('SELECT checkpoint FROM runs WHERE id=?').get(id).checkpoint));
 assert.deepEqual(state.messages,[{role:'user',content:request.text}]);

 const approval=await seedOwnedRun(bots.builder.id,'bot:'+bots.builder.id,'waiting_approval','api');
 database(db=>db.prepare("INSERT INTO approvals(run_id,status,tool) VALUES(?,'pending','fixture')").run(approval));
 assert.equal((await api('/api/admin/runs/'+approval+'/context','POST',{text:'Not approval',requestId:'approval'})).status,200);
 database(db=>{
  assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(approval).status,'waiting_approval');
  assert.equal(db.prepare('SELECT status FROM approvals WHERE run_id=?').get(approval).status,'pending');
 });
 for(const bad of [{},{text:' ' ,requestId:'x'},{text:'x',requestId:''},{text:'x'.repeat(32001),requestId:'x'},{text:'x',requestId:'x',thread:'room:1'}])
   assert.equal((await api(route,'POST',bad)).status,400);
 assert.equal((await api('/api/admin/runs/0/context','POST',request)).status,400);
 assert.equal((await api('/api/admin/runs/999999/context','POST',{...request,requestId:'missing'})).status,404);
 for(const status of ['done','error','cancelled','interrupted','paused','needs_review','stopped','no_progress']){
  database(db=>db.prepare('UPDATE runs SET status=? WHERE id=?').run(status,id));
  assert.equal((await api(route,'POST',{text:'Reject',requestId:'status-'+status})).status,409,status);
 }
 database(db=>db.prepare("UPDATE runs SET status='waiting_cloud',checkpoint=? WHERE id=?").run(JSON.stringify({messages:[],noProgress:true}),id));
 assert.equal((await api(route,'POST',{text:'Reject',requestId:'noProgress'})).status,409);
 database(db=>db.prepare("UPDATE runs SET checkpoint=NULL WHERE id=?").run(id));
 for(const [column,value] of [['parent_run',approval],['depth',1],['source','tool-development'],['thread','room:999']]){
  const old=database(db=>db.prepare('SELECT '+column+' v FROM runs WHERE id=?').get(id).v);
  database(db=>db.prepare('UPDATE runs SET '+column+'=? WHERE id=?').run(value,id));
  assert.equal((await api(route,'POST',{text:'Reject',requestId:'guard-'+column})).status,409,column);
  database(db=>db.prepare('UPDATE runs SET '+column+'=? WHERE id=?').run(old,id));
 }
 database(db=>db.prepare("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES('fixture','build',1,?,?,'running','fixture')").run(bots.root.id,id));
 assert.equal((await api(route,'POST',{text:'Reject',requestId:'stage'})).status,409);
 database(db=>db.prepare("DELETE FROM tool_development_stages WHERE request_id='fixture'").run());
 // Force a late transactional failure after message and journal insertion.
 database(db=>db.exec("CREATE TRIGGER reject_context BEFORE INSERT ON message_requests WHEN NEW.request_key='admin-run-context:rollback' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END"));
 const counts=()=>database(db=>['messages','run_context','task_events','message_requests'].map(table=>db.prepare('SELECT count(*) n FROM '+table).get().n));
 const saved=counts();
 const stream=await fetch(base+'/api/events',{headers});
 const reader=stream.body.getReader();let observed='';
 const collecting=(async()=>{while(true){const chunk=await reader.read();if(chunk.done)break;observed+=new TextDecoder().decode(chunk.value);}})();
 assert.equal((await api(route,'POST',{text:'Must roll back',requestId:'rollback'})).status,500);
 await new Promise(resolve=>setTimeout(resolve,150));
 await reader.cancel();await collecting;
 assert.doesNotMatch(observed,/Must roll back|context.queued|event: message/);
 assert.deepEqual(counts(),saved);
 // API runs remain excluded from implicit selection; an ordinary user run wins.
 const user=await seedOwnedRun(bots.root.id,thread,'waiting_cloud','user');
 assert.equal((await api('/api/threads/'+encodeURIComponent(thread)+'/messages','POST',{text:'Implicit user context'})).status,200);
 assert.equal(database(db=>db.prepare('SELECT count(*) n FROM run_context WHERE run_id=?').get(user).n),1);
 assert.equal(database(db=>db.prepare('SELECT count(*) n FROM run_context WHERE run_id=?').get(id).n),1);
});
