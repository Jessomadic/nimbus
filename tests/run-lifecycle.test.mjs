import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {reconcileOrphanRuns} from '../runtime/run-lifecycle.js';

test('ownership reconciliation preserves live/queued work and exact journals while retiring only unowned status',()=>{
  const db=new DatabaseSync(':memory:'),query=sql=>db.prepare(sql);
  db.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,last_error TEXT,ended_at INTEGER,checkpoint TEXT); CREATE TABLE tool_calls(id TEXT,run_id INTEGER,state TEXT); CREATE TABLE events(run_id INTEGER,type TEXT,body TEXT);');
  const states=['queued','running','running','running','waiting_tool','paused','stopped','needs_review','waiting_approval','waiting_input'];
  states.forEach((status,index)=>query('INSERT INTO runs(id,status,checkpoint) VALUES(?,?,?)').run(index+1,status,'retained-'+index));
  query('INSERT INTO tool_calls VALUES(?,?,?)').run('completed',3,'done');query('INSERT INTO tool_calls VALUES(?,?,?)').run('unknown',4,'uncertain');
  const journal=query('SELECT * FROM tool_calls').all(),ownedRunIds=new Set([1,2]);
  const event=(id,type,data)=>query('INSERT INTO events VALUES(?,?,?)').run(id,type,JSON.stringify(data));
  const args={db,query,ownedRunIds,event};
  const repaired=reconcileOrphanRuns({...args,limit:1});assert.deepEqual(repaired.map(row=>row.id),[3]);
  assert.deepEqual(reconcileOrphanRuns(args).map(row=>[row.id,row.status]),[[4,'needs_review'],[9,'needs_review'],[10,'needs_review']]);
  assert.deepEqual(query('SELECT * FROM tool_calls').all(),journal);assert.deepEqual(query('SELECT status FROM runs ORDER BY id').all().map(row=>row.status),['queued','running','interrupted','needs_review','waiting_tool','paused','stopped','needs_review','needs_review','needs_review']);
  assert.deepEqual(query('SELECT checkpoint FROM runs ORDER BY id').all().map(row=>row.checkpoint),states.map((_,index)=>'retained-'+index));
  assert.equal(reconcileOrphanRuns(args).length,0);assert.equal(query('SELECT count(*) AS n FROM events').get().n,4);
  assert.throws(()=>reconcileOrphanRuns({...args,ownedRunIds:undefined}),/host ownership/);db.close();
});

test('failure to record the orphan audit rolls back the status update',()=>{
  const db=new DatabaseSync(':memory:'),query=sql=>db.prepare(sql);db.exec("CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,last_error TEXT,ended_at INTEGER);CREATE TABLE tool_calls(id TEXT,run_id INTEGER,state TEXT);INSERT INTO runs(id,status) VALUES(1,'running');");
  assert.throws(()=>reconcileOrphanRuns({db,query,ownedRunIds:new Set(),event:()=>{throw new Error('Audit unavailable');}}),/Audit unavailable/);
  assert.equal(query('SELECT status FROM runs').get().status,'running');db.close();
});
