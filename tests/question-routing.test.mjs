import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {QuestionRouter,validateQuestions} from '../runtime/question-routing.js';

function fixture(t,{disk=false}={}){
  const dir=disk?fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-question-test-')):null;
  let db=new DatabaseSync(disk?path.join(dir,'questions.db'):':memory:');
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT,template TEXT);
    INSERT INTO bots VALUES(22,'Coordinator','orchestrator'),(4,'Architect','architect'),(2,'Builder','builder'),(23,'Other','orchestrator');
    CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,parent_run INTEGER,status TEXT,source TEXT,thread TEXT,checkpoint TEXT);
    INSERT INTO runs VALUES(930,22,NULL,'running','api','bot:22','{}'),(950,4,930,'running','Coordinator','bot:4','{}'),(956,2,950,'running','Architect','bot:2','{}'),(960,2,930,'queued','tool-development','bot:2','{}'),(1000,23,NULL,'running','api','bot:23','{}');
    CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT);
    INSERT INTO tool_calls VALUES('956:ask',956,'request_user_input','running');
    CREATE TABLE approvals(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);
    CREATE TABLE project_continuations(run_id INTEGER PRIMARY KEY,project TEXT,stopped INTEGER);
    INSERT INTO project_continuations VALUES(930,'parity',0);`);
  const events=[],state={get db(){return db;},get q(){return sql=>db.prepare(sql);},events};
  state.service=new QuestionRouter({db,emit:(event,payload)=>events.push({event,payload}),humanOwner:'jesse'});
  state.create=()=>{const value=state.service.create({runId:956,callId:'956:ask',questions:[{question:'Use the private fail-closed registry?',options:['Implement it','Use the existing adapter']} ]});state.q("UPDATE runs SET status='waiting_input' WHERE id=956").run();return value;};
  state.actor={runId:930,botId:22,callId:'930:answer'};
  state.host={authenticated:true,principal:'jesse'};
  state.close=()=>db.close();
  state.reopen=()=>{db.close();db=new DatabaseSync(path.join(dir,'questions.db'));state.service=new QuestionRouter({db,humanOwner:'jesse'});};
  t.after(()=>{db.close();if(dir){assert.equal(path.dirname(dir),os.tmpdir());assert.match(path.basename(dir),/^nimbus-question-test-/);fs.rmSync(dir,{recursive:true,force:true});}});
  return state;
}
const answer=(q,extra={})=>({questionId:q.id,expectedVersion:q.version,answers:['Implement within the existing private candidate scope.'],idempotencyKey:'answer:'+q.id,...extra});

test('nested coordinator answers its workers and escalates unresolved input to the real parent before the human',t=>{
  const s=fixture(t);s.q('UPDATE runs SET parent_run=930 WHERE id=1000').run();s.q('UPDATE runs SET parent_run=1000 WHERE id=950').run();
  const scoped={runId:1000,botId:23},question=s.create();assert.equal(question.coordinatorRunId,1000);
  assert.equal(s.service.inbox(s.actor).length,0);assert.equal(s.service.inbox(scoped).length,1);
  assert.throws(()=>s.service.answer(answer(question),s.actor),/another coordinator/);
  const input={questionId:question.id,expectedVersion:question.version,idempotencyKey:'nested-escalation',reason:'The parent assignment may contain the missing destination.'};
  const routed=s.service.escalate(input,scoped);assert.equal(routed.coordinatorRunId,930);assert.equal(routed.audience,'coordinator');assert.equal(routed.correlationId,null);
  assert.deepEqual(s.service.escalate(input,scoped),routed,'Transport retry returns the durable escalation receipt');
  assert.equal(s.service.listHuman().length,0);assert.equal(s.q('SELECT count(*) AS n FROM task_question_outbox').get().n,0);
  assert.throws(()=>s.service.answer(answer(routed),scoped),/another coordinator/);
  const human=s.service.escalate({questionId:routed.id,expectedVersion:routed.version,reason:'No retained evidence establishes the owner preference.'},s.actor);assert.equal(human.audience,'human');assert.ok(human.correlationId);
});

test('nested coordinator can resolve routine questions without escalating and its own question reaches its parent',t=>{
  const s=fixture(t);s.q('UPDATE runs SET parent_run=930 WHERE id=1000').run();s.q('UPDATE runs SET parent_run=1000 WHERE id=950').run();
  const scoped={runId:1000,botId:23},question=s.create(),done=s.service.answer(answer(question),scoped);assert.equal(done.answerActor.runId,1000);assert.equal(done.status,'answered');
  s.q("INSERT INTO tool_calls VALUES('1000:ask',1000,'request_user_input','running')").run();
  const own=s.service.create({runId:1000,callId:'1000:ask',questions:[{question:'Where is the existing project handoff?'}],destination:'human'});assert.equal(own.coordinatorRunId,930);assert.equal(own.audience,'coordinator');
});

test('nested escalation never skips a stopped or uncertain upstream coordinator',t=>{
  const s=fixture(t);s.q('UPDATE runs SET parent_run=930 WHERE id=1000').run();s.q('UPDATE runs SET parent_run=1000 WHERE id=950').run();
  const scoped={runId:1000,botId:23},question=s.create(),input={questionId:question.id,expectedVersion:question.version,reason:'Missing evidence'};
  s.q('UPDATE project_continuations SET stopped=1 WHERE run_id=930').run();assert.throws(()=>s.service.escalate(input,scoped),/owner_stopped/);
  s.q('UPDATE project_continuations SET stopped=0 WHERE run_id=930').run();s.q("INSERT INTO tool_calls VALUES('930:uncertain',930,'shell','uncertain')").run();assert.throws(()=>s.service.escalate(input,scoped),/uncertain_action/);
  assert.equal(s.service.get(question.id).coordinatorRunId,1000);assert.equal(s.service.listHuman().length,0);
});

for(const upstreamState of ['active','stopped','uncertain'])test('recovered scoped question retains upstream ownership: '+upstreamState,t=>{
  const s=fixture(t);s.q('UPDATE runs SET parent_run=930 WHERE id=1000').run();s.q('UPDATE runs SET parent_run=1000 WHERE id=950').run();
  const question=s.create();s.q("UPDATE runs SET status='done' WHERE id=1000").run();
  s.service.ensureAttention(question.id,{create:()=>{s.q("INSERT INTO runs VALUES(1200,23,NULL,'queued','api','bot:23','{}')").run();return 1200;}});
  s.q("UPDATE runs SET status='running' WHERE id=1200").run();
  if(upstreamState==='stopped')s.q('UPDATE project_continuations SET stopped=1 WHERE run_id=930').run();
  if(upstreamState==='uncertain')s.q("INSERT INTO tool_calls VALUES('930:unknown',930,'shell','uncertain')").run();
  const current=s.service.get(question.id),actor={runId:1200,botId:23},input={questionId:question.id,expectedVersion:current.version,reason:'The parent has the remaining project context.',idempotencyKey:'recovered-escalation'};
  if(upstreamState==='active'){
    const result=s.service.escalate(input,actor);assert.equal(result.audience,'coordinator');assert.equal(result.coordinatorRunId,930);
    assert.deepEqual(s.service.escalate(input,actor),result);assert.equal(s.service.inbox(s.actor)[0].id,question.id);
  }else{assert.throws(()=>s.service.escalate(input,actor),/owner_stopped|uncertain_action/);assert.equal(s.service.get(question.id).coordinatorRunId,1200);}
  assert.equal(s.service.listHuman().length,0);assert.equal(s.q('SELECT count(*) AS n FROM task_question_outbox').get().n,0);
});

test('recovered canonical-root question can still request an indispensable human choice',t=>{
  const s=fixture(t),question=s.create();s.q("UPDATE runs SET status='done' WHERE id=930").run();
  s.service.ensureAttention(question.id,{create:()=>{s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;}});
  s.q("UPDATE runs SET status='running' WHERE id=1200").run();const view=s.service.get(question.id);
  const result=s.service.escalate({questionId:question.id,expectedVersion:view.version,reason:'No available project evidence supplies this owner choice.'},{runId:1200,botId:22});
  assert.equal(result.audience,'human');assert.equal(result.coordinatorRunId,1200);assert.ok(result.correlationId);
});

test('plain-language question fields survive durable routing without changing authority',t=>{
  const s=fixture(t,{disk:true});
  const question={title:'Where should reports go?',context:'The task does not identify a destination.',question:'Which folder should Nimbus use?',recommendation:'Use the existing reports folder to keep related files together.',details:'Diagnostic context <not markup>',options:['Reports folder','A different folder']};
  const created=s.service.create({runId:956,callId:'956:ask',questions:[question]});
  s.reopen();const retained=s.service.get(created.id);
  assert.deepEqual(retained.questions,[question]);assert.equal(retained.audience,'coordinator');assert.equal(s.service.listHuman().length,0);
  for(const [key,size]of Object.entries({title:120,context:600,recommendation:600,details:4000})){
    assert.throws(()=>validateQuestions([{question:'Choice?', [key]:'x'.repeat(size+1)}]),new RegExp(key));
    assert.throws(()=>validateQuestions([{question:'Choice?', [key]:{text:'bad'}}]),new RegExp(key));
  }
});

test('host recovery remains internal, preserves authorization and permits an evidence-based coordinator answer',t=>{
  const s=fixture(t),question=s.create();
  const host=s.service.escalate({questionId:question.id,expectedVersion:question.version,destination:'host',reason:'A test points to the wrong file; the authorized host needs to repair its setup.'},s.actor);
  assert.equal(host.audience,'host');assert.equal(host.status,'pending');assert.equal(host.correlationId,null);assert.equal(s.service.listHuman().length,0);
  assert.equal(s.service.inbox(s.actor)[0].audience,'host');assert.equal(s.q('SELECT count(*) AS n FROM task_question_outbox').get().n,0);
  assert.equal(s.q('SELECT count(*) AS n FROM approvals').get().n,0);assert.equal(s.q('SELECT status FROM runs WHERE id=956').get().status,'waiting_input');
  assert.throws(()=>s.service.answer(answer(host),{runId:1000,botId:23}),/another coordinator/);
  const result=s.service.answer(answer(host,{answers:['The verified host repair is ready. Continue the original task.']}),s.actor);
  assert.equal(result.answerActor.kind,'coordinator');assert.equal(result.status,'answered');
});

test('host recovery supports optional human input and rejects invalid destinations atomically',t=>{
  const s=fixture(t),question=s.create();
  assert.throws(()=>s.service.escalate({questionId:question.id,expectedVersion:question.version,destination:'approve',reason:'Bad destination'},s.actor),/human or host/);
  assert.equal(s.service.get(question.id).version,question.version);
  const host=s.service.escalate({questionId:question.id,expectedVersion:question.version,destination:'host',reason:'Internal setup needs host recovery'},s.actor);
  const result=s.service.answerHuman(host.id,['Optional owner information'],{...s.host,expectedVersion:host.version});
  assert.equal(result.answerActor.kind,'human');assert.equal(result.answers[0],'Optional owner information');
});

test('nested worker question is coordinator-only; answer retains same origin and leaves queued work unchanged',t=>{
  const s=fixture(t),q=s.create();
  assert.equal(q.coordinatorRunId,930);assert.equal(q.coordinatorBotId,22);assert.equal(q.audience,'coordinator');assert.equal(q.thread,'bot:22');assert.equal(s.service.listHuman().length,0);
  assert.equal(s.service.inbox(s.actor)[0].originRunId,956);assert.equal(s.service.pendingForRun(930,{descendants:true}).length,1);
  s.q("INSERT INTO tool_calls VALUES('930:answer',930,'answer_worker_question','running')").run();
  const result=s.service.answer(answer(q),s.actor);
  assert.equal(result.status,'answered');assert.equal(result.answerActor.kind,'coordinator');assert.equal(result.answerActor.runId,930);
  assert.equal(s.service.result({runId:956,callId:'956:ask'}).id,q.id);
  assert.equal(s.q('SELECT status FROM runs WHERE id=956').get().status,'waiting_input');
  assert.equal(s.q('SELECT status FROM runs WHERE id=960').get().status,'queued');
  assert.equal(s.q('SELECT count(*) AS n FROM runs').get().n,5);
});

test('origin call dedup is exact and cannot become a second question or alter original data',t=>{
  const s=fixture(t),q=s.create();assert.equal(s.create().id,q.id);
  assert.throws(()=>s.service.create({runId:956,callId:'956:ask',questions:[{question:'Changed'}]}),/identity changed/);
  assert.throws(()=>s.service.create({runId:960,callId:'956:ask',questions:q.questions}),/identity changed/);
  assert.equal(s.q('SELECT count(*) AS n FROM task_questions').get().n,1);
  assert.equal(s.q('SELECT count(*) AS n FROM task_question_events').get().n,1);
});

test('all child questions route to coordinator even when asking for human consent; only explicit escalation reaches human',t=>{
  const s=fixture(t),q=s.create(),escalated=s.service.escalate({questionId:q.id,expectedVersion:q.version,reason:'This new external consent is not supplied by existing scope.',idempotencyKey:'escalate:1'},s.actor);
  assert.equal(escalated.audience,'human');assert.equal(escalated.thread,'bot:22');assert.equal(s.service.listHuman().length,1);assert.equal(escalated.transportStatus,'not_sent_disabled');
  assert.throws(()=>s.service.answer(answer(escalated),s.actor),/requires the human/);
  const result=s.service.answerHuman(q.id,['Owner supplies the missing choice.'],{...s.host,expectedVersion:escalated.version});
  assert.equal(result.answerActor.kind,'human');assert.equal(result.answerActor.principal,'jesse');
  assert.equal(s.q('SELECT count(*) AS n FROM approvals').get().n,0);
});

test('root Orchestrator own unresolved question is human, with disabled transport',t=>{
  const s=fixture(t);s.q("INSERT INTO tool_calls VALUES('930:ask',930,'request_user_input','running')").run();
  const q=s.service.create({runId:930,callId:'930:ask',questions:[{question:'Which account is yours?'}]});
  assert.equal(q.audience,'human');assert.equal(q.coordinatorRunId,930);assert.equal(q.transportStatus,'not_sent_disabled');assert.equal(s.service.listHuman().length,1);
});

test('root host repair stays internal across restart and resumes only from an authenticated answer',t=>{
  const s=fixture(t,{disk:true});s.q("INSERT INTO tool_calls VALUES('930:ask',930,'request_user_input','running')").run();
  const input={runId:930,callId:'930:ask',destination:'host',questions:[{title:'Restore migration control',question:'Confirm the saved recovery assignment.'}]};
  const q=s.service.create(input);assert.equal(q.audience,'host');assert.equal(q.coordinatorRunId,930);assert.equal(q.correlationId,null);assert.equal(s.service.listHuman().length,0);
  assert.equal(s.q('SELECT count(*) n FROM task_question_outbox').get().n,0);assert.equal(s.q('SELECT count(*) n FROM approvals').get().n,0);
  s.reopen();assert.equal(s.service.create(input).id,q.id);assert.equal(s.service.get(q.id).audience,'host');
  assert.throws(()=>s.service.create({...input,destination:'human'}),/identity changed/);
  assert.throws(()=>s.service.answerHuman(q.id,['Confirmed'],{authenticated:false,principal:'host',expectedVersion:q.version}),/Authenticated owner/);
  s.q("INSERT INTO tool_calls VALUES('930:effect',930,'shell','uncertain')").run();
  assert.throws(()=>s.service.answerHuman(q.id,['Confirmed'],{...s.host,expectedVersion:q.version}),/uncertain_action/);
  s.q("UPDATE tool_calls SET state='done' WHERE id='930:effect'").run();
  const result=s.service.answerHuman(q.id,['Verified assignment is ready.'],{authenticated:true,principal:'local-admin',expectedVersion:q.version});
  assert.equal(result.status,'answered');assert.equal(result.answerActor.principal,'local-admin');assert.deepEqual(s.service.result({runId:930,callId:'930:ask'}).answers,['Verified assignment is ready.']);
});

test('direct routing hints cannot bypass child coordination or create invalid audiences',t=>{
  for(const destination of ['host','human']){
    const s=fixture(t),q=s.service.create({runId:956,callId:'956:ask',destination,questions:[{question:'A host repair is needed'}]});
    assert.equal(q.audience,'coordinator');assert.equal(q.coordinatorRunId,930);assert.equal(s.service.listHuman().length,0);assert.equal(s.q('SELECT count(*) n FROM task_question_outbox').get().n,0);
  }
  const s=fixture(t);assert.throws(()=>s.service.create({runId:956,callId:'956:ask',destination:'approve',questions:[{question:'Bad routing'}]}),/human or host/);assert.equal(s.q('SELECT count(*) n FROM task_questions').get().n,0);
});

test('human override is truthful and CAS/idempotency admits exactly one answer',t=>{
  const s=fixture(t),q=s.create();
  const result=s.service.answerHuman(q.id,['Human override'],{...s.host,expectedVersion:q.version,idempotencyKey:'human:1'});
  assert.equal(result.answerActor.kind,'human');assert.equal(result.audience,'coordinator');
  assert.deepEqual(s.service.answerHuman(q.id,['Human override'],{...s.host,expectedVersion:q.version,idempotencyKey:'human:1'}),result);
  assert.throws(()=>s.service.answer(answer(q),s.actor),/no longer pending/);
  assert.throws(()=>s.service.answerHuman(q.id,['Changed'],{...s.host,expectedVersion:q.version,idempotencyKey:'human:1'}),/reused/);
  assert.equal(s.q("SELECT count(*) AS n FROM task_question_events WHERE event='answered'").get().n,1);
});

test('scoped answer rejects forged actor, cross-project, stale identity, holds and unrelated effects',t=>{
  for(const kind of ['bot','otherCoordinator','version','stopped','ownerPolicyStopped','noProgress','denied','uncertain','running','originDenied','originUncertain']){
    const s=fixture(t),q=s.create(),actor={...s.actor},input=answer(q);
    if(kind==='bot')actor.botId=2;if(kind==='otherCoordinator')Object.assign(actor,{runId:1000,botId:23});if(kind==='version')input.expectedVersion++;
    if(kind==='stopped')s.q("UPDATE runs SET status='stopped' WHERE id=930").run();
    if(kind==='ownerPolicyStopped')s.q('UPDATE project_continuations SET stopped=1 WHERE run_id=930').run();
    if(kind==='noProgress')s.q('UPDATE runs SET checkpoint=? WHERE id=930').run(JSON.stringify({noProgress:true}));
    if(kind==='denied')s.q("INSERT INTO approvals VALUES(1,930,'denied')").run();
    if(kind==='originDenied')s.q("INSERT INTO approvals VALUES(1,956,'denied')").run();
    if(kind==='uncertain'||kind==='running')s.q("INSERT INTO tool_calls VALUES('different',930,'shell',?)").run(kind);
    if(kind==='originUncertain')s.q("INSERT INTO tool_calls VALUES('different',956,'shell','uncertain')").run();
    assert.throws(()=>s.service.answer(input,actor),undefined,kind);assert.equal(s.service.get(q.id).status,'pending',kind);
  }
});

test('cancelled origin expires ticket and refuses stale or future transport replies',t=>{
  const s=fixture(t),q=s.create(),e=s.service.escalate({questionId:q.id,expectedVersion:q.version,reason:'Missing owner information'},s.actor);
  s.q("UPDATE runs SET status='stopped' WHERE id=956").run();s.service.reconcile();
  assert.equal(s.service.get(q.id).status,'expired');assert.equal(s.service.transportOutbox()[0].state,'cancelled');
  assert.throws(()=>s.service.answerHuman(q.id,['Late'],{...s.host,expectedVersion:e.version}),/no longer pending/);
});

test('restart after answer before delivery returns exactly the retained result without journal replay',t=>{
  const s=fixture(t,{disk:true}),q=s.create(),answerView=s.service.answer(answer(q),s.actor);
  s.q("UPDATE runs SET status='interrupted' WHERE id=956").run();s.q("UPDATE tool_calls SET state='uncertain' WHERE id='956:ask'").run();
  s.reopen();s.service.reconcile();const resumed=s.service.result({runId:956,callId:'956:ask'});
  assert.equal(resumed.id,q.id);assert.deepEqual(resumed.answers,answerView.answers);assert.equal(resumed.status,'answered');
  assert.equal(s.q("SELECT state FROM tool_calls WHERE id='956:ask'").get().state,'uncertain');
  assert.equal(s.service.markDelivered({questionId:q.id,runId:956,callId:'956:ask'}).deliveredAt>0,true);
  assert.equal(s.q('SELECT count(*) AS n FROM task_questions').get().n,1);
  assert.throws(()=>s.service.result({questionId:q.id,runId:960,callId:'956:ask'}),/another call/);
});

test('legacy human questions remain answerable with truthful audit',t=>{
  const s=fixture(t);const id=Number(s.q('INSERT INTO task_questions(run_id,questions) VALUES(956,?)').run(JSON.stringify([{question:'Existing legacy question'}])).lastInsertRowid);
  assert.equal(s.service.listHuman()[0].id,id);const result=s.service.answerHuman(id,['Legacy answer'],s.host);
  assert.equal(result.answerActor.kind,'human');assert.equal(result.status,'answered');assert.equal(result.answers[0],'Legacy answer');
  assert.throws(()=>s.service.answerHuman(id,['Different'],s.host),/no longer pending/);
});

test('authenticated rebind preserves ticket identity without reviving old coordinator or creating policy',t=>{
  const s=fixture(t),q=s.create();s.q("UPDATE runs SET status='done' WHERE id=930").run();
  s.q("INSERT INTO runs VALUES(1100,22,NULL,'running','api','bot:22','{}')").run();s.q("INSERT INTO project_continuations VALUES(1100,'parity',0)").run();
  const input={questionId:q.id,expectedVersion:q.version,coordinatorRunId:1100,reason:'Verified current successor'};
  assert.throws(()=>s.service.rebind(input,{}),/Authenticated/);
  const rebound=s.service.rebind(input,s.host);assert.equal(rebound.id,q.id);assert.equal(rebound.coordinatorRunId,1100);assert.equal(rebound.version,q.version+1);
  assert.equal(s.q('SELECT status FROM runs WHERE id=930').get().status,'done');assert.throws(()=>s.service.answer(answer(rebound),s.actor),/another coordinator/);
  assert.equal(s.service.answer(answer(rebound),{runId:1100,botId:22}).status,'answered');
});

test('future messaging is disabled; linked mock correlates same question and rejects stale/duplicate/unauthorized',t=>{
  const s=fixture(t),q=s.create(),e=s.service.escalate({questionId:q.id,expectedVersion:q.version,reason:'Unresolved owner input'},s.actor);
  const input={correlationId:e.correlationId,expectedVersion:e.version,answers:['Mock owner answer'],idempotencyKey:'transport:1'};
  assert.throws(()=>s.service.acceptTransportReply(input,s.host),/disabled/);
  assert.throws(()=>s.service.acceptTransportReply(input,{...s.host,transport:'mock',linkedOwner:'someone'}),/disabled/);
  assert.throws(()=>s.service.acceptTransportReply({...input,expectedVersion:1},{...s.host,transport:'mock',linkedOwner:'jesse'}),/version changed/);
  const actor={...s.host,transport:'mock',linkedOwner:'jesse'},result=s.service.acceptTransportReply(input,actor);
  assert.equal(result.id,q.id);assert.deepEqual(s.service.acceptTransportReply(input,actor),result);
  assert.throws(()=>s.service.acceptTransportReply({...input,idempotencyKey:'transport:2'},actor),/no longer pending/);
  assert.equal(s.service.transportOutbox()[0].state,'resolved');
  assert.equal(s.service.transportOutbox().filter(x=>x.state==='disabled').length,0);
});

test('orphan attention binds NEW bounded host run once, including commit-before-enqueue crash gap',t=>{
  const s=fixture(t),q=s.create();s.q("UPDATE runs SET status='done' WHERE id IN (930,950)").run();let created=0;
  const create=input=>{created++;assert.equal(input.botId,22);assert.equal(input.requestId,'question-attention:'+q.id);s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;};
  const first=s.service.ensureAttention(q.id,{create});assert.equal(first.enqueue,true);assert.equal(first.runId,1200);
  const restarted=new QuestionRouter({db:s.db}),second=restarted.ensureAttention(q.id,{create});assert.equal(second.runId,1200);assert.equal(second.enqueue,true);assert.equal(created,1);
  assert.equal(s.q('SELECT status FROM runs WHERE id=930').get().status,'done');assert.equal(s.q('SELECT count(*) AS n FROM project_continuations').get().n,1);
  assert.equal(restarted.attentionForRun(1200).question_id,q.id);assert.equal(restarted.get(q.id).coordinatorRunId,1200);
  s.q("UPDATE runs SET status='running' WHERE id=1200").run();assert.equal(restarted.answer(answer(restarted.get(q.id)),{runId:1200,botId:22}).status,'answered');
});

test('attention insert failure rolls back route/reservation and never fabricates policy or revives a run',t=>{
  const s=fixture(t),q=s.create();s.q("UPDATE runs SET status='done' WHERE id=930").run();
  assert.throws(()=>s.service.ensureAttention(q.id,{create:()=>{s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();throw Error('crash before commit');}}),/crash before commit/);
  assert.equal(s.q('SELECT * FROM runs WHERE id=1200').get(),undefined);assert.equal(s.q('SELECT count(*) AS n FROM task_question_attention').get().n,0);assert.equal(s.service.get(q.id).coordinatorRunId,930);
  s.q("UPDATE runs SET status='stopped' WHERE id=930").run();assert.throws(()=>s.service.ensureAttention(q.id,{create:()=>assert.fail('must not create')}),/override coordinator hold/);
});

test('no ancestor chooses only an unambiguous Orchestrator and ambiguous profiles never dispatch',t=>{
  const s=fixture(t);s.q('UPDATE runs SET parent_run=NULL WHERE id=956').run();const q=s.create();assert.equal(q.coordinatorRunId,null);assert.equal(q.audience,'coordinator');assert.equal(s.service.listHuman().length,0);
  assert.throws(()=>s.service.ensureAttention(q.id,{create:()=>assert.fail('ambiguous')}),/unambiguous/);
  s.q('DELETE FROM bots WHERE id=23').run();assert.equal(s.service.ensureAttention(q.id,{create:()=>assert.fail('busy profile must not queue behind itself')}).reason,'coordinator_bot_busy');
  s.q("UPDATE runs SET status='done' WHERE id=930").run();const result=s.service.ensureAttention(q.id,{create:()=>{s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;}});assert.equal(result.runId,1200);
});

test('delegated Orchestrator asks its real ancestor, never its own blocked queue',t=>{
  const s=fixture(t);s.q("INSERT INTO runs VALUES(1100,23,950,'running','Architect','bot:23','{}')").run();s.q("INSERT INTO tool_calls VALUES('1100:ask',1100,'request_user_input','running')").run();
  const q=s.service.create({runId:1100,callId:'1100:ask',questions:[{question:'Which implementation fits the project?'}]});
  assert.equal(q.coordinatorRunId,930);assert.equal(q.audience,'coordinator');assert.notEqual(q.coordinatorRunId,q.originRunId);
});

test('attention is revoked by an original owner stop and cannot create duplicate successors after termination',t=>{
  const s=fixture(t),q=s.create();s.q("UPDATE runs SET status='done' WHERE id=930").run();
  s.service.ensureAttention(q.id,{create:()=>{s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;}});
  s.q("UPDATE runs SET status='running' WHERE id=1200").run();s.q('UPDATE project_continuations SET stopped=1 WHERE run_id=930').run();
  assert.throws(()=>s.service.answer(answer(s.service.get(q.id)),{runId:1200,botId:22}),/Original coordinator authority/);
  s.q("UPDATE runs SET status='done' WHERE id=1200").run();const held=s.service.ensureAttention(q.id,{create:()=>assert.fail('must not duplicate')});assert.equal(held.reason,'attention_ended_without_answer');
});

test('question input and output publication fail safely',t=>{
  assert.throws(()=>validateQuestions([null]));assert.throws(()=>validateQuestions([{question:'',options:[]}]));
  const s=fixture(t);s.service.emit=()=>{throw Error('UI disconnected');};const q=s.create();assert.equal(q.status,'pending');assert.equal(s.service.get(q.id).status,'pending');
  assert.throws(()=>s.service.answerHuman(q.id,['x'],{...s.host}),/version changed/);
});

test('attention setup and busy holds are visible, durable and deduplicated without an event storm',t=>{
  const s=fixture(t),q=s.create();s.q("UPDATE runs SET status='done' WHERE id=930").run();
  const create=()=>{throw Error('Question tools are missing from the configured coordinator profile');};
  assert.throws(()=>s.service.ensureAttention(q.id,{create}),/tools are missing/);const events=s.events.length;
  assert.match(s.service.get(q.id).holdReason,/Question tools are missing/);
  assert.throws(()=>s.service.ensureAttention(q.id,{create}),/tools are missing/);assert.equal(s.events.length,events);
  assert.equal(s.q('SELECT count(*) AS n FROM task_question_attention').get().n,0);
  assert.equal(s.q("SELECT count(*) AS n FROM task_question_events WHERE event='attention_hold'").get().n,1);
});

test('actual rejected approval status blocks coordinator, origin, attention seed and original attention authority',t=>{
  for(const kind of ['coordinator','origin','attentionSeed','attentionOwner']){
    const s=fixture(t),q=s.create();
    if(kind==='coordinator'||kind==='origin'){
      s.q("INSERT INTO approvals VALUES(1,?,'rejected')").run(kind==='origin'?956:930);
      assert.throws(()=>s.service.answer(answer(q),s.actor),/reconciliation/);continue;
    }
    s.q("UPDATE runs SET status='done' WHERE id=930").run();
    const create=()=>{s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;};
    if(kind==='attentionSeed'){s.q("INSERT INTO approvals VALUES(1,930,'rejected')").run();assert.throws(()=>s.service.ensureAttention(q.id,{create}),/policy_denied/);}
    else{s.service.ensureAttention(q.id,{create});s.q("UPDATE runs SET status='running' WHERE id=1200").run();s.q("INSERT INTO approvals VALUES(1,930,'rejected')").run();assert.throws(()=>s.service.answer(answer(s.service.get(q.id)),{runId:1200,botId:22}),/policy_denied/);}
  }
});

test('trusted adopted owner supersedes historical ancestry and reassignment/revocation invalidate stale answers',t=>{
  const s=fixture(t);s.q("INSERT INTO runs VALUES(1100,22,NULL,'running','api','bot:22','{}')").run();
  let binding={runId:930,requestId:'retained-tool',projectKey:'parity',authorized:true};s.service.resolveCoordinator=()=>binding;
  const q=s.create();assert.equal(q.ownerRequestId,'retained-tool');
  binding={...binding,runId:1100};assert.throws(()=>s.service.answer(answer(q),s.actor),/adopted coordinator/);
  s.service.reconcile();const rebound=s.service.get(q.id);assert.equal(rebound.coordinatorRunId,1100);assert.equal(rebound.version,q.version+1);
  binding={...binding,authorized:false};assert.throws(()=>s.service.answer(answer(rebound),{runId:1100,botId:22}),/adopted coordinator/);
  assert.equal(s.service.ensureAttention(q.id,{create:()=>assert.fail('revoked may not fall back')}).reason,'coordinator_ownership_requires_review');
  binding={...binding,authorized:true};assert.equal(s.service.answer(answer(rebound),{runId:1100,botId:22}).status,'answered');
});

test('human escalation correlation is superseded when authoritative owner changes',t=>{
  const s=fixture(t);s.q("INSERT INTO runs VALUES(1100,22,NULL,'running','api','bot:22','{}')").run();let runId=930;
  s.service.resolveCoordinator=()=>({runId,requestId:'retained-tool',projectKey:'parity',authorized:true});
  const q=s.create(),e=s.service.escalate({questionId:q.id,expectedVersion:q.version,reason:'Unresolved preference'},s.actor);
  runId=1100;s.service.reconcile();const updated=s.service.get(q.id);
  assert.notEqual(updated.correlationId,e.correlationId);assert.equal(updated.audience,'human');assert.equal(updated.version,e.version+1);
  const out=s.service.transportOutbox();assert.equal(out.find(x=>x.correlationId===e.correlationId).state,'superseded');assert.equal(out.filter(x=>x.state==='disabled').length,1);
  assert.throws(()=>s.service.acceptTransportReply({correlationId:e.correlationId,expectedVersion:e.version,answers:['stale']},{...s.host,transport:'mock',linkedOwner:'jesse'}),/version changed/);
});

test('parked adopted owner gets question-only attention without changing waiting-tool dependency',t=>{
  const s=fixture(t);s.q("UPDATE runs SET status='waiting_tool',checkpoint=? WHERE id=930").run(JSON.stringify({awaitingToolRequest:'retained-tool'}));
  s.service.resolveCoordinator=()=>({runId:930,requestId:'retained-tool',projectKey:'parity',authorized:true,attentionOnly:true});
  const q=s.create();const a=s.service.ensureAttention(q.id,{create:()=>{s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;}});
  assert.equal(a.runId,1200);s.service.reconcile();assert.equal(s.service.get(q.id).coordinatorRunId,1200);
  const old=s.q('SELECT status,checkpoint FROM runs WHERE id=930').get();assert.equal(old.status,'waiting_tool');assert.equal(JSON.parse(old.checkpoint).awaitingToolRequest,'retained-tool');
  s.q("UPDATE runs SET status='running' WHERE id=1200").run();assert.equal(s.service.answer(answer(s.service.get(q.id)),{runId:1200,botId:22}).status,'answered');
  assert.equal(s.q('SELECT count(*) AS n FROM project_continuations').get().n,1);
});

test('second same-project orphan joins existing attention while its first question awaits human',t=>{
  const s=fixture(t),first=s.create();s.q("UPDATE runs SET status='done' WHERE id=930").run();let created=0;
  const create=()=>{created++;s.q("INSERT INTO runs VALUES(1200,22,NULL,'queued','api','bot:22','{}')").run();return 1200;};
  s.service.ensureAttention(first.id,{create});s.q("UPDATE runs SET status='running' WHERE id=1200").run();const actor={runId:1200,botId:22};
  const firstHeld=s.service.get(first.id);s.service.escalate({questionId:first.id,expectedVersion:firstHeld.version,reason:'Owner preference is missing'},actor);s.q("UPDATE runs SET status='waiting_input' WHERE id=1200").run();
  s.q("INSERT INTO runs VALUES(1100,2,950,'running','Architect','bot:2','{}')").run();s.q("INSERT INTO tool_calls VALUES('1100:ask',1100,'request_user_input','running')").run();
  const second=s.service.create({runId:1100,callId:'1100:ask',questions:[{question:'Use the existing evidence-backed implementation?'}]});
  const joined=s.service.ensureAttention(second.id,{create});assert.equal(joined.runId,1200);assert.equal(joined.status,'bound_existing');assert.equal(created,1);
  assert.deepEqual(s.service.attentionForRun(1200).questionIds,[first.id,second.id]);assert.equal(s.service.inbox(actor).length,2);
  assert.equal(s.service.answer(answer(s.service.get(second.id)),actor).status,'answered');assert.equal(s.service.get(first.id).status,'pending');
});

test('legacy worker upgrade matches actual journal evidence and preserves exact question identity/options',t=>{
  const s=fixture(t);s.q('ALTER TABLE tool_calls ADD COLUMN args TEXT').run();const questions=[{question:'Legacy implementation choice?',options:['First','Second']}];
  s.q("UPDATE tool_calls SET args=?,state='uncertain' WHERE id='956:ask'").run(JSON.stringify({questions}));s.q("UPDATE runs SET status='interrupted' WHERE id=956").run();
  const id=Number(s.q('INSERT INTO task_questions(run_id,questions) VALUES(956,?)').run(JSON.stringify(questions)).lastInsertRowid);
  s.service.reconcile();const routed=s.service.get(id);assert.equal(routed.audience,'coordinator');assert.equal(routed.callId,'956:ask');assert.equal(routed.coordinatorRunId,930);assert.deepEqual(routed.questions,questions);
  assert.equal(s.service.listHuman().length,0);assert.equal(s.q("SELECT state FROM tool_calls WHERE id='956:ask'").get().state,'uncertain');
  s.service.answer(answer(routed),s.actor);assert.equal(s.service.getForCall(956,'956:ask').id,id);
  assert.equal(s.q("SELECT state FROM tool_calls WHERE id='956:ask'").get().state,'uncertain');
});

test('ambiguous or malformed legacy worker rows hold individually and do not block later valid migration',t=>{
  const s=fixture(t);s.q('ALTER TABLE tool_calls ADD COLUMN args TEXT').run();const questions=[{question:'Retained question'}];
  const bad=Number(s.q("INSERT INTO task_questions(run_id,questions) VALUES(950,'{}')").run().lastInsertRowid);
  s.q("UPDATE tool_calls SET args=? WHERE id='956:ask'").run(JSON.stringify({questions}));
  const good=Number(s.q('INSERT INTO task_questions(run_id,questions) VALUES(956,?)').run(JSON.stringify(questions)).lastInsertRowid);
  s.service.reconcile();assert.equal(s.service.get(bad).audience,'coordinator');assert.equal(s.service.get(bad).callId,'legacy-question:'+bad);assert.equal(s.service.get(good).callId,'956:ask');
  assert.equal(s.service.listHuman().length,0);assert.equal(s.q('SELECT questions FROM task_questions WHERE id=?').get(bad).questions,'{}');
  assert.throws(()=>s.service.answer(answer(s.service.get(bad)),s.actor),/another coordinator|Legacy question/);
});
