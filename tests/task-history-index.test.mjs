import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {execute,tools} from '../runtime/toolsets/operations.js';

function fixture(t){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,status TEXT,source TEXT,requested_model TEXT,actual_model TEXT,last_error TEXT,input_tokens INTEGER,output_tokens INTEGER,started_at INTEGER,ended_at INTEGER);
    CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,args TEXT,result TEXT,state TEXT);
    CREATE TABLE task_events(id INTEGER PRIMARY KEY,run_id INTEGER,type TEXT,body TEXT,created_at INTEGER);
    INSERT INTO runs(id,bot_id,status) VALUES(11,1,'paused'),(12,2,'done'),(13,1,'running');`);
  t.after(()=>db.close());
  const add=(id,run=11,state='done')=>db.prepare('INSERT INTO tool_calls VALUES(?,?,?,?,?,?)').run(id,run,'exec_command','{"secret":"DO_NOT_INCLUDE_ARGUMENTS"}','{"secret":"DO_NOT_INCLUDE_RESULTS"}',state);
  return{db,add,ctx:{botId:1,query:sql=>db.prepare(sql)}};
}
test('calls view is discoverable and validates its distinct index arguments',async t=>{
  const {ctx}=fixture(t),spec=tools.find(t=>t.function.name==='task_history').function;
  assert.deepEqual(spec.parameters.properties.view.enum,['events','calls']);
  await assert.rejects(execute('task_history',{view:'calls'},ctx),/requires runId/);
  await assert.rejects(execute('task_history',{view:'calls',runId:11,callId:'11:x'},ctx),/no callId/);
  await assert.rejects(execute('task_history',{view:'invalid',runId:11},ctx),/view must/);
  for(const input of [{offset:-1},{offset:0.5},{limit:0},{limit:51}])await assert.rejects(execute('task_history',{view:'calls',runId:11,...input},ctx),/integer/);
});
test('complete index pages independently of oversized or truncated event history',async t=>{
  const {ctx,db,add}=fixture(t),expected=[];
  for(let n=0;n<123;n++){const id='11:'+String(123-n).padStart(3,'0');add(id,11,n===17?'uncertain':'done');expected.push(id);}
  add('12:FOREIGN_SECRET',12);add('13:other-owned-run',13);
  for(let n=0;n<60;n++)db.prepare('INSERT INTO task_events(run_id,type,body) VALUES(?,?,?)').run(11,'large','{"text":"'+'H'.repeat(6000)+'"}');
  const seen=[];let offset=0,pages=0;
  do{const page=await execute('task_history',{runId:11,view:'calls',offset,limit:7},ctx);pages++;assert.equal(page.total,123);assert.equal(page.readOnly,true);assert.ok(page.actions.length<=7);assert.equal(page.hasMore,page.nextOffset!==null);assert.ok(!('events'in page));const raw=JSON.stringify(page);assert.ok(raw.length<2000);assert.doesNotMatch(raw,/DO_NOT_INCLUDE|FOREIGN_SECRET|other-owned-run|HHHH/);seen.push(...page.actions.map(a=>a.id));offset=page.nextOffset;}while(offset!==null);
  assert.equal(pages,18);assert.deepEqual(seen,expected);
  const indexed=await execute('task_history',{runId:11,view:'calls',offset:17,limit:1},ctx);assert.equal(indexed.actions[0].state,'uncertain');
  const exact=await execute('task_history',{runId:11,callId:expected[17],offset:0,maxChars:8000},ctx);assert.equal(JSON.parse(exact.text).arguments.secret,'DO_NOT_INCLUDE_ARGUMENTS');
  assert.equal(db.prepare('SELECT count(*) n FROM tool_calls').get().n,125);
});
test('index cannot cross worker ownership or expose an unknown run',async t=>{
  const {ctx,add}=fixture(t);add('12:PRIVATE',12);
  for(const runId of [12,999])await assert.rejects(execute('task_history',{runId,view:'calls'},ctx),/not owned/);
  await assert.rejects(execute('task_history',{callId:'12:PRIVATE'},ctx),/not owned/);
});
test('empty and beyond-end pages terminate without ambiguous offsets',async t=>{
  const {ctx,add}=fixture(t);
  const empty=await execute('task_history',{runId:11,view:'calls'},ctx);assert.deepEqual(empty.actions,[]);assert.equal(empty.total,0);assert.equal(empty.nextOffset,null);assert.equal(empty.hasMore,false);
  add('11:first');const end=await execute('task_history',{runId:11,view:'calls',offset:99},ctx);assert.deepEqual(end.actions,[]);assert.equal(end.total,1);assert.equal(end.nextOffset,null);
});
test('appended calls preserve prior pages and are retrievable exactly once',async t=>{
  const {ctx,add}=fixture(t);add('13:z',13);add('13:a',13);add('13:m',13);
  const first=await execute('task_history',{runId:13,view:'calls',limit:2},ctx);assert.deepEqual(first.actions.map(a=>a.id),['13:z','13:a']);assert.equal(first.nextOffset,2);
  add('13:0',13);const second=await execute('task_history',{runId:13,view:'calls',offset:first.nextOffset,limit:2},ctx);assert.deepEqual(second.actions.map(a=>a.id),['13:m','13:0']);assert.equal(second.total,4);assert.equal(second.nextOffset,null);
});
