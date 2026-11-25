import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {restartDrainStatus,restartDrainTick} from '../runtime/restart-drain.js';
test('running effects block independently of parent state and diagnostics contain counts only',()=>{
 const db=new DatabaseSync(':memory:');
 db.exec("CREATE TABLE runs(id INTEGER,status TEXT); CREATE TABLE tool_calls(state TEXT,args TEXT); INSERT INTO runs VALUES(631,'stopped'),(633,'done');");
 const queues=()=>({workers:{active:0,queued:0}}),terminals={active:()=>[]},read=()=>restartDrainStatus({q:s=>db.prepare(s),queues,terminals});
 assert.equal(read().ready,true);
 for(const state of ['running']){
 db.prepare('INSERT INTO tool_calls VALUES(?,?)').run(state,'SECRET');
 assert.equal(read().ready,false);assert.equal(read().counts.effects,1);
 assert.ok(!JSON.stringify(read()).includes('SECRET'));
 db.exec('DELETE FROM tool_calls');
 }
 for(const state of ['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input']){
 db.prepare('UPDATE runs SET status=? WHERE id=631').run(state);assert.equal(read().ready,false);
 }
 db.exec("UPDATE runs SET status='done'");assert.equal(read().ready,true);db.close();
});
test('final reread catches effects introduced by source check; failed source never restarts',()=>{
 let ready=true,starts=0,holds=0;
 const read=()=>({ready,counts:{effects:ready?0:1}});
 assert.equal(restartDrainTick({read,assertSource:()=>{ready=false;},restart:()=>starts++,hold:()=>holds++}),false);
 assert.equal(starts,0);assert.equal(holds,1);
 ready=true;assert.throws(()=>restartDrainTick({read,assertSource:()=>{throw Error('drift');},restart:()=>starts++,hold:()=>{}}),/drift/);
 assert.equal(starts,0);
});
test('real supervisor blocks live ownership then boots once with uncertainty retained',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-drain-supervisor-'));
 fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'runtime'));
 fs.copyFileSync(new URL('../scripts/supervisor.mjs',import.meta.url),path.join(root,'scripts/supervisor.mjs'));
 fs.copyFileSync(new URL('../runtime/restart-drain.js',import.meta.url),path.join(root,'runtime/restart-drain.js'));
 fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(root,'server.js'),`import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {restartDrainStatus,restartDrainTick} from './runtime/restart-drain.js';
 const db=new DatabaseSync('fixture.db');db.exec("CREATE TABLE IF NOT EXISTS runs(status TEXT);CREATE TABLE IF NOT EXISTS tool_calls(state TEXT);");
 const boot=fs.existsSync('boot')?Number(fs.readFileSync('boot'))+1:1;fs.writeFileSync('boot',String(boot));
 if(boot===1)db.exec("INSERT INTO tool_calls VALUES('uncertain');INSERT INTO runs VALUES('running')");
 if(boot===2)fs.writeFileSync('retained',JSON.stringify(db.prepare('SELECT * FROM tool_calls').all()));
 setInterval(()=>{if(boot>1)return;if(fs.existsSync('settle'))db.exec("UPDATE runs SET status='done'");restartDrainTick({read:()=>restartDrainStatus({q:s=>db.prepare(s),queues:()=>({workers:{active:0,queued:0}}),terminals:{active:()=>[]}}),assertSource:()=>{},hold:c=>fs.writeFileSync('hold',JSON.stringify(c)),restart:()=>{db.close();process.exit(75)}});},50);
 `);
 const child=spawn(process.execPath,['scripts/supervisor.mjs'],{cwd:root,env:{...process.env,NIMBUS_DATA:path.join(root,'data')},windowsHide:true,stdio:'ignore'});
 t.after(async()=>{try{const pid=Number(fs.readFileSync(path.join(root,'data/server.pid')));process.kill(pid);}catch{} child.kill();await new Promise(r=>setTimeout(r,300));fs.rmSync(root,{recursive:true,force:true});});
 const until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,50));}throw Error('fixture timeout');};
 await until(()=>fs.existsSync(path.join(root,'hold')));
 await new Promise(r=>setTimeout(r,700));assert.equal(fs.readFileSync(path.join(root,'boot'),'utf8'),'1');
 fs.writeFileSync(path.join(root,'settle'),'isolated ownership settlement only');
 await until(()=>fs.readFileSync(path.join(root,'boot'),'utf8')==='2');
 await new Promise(r=>setTimeout(r,400));assert.equal(fs.readFileSync(path.join(root,'boot'),'utf8'),'2');
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'retained'),'utf8')),[{state:'uncertain'}]);
});


test('retained ambiguity is byte-identical while live ownership and every drain dimension block',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-retained-journal-'));
 const file=path.join(root,'fixture.db');const db=new DatabaseSync(file);
 try {
 db.exec("CREATE TABLE runs(id INTEGER,status TEXT);CREATE TABLE tool_calls(id INTEGER,run_id INTEGER,state TEXT,args TEXT);INSERT INTO runs VALUES(1206,'needs_review');INSERT INTO tool_calls VALUES(1206,1206,'uncertain','SECRET');");
 const before=fs.readFileSync(file), row=JSON.stringify(db.prepare('SELECT * FROM tool_calls').all());
 let active=0,queued=0,terminal=[];
 const read=()=>restartDrainStatus({q:s=>db.prepare(s),queues:()=>({workers:{active,queued}}),terminals:{active:()=>terminal}});
 assert.equal(read().ready,true);
 // Read-only drain does not rewrite even one byte of retained journal storage.
 assert.deepEqual(fs.readFileSync(file),before);
 for(const state of ['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input']){
 db.prepare('UPDATE runs SET status=?').run(state);assert.equal(read().ready,false,state);assert.equal(read().counts.tasks,1);
 }
 db.exec("UPDATE runs SET status='needs_review'");
 active=1;assert.equal(read().ready,false);active=0;
 queued=1;assert.equal(read().ready,false);queued=0;
 terminal=[{id:'owned'}];assert.equal(read().ready,false);terminal=[];
 db.exec("INSERT INTO tool_calls VALUES(2,NULL,'running','SECRET')");
 assert.equal(read().ready,false);assert.equal(read().counts.effects,1);
 db.exec('DELETE FROM tool_calls WHERE id=2');
 assert.equal(read().ready,true);assert.equal(JSON.stringify(db.prepare('SELECT * FROM tool_calls').all()),row);
 assert.ok(!JSON.stringify(read()).includes('SECRET'));
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('ownership acquired between checks prevents restart for every ownership dimension',()=>{
 for(const dimension of ['tasks','activeWorkers','queuedWorkers','activeTerminals','effects']){
 let changed=false,starts=0,holds=0;
 const read=()=>{const counts={tasks:0,effects:0,activeWorkers:0,queuedWorkers:0,activeTerminals:0};if(changed)counts[dimension]=1;return {ready:!changed,counts};};
 assert.equal(restartDrainTick({read,assertSource:()=>{changed=true},restart:()=>starts++,hold:()=>holds++}),false);
 assert.equal(starts,0,dimension);assert.equal(holds,1,dimension);
 }
});
