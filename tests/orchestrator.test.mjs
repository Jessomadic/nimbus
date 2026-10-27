import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ORCHESTRATOR_PROFILE_ID,resolveOrchestrator,resolveTaskWorker,orchestratorStatus,planOrchestratorSetup,createTaskSubmission} from '../runtime/orchestrator.js';
import {setupOrchestrator} from '../bin/setup-orchestrator.mjs';
import {ROLE_PROFILES} from '../runtime/roles.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const worker=(id,name,template,parent_bot_id=null)=>({id,name,template,parent_bot_id,model:'auto',default_model:'sol',effort:'high',role:'Keep role '+id,instructions:'Retain custom instructions '+id,color:'#123456',runtime:'auto',approval_rules:['retain approval '+id],allow_rules:['retain allow '+id],tools:['ask_worker','read_file'],shape:'blob',computer:0,display_group:'engineering',created_at:12345+id,plugins:[]});
const roster=()=>[worker(31,'Builder','builder'),worker(72,'GitHub','github-coordinator'),worker(83,'GitHub Commits','github-commits',72),worker(96,'Custom Child','custom',31),worker(207,'Orchestrator','orchestrator')];
const errorCode=code=>error=>error.code===code;
function taskFixture(t,bots=roster()){
  const db=new DatabaseSync(':memory:'),q=sql=>db.prepare(sql),captured=[];
  db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,name TEXT,template TEXT,parent_bot_id INTEGER,model TEXT,default_model TEXT,effort TEXT);
    CREATE TABLE runs(id INTEGER PRIMARY KEY AUTOINCREMENT,bot_id INTEGER,thread TEXT,prompt TEXT,status TEXT,source TEXT,origin_request_id TEXT);
    CREATE TABLE task_requests(request_key TEXT PRIMARY KEY,fingerprint TEXT,run_id INTEGER);`);
  for(const bot of bots)q('INSERT INTO bots VALUES(?,?,?,?,?,?,?)').run(bot.id,bot.name,bot.template,bot.parent_bot_id,bot.model,bot.default_model,bot.effort);
  const options={db,query:q,runTask:args=>{captured.push(args);return Number(q('INSERT INTO runs(bot_id,thread,prompt,status,source,origin_request_id) VALUES(?,?,?,?,?,?)').run(args.botId,args.thread,args.prompt,'queued',args.source,args.originRequestId).lastInsertRowid);},getTask:id=>q('SELECT * FROM runs WHERE id=?').get(id)};
  t.after(()=>db.close());return{db,q,captured,options,submit:createTaskSubmission(options)};
}
function setupFixture(t,{bots=roster().filter(bot=>bot.template!=='orchestrator'),active=0,raceId=null}={}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-orchestrator-test-')),state={bots:clone(bots),queues:{workers:{active,queued:0}},history:[{id:9,content:'Retain private history'}]},calls=[];
  const api=async(route,method='GET',body)=>{
    calls.push({route,method,body:clone(body??null)});
    if(route==='/api/state'&&method==='GET')return clone(state);
    if(route==='/api/templates/orchestrator/add'&&method==='POST'){
      assert.equal(state.bots.some(bot=>bot.template==='orchestrator'),false,'Setup must not create a duplicate coordinator');
      const bot=worker(207,'Orchestrator','orchestrator');state.bots.push(bot);return clone(bot);
    }
    const match=/^\/api\/bots\/(\d+)$/.exec(route);if(match&&method==='PATCH'){
      const bot=state.bots.find(item=>item.id===Number(match[1]));assert.ok(bot);
      if(Object.hasOwn(body,'parent_bot_id')){
        assert.deepEqual(Object.keys(body).sort(),['expected_parent_bot_id','parent_bot_id']);assert.equal(body.expected_parent_bot_id,null);
        if(bot.id===raceId){raceId=null;bot.parent_bot_id=96;throw Object.assign(new Error('Parent changed concurrently'),{statusCode:409});}
        if(bot.parent_bot_id!==body.expected_parent_bot_id)throw Object.assign(new Error('Parent guard conflict'),{statusCode:409});
        bot.parent_bot_id=body.parent_bot_id;
      }else assert.deepEqual(body,{},'Roster refresh must not replace worker settings');
      return clone(bot);
    }
    throw new Error('Unexpected fixture API request: '+method+' '+route);
  };
  t.after(()=>{assert.equal(path.dirname(temp),os.tmpdir());assert.match(path.basename(temp),/^nimbus-orchestrator-test-/);fs.rmSync(temp,{recursive:true,force:true});});
  return{state,calls,api,receipt:path.join(temp,'receipt.json'),temp};
}

test('Orchestrator profile delegates from a current team snapshot and retains specialist parent ownership',()=>{
  assert.equal(ORCHESTRATOR_PROFILE_ID,'orchestrator');assert.equal(ROLE_PROFILES.length,21);
  const root=ROLE_PROFILES.find(profile=>profile.id==='orchestrator');assert.equal(root.model,'auto');assert.equal(root.default_model,'sol');assert.equal(root.effort,'high');assert.equal(root.parent_profile,undefined);
  for(const name of ['team_status','ask_worker','request_tool','self_update'])assert.ok(root.tools.includes(name),name);
  for(const name of ['shell','exec_command','read_file','write_file','apply_patch','browser'])assert.ok(!root.tools.includes(name),name+' belongs to a specialist');
  assert.match(root.instructions,/first coordination tool call is team_status/);assert.match(root.instructions,/human owner remains the authority/);assert.match(root.instructions,/not configured or verified/);assert.match(root.instructions,/Workers may still communicate directly/);
  for(const profile of ROLE_PROFILES.filter(profile=>profile!==root))assert.equal(profile.parent_profile,profile.id.startsWith('github-')&&profile.id!=='github-coordinator'?'github-coordinator':'orchestrator',profile.id);
});

test('Coordinator resolution uses the unique profile and refuses name collisions, duplicates and parented roots',()=>{
  const bots=roster();assert.equal(resolveOrchestrator(bots).id,207);assert.equal(resolveOrchestrator([{...bots.at(-1),name:'Owner renamed coordinator'}]).id,207);
  assert.equal(resolveOrchestrator([],{required:false}),null);assert.throws(()=>resolveOrchestrator([]),errorCode('orchestrator_not_configured'));
  assert.throws(()=>resolveOrchestrator([worker(6,'Orchestrator','custom')]),errorCode('orchestrator_name_collision'));
  assert.throws(()=>resolveOrchestrator([...bots,worker(5,'Second Root','orchestrator')]),errorCode('ambiguous_orchestrator'));
  assert.throws(()=>resolveOrchestrator([worker(5,'Orchestrator','orchestrator',31)]),errorCode('orchestrator_has_parent'));
});

test('Discovery and setup plan are honest about the unconfigured Hermes/Lumos bridge and preserve nonnull parents',()=>{
  const empty=orchestratorStatus([]);assert.equal(empty.configured,false);assert.equal(empty.setupRequired,true);assert.equal(empty.bridge.connected,false);assert.equal(empty.taskEndpoint,'/api/orchestrator/tasks');
  const status=orchestratorStatus(roster());assert.equal(status.configured,true);assert.equal(status.orchestrator.id,207);assert.equal(status.bridge.status,'not_configured');assert.deepEqual(status.bridge.contacts,['hermes','lumos']);
  const plan=planOrchestratorSetup(roster());assert.equal(plan.create,false);assert.deepEqual(plan.attach.map(bot=>bot.id),[31,72]);assert.deepEqual(plan.preserveParents.map(bot=>[bot.id,bot.parent_bot_id]),[[83,72],[96,31]]);
});

test('Task destination defaults only when selectors are omitted and refuses ambiguous or conflicting selectors',()=>{
  const bots=roster();assert.equal(resolveTaskWorker({},bots).id,207);assert.equal(resolveTaskWorker({worker:' builder '},bots).id,31);assert.equal(resolveTaskWorker({botId:'31',worker:'Builder'},bots).id,31);
  assert.equal(resolveTaskWorker({botId:31},bots.filter(bot=>bot.id!==207)).id,31);
  assert.throws(()=>resolveTaskWorker({botId:31,worker:'GitHub'},bots),errorCode('conflicting_worker_selectors'));
  assert.throws(()=>resolveTaskWorker({worker:'Builder'},[...bots,worker(400,'builder','custom')]),errorCode('ambiguous_worker'));
  for(const body of [{botId:null},{botId:''},{botId:0},{botId:true},{botId:'031'},{worker:null},{worker:''},{worker:31}])assert.throws(()=>resolveTaskWorker(body,bots),error=>error.statusCode===400);
  assert.throws(()=>resolveTaskWorker({botId:999},bots),error=>error.statusCode===404);assert.throws(()=>resolveTaskWorker({botId:31},bots,{orchestratorOnly:true}),errorCode('orchestrator_redirect_rejected'));
});

test('Canonical submission preserves Hermes/Lumos task correlation and exact supplied context/files',t=>{
  const f=taskFixture(t),context={intent:'Keep task details',nested:{sourceId:'original-8'}},files=['F:\\fixture data\\input.txt'];
  const result=f.submit({requestId:'lumos-source-1',task:'Coordinate fixture work',source:'lumos',context,files},{orchestratorOnly:true});
  assert.equal(result.status,202);assert.equal(result.body.botId,207);const run=f.q('SELECT * FROM runs').get();assert.equal(run.bot_id,207);assert.equal(run.thread,'bot:207');assert.equal(run.source,'lumos');assert.equal(run.origin_request_id,'lumos-source-1');assert.equal(run.prompt,'Coordinate fixture work\nContext:\n'+JSON.stringify(context)+'\nHost files:\n'+files[0]);
  assert.throws(()=>f.submit({task:'redirect',thread:'bot:31'},{orchestratorOnly:true}),errorCode('orchestrator_thread_redirect_rejected'));
  assert.throws(()=>f.submit({task:'wrong source',source:'unconfigured-service'}),error=>error.statusCode===400);
});

test('Generic and canonical routes share durable idempotency and reject changed task/source/worker',t=>{
  const f=taskFixture(t),body={requestId:'same-source-request',task:'Coordinate a task',context:'Keep me',files:[]};
  const first=f.submit(body,{orchestratorOnly:true}),replay=f.submit(body);assert.equal(replay.status,200);assert.equal(replay.body.replayed,true);assert.equal(replay.body.runId,first.body.runId);assert.equal(replay.body.id,first.body.runId);assert.equal(f.captured.length,1);
  for(const delta of [{task:'Different task'},{source:'hermes'},{botId:31}])assert.throws(()=>f.submit({...body,...delta}),errorCode('request_id_conflict'));
  assert.equal(f.q('SELECT COUNT(*) n FROM runs').get().n,1);assert.equal(f.db.isTransaction,false);
});

test('Existing API request fingerprints replay unchanged after coordinator routing upgrade',t=>{
  const f=taskFixture(t),task={botId:31,thread:'bot:31',task:'Legacy worker task',context:'Legacy context',files:['F:\\legacy.txt']};
  const id=f.options.runTask({...task,prompt:'Legacy saved prompt',source:'api',originRequestId:'legacy-request'}),fingerprint=createHash('sha256').update(JSON.stringify(task)).digest('hex');f.q('INSERT INTO task_requests VALUES(?,?,?)').run('legacy-request',fingerprint,id);
  const result=f.submit({requestId:'legacy-request',botId:31,task:task.task,context:task.context,files:task.files});assert.equal(result.status,200);assert.equal(result.body.runId,id);assert.equal(f.captured.length,1);
});

test('Submission errors roll back database writes and leave no request-key reservation',t=>{
  const f=taskFixture(t),submit=createTaskSubmission({...f.options,runTask:args=>{f.options.runTask(args);throw new Error('Fixture runner failed');}});
  assert.throws(()=>submit({requestId:'retry-after-failure',task:'Fixture'}),/Fixture runner failed/);assert.equal(f.q('SELECT COUNT(*) n FROM runs').get().n,0);assert.equal(f.q('SELECT COUNT(*) n FROM task_requests').get().n,0);assert.equal(f.db.isTransaction,false);
  assert.equal(f.submit({requestId:'retry-after-failure',task:'Fixture'}).status,202);
});

test('Missing default coordinator blocks generic routing while explicit specialists remain available',t=>{
  const f=taskFixture(t,roster().filter(bot=>bot.id!==207));assert.throws(()=>f.submit({task:'Need coordinator'}),error=>error.statusCode===404);assert.equal(f.submit({task:'Direct work',worker:'Builder',source:'hermes'}).body.botId,31);assert.equal(f.captured[0].source,'hermes');
});

test('Setup dry run only reads live state; invalid hierarchy or active workers cause zero mutations',async t=>{
  const f=setupFixture(t),result=await setupOrchestrator({api:f.api});assert.equal(result.apply,false);assert.equal(result.plan.create,true);assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(fs.existsSync(f.receipt),false);
  for(const bots of [[worker(7,'Orchestrator','custom')],[worker(7,'Orchestrator','orchestrator',31)],[worker(7,'Orchestrator','orchestrator'),worker(9,'Other root','orchestrator')]]){
    const g=setupFixture(t,{bots});await assert.rejects(setupOrchestrator({api:g.api,apply:true,receiptFile:g.receipt}),error=>error.statusCode===409);assert.ok(g.calls.every(call=>call.method==='GET'));assert.equal(fs.existsSync(g.receipt),false);
  }
  const busy=setupFixture(t,{active:1});await assert.rejects(setupOrchestrator({api:busy.api,apply:true,receiptFile:busy.receipt}),errorCode('workers_active'));assert.ok(busy.calls.every(call=>call.method==='GET'));
});

test('Setup creates one root, attaches only parentless workers and verifies existing settings/history',async t=>{
  const f=setupFixture(t),before=clone(f.state),result=await setupOrchestrator({api:f.api,apply:true,receiptFile:f.receipt});assert.equal(result.verified,true);assert.equal(result.created,true);assert.equal(result.attached,2);assert.equal(result.orchestrator.id,207);assert.equal(result.bridge.connected,false);
  assert.deepEqual(f.state.bots.map(bot=>[bot.id,bot.parent_bot_id]),[[31,207],[72,207],[83,72],[96,31],[207,null]]);assert.deepEqual(f.state.history,before.history);
  for(const bot of before.bots){const observed=f.state.bots.find(item=>item.id===bot.id);assert.deepEqual({...observed,parent_bot_id:bot.parent_bot_id},bot);}
  const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.complete,true);assert.deepEqual(receipt.unexpectedChanges,[]);assert.deepEqual(receipt.before,before.bots);assert.equal(receipt.operations.filter(item=>item.kind==='refresh_standing_roster').length,5);
  const second=await setupOrchestrator({api:f.api,apply:true,receiptFile:path.join(f.temp,'second.json')});assert.equal(second.created,false);assert.equal(second.attached,0);assert.equal(f.calls.filter(call=>call.route==='/api/templates/orchestrator/add').length,1);
});

test('Guarded setup preserves a parent assigned concurrently and retains its exact skipped evidence',async t=>{
  const f=setupFixture(t,{raceId:31}),result=await setupOrchestrator({api:f.api,apply:true,receiptFile:f.receipt});assert.equal(result.verified,true);assert.equal(result.attached,1);assert.equal(result.skipped,1);assert.equal(f.state.bots.find(bot=>bot.id===31).parent_bot_id,96);
  const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.skipped[0].id,31);assert.equal(receipt.skipped[0].parent_bot_id,96);assert.match(receipt.skipped[0].reason,/concurrent link preserved/);assert.equal(receipt.operations.find(item=>item.kind==='attach_parentless_worker').status,'error');
});

test('Setup records unexpected concurrent settings changes without overwriting them or claiming success',async t=>{
  const f=setupFixture(t),api=async(route,method,body)=>{const result=await f.api(route,method,body);if(route==='/api/templates/orchestrator/add')f.state.bots[0].instructions='Concurrent owner edit';return result;};
  await assert.rejects(setupOrchestrator({api,apply:true,receiptFile:f.receipt}),/unexpected changes/);assert.equal(f.state.bots[0].instructions,'Concurrent owner edit');const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.complete,false);assert.ok(receipt.unexpectedChanges.some(change=>change.id===31&&change.field==='instructions'));assert.match(receipt.error,/unexpected changes/);
});
