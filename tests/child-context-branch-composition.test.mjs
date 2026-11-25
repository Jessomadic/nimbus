import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';
import {createChildContext} from '../runtime/child-context.js';
import {domainTables,installDomainFences,captureDomains,holdDomains,archiveDomainArtifacts,ensureChildContextSchema} from '../runtime/branch-domains.js';
function fixture(file=':memory:'){
 const db=new DatabaseSync(file);
 db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT);CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,parent_run INTEGER,depth INTEGER,thread TEXT,source TEXT,prompt TEXT,status TEXT,ended_at INTEGER,checkpoint TEXT,completion_required INTEGER,delegation_scope TEXT);
 CREATE TABLE approvals(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);CREATE TABLE tool_calls(id INTEGER PRIMARY KEY,run_id INTEGER,state TEXT);CREATE TABLE task_questions(id INTEGER PRIMARY KEY,run_id INTEGER,status TEXT);CREATE TABLE required_completion_bindings(run INTEGER,binding TEXT);
 INSERT INTO bots VALUES(22,'orchestrator'),(3,'reviewer');
 INSERT INTO runs VALUES(10,22,NULL,0,'bot:22','api','parent','running',NULL,'{"messages":[]}',0,'execution'),(11,3,10,1,'bot:3','Orchestrator','child','running',NULL,'{"messages":[]}',0,'execution'),(12,3,NULL,0,'bot:3','api','other','running',NULL,'{"messages":[]}',0,'execution');`);
 for(const t of domainTables.filter(t=>t!=='child_context'))if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t))db.exec('CREATE TABLE '+t+'(id INTEGER PRIMARY KEY,run_id INTEGER,parent_run INTEGER,message_id INTEGER,prompt TEXT)');
 return db;
}
const service=db=>createChildContext({db,owned:()=>true,protectedRun:()=>false,scope:()=>({fixture:true})});
const queue=s=>s.queue({runId:10,botId:22},{childRunId:11,text:'synthetic',requestId:'held-child'});
const hold=(db,id)=>holdDomains(db,captureDomains(db,id),'owned-fixture');
for(const id of [10,11])test('held '+id+' blocks queue (earlier held-child failure now green)',()=>{
 const db=fixture();try{const s=service(db);installDomainFences(db);hold(db,id);assert.throws(()=>queue(s),/protected|hold/);assert.equal(db.prepare('SELECT COUNT(*) n FROM child_context').get().n,0);}finally{db.close();}
});
for(const id of [10,11])test('late held '+id+' blocks consume without checkpoint or cursor mutation',()=>{
 const db=fixture();try{const s=service(db);queue(s);installDomainFences(db);hold(db,id);const state={messages:[]},before=JSON.stringify(db.prepare('SELECT * FROM runs').all());assert.throws(()=>s.consume(11,state),/protected|hold/);assert.deepEqual(state,{messages:[]});assert.equal(JSON.stringify(db.prepare('SELECT * FROM runs').all()),before);}finally{db.close();}
});
for(const id of [10,11])test('persistent branch hold '+id+' blocks queue and late consume',()=>{
 const db=fixture();try{const s=service(db);queue(s);db.prepare('INSERT INTO branch_host_holds VALUES(?,?)').run(id,'fixture');assert.throws(()=>queue(s),/protected|hold/);assert.throws(()=>s.consume(11,{messages:[]}),/protected|hold/);}finally{db.close();}
});
test('unheld queue replay and consume remain legitimate',()=>{const db=fixture();try{const s=service(db);assert.equal(queue(s).queued,true);assert.equal(queue(s).replayed,true);const state={messages:[]};assert.equal(s.consume(11,state).length,1);assert.equal(s.consume(11,state).length,0);assert.equal(state.messages.length,1);}finally{db.close();}});
test('closure captures both context endpoints and archive metadata',()=>{
 const db=fixture(),dir=fs.mkdtempSync(path.join(process.env.TMP,'archive-'));try{const s=service(db);queue(s);db.exec('ALTER TABLE child_context ADD COLUMN artifact_path TEXT');const file=path.join(dir,'owned.txt');fs.writeFileSync(file,'synthetic');db.prepare('UPDATE child_context SET artifact_path=?').run('owned.txt');const domain=captureDomains(db,11);assert.deepEqual(domain.runs,[10,11]);assert.equal(domain.relations.child_context.length,1);assert.equal(archiveDomainArtifacts(domain,dir)[0].bytes,9);}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('direct SQL INSERT UPDATE DELETE fence both OLD and NEW endpoints; unrelated writes succeed',()=>{
 const db=fixture();try{const s=service(db);queue(s);db.exec("INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(12,12,'unrelated','f','t','safe')");hold(db,11);
 for(const sql of ["INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(12,11,'x','f','t','p')","INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(10,12,'x','f','t','p')","UPDATE child_context SET child_run=11 WHERE parent_run=12","UPDATE child_context SET parent_run=10 WHERE parent_run=12","UPDATE child_context SET parent_run=12,child_run=12 WHERE parent_run=10","DELETE FROM child_context WHERE parent_run=10"])assert.throws(()=>db.exec(sql),/protected_lifecycle_domain/);
 db.exec("UPDATE child_context SET prompt='ok' WHERE parent_run=12;DELETE FROM child_context WHERE parent_run=12;INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(12,12,'allowed','f','t','p')");}finally{db.close();}
});
test('pre-child-context v2 fixture reopen installs fences without rewriting historical rows or approvals',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMP,'reopen-')),file=path.join(dir,'fixture.sqlite');let db=fixture(file);
 try{db.exec(`CREATE TABLE branch_host_domain_holds(kind TEXT,domain_key TEXT,preparation_id TEXT,PRIMARY KEY(kind,domain_key));INSERT INTO branch_host_domain_holds VALUES('run','11','old-v2');CREATE TABLE branch_host_preparations(id TEXT,snapshot TEXT);INSERT INTO branch_host_preparations VALUES('old','immutable-v2-snapshot');INSERT INTO required_completion_bindings VALUES(11,'immutable-binding');CREATE TRIGGER branch_domain_v2_runs_UPDATE BEFORE UPDATE ON runs WHEN OLD.id=11 BEGIN SELECT RAISE(ABORT,'protected_lifecycle_domain'); END;`);
 const before={holds:db.prepare('SELECT * FROM branch_host_domain_holds').all(),snap:db.prepare('SELECT * FROM branch_host_preparations').all(),bindings:db.prepare('SELECT * FROM required_completion_bindings').all(),trigger:db.prepare("SELECT sql FROM sqlite_master WHERE name='branch_domain_v2_runs_UPDATE'").get()};
 db.close();db=new DatabaseSync(file);const s=service(db);assert.throws(()=>queue(s),/protected/);assert.throws(()=>db.exec("INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(10,11,'x','f','t','p')"),/protected/);
 ensureChildContextSchema(db);assert.deepEqual({holds:db.prepare('SELECT * FROM branch_host_domain_holds').all(),snap:db.prepare('SELECT * FROM branch_host_preparations').all(),bindings:db.prepare('SELECT * FROM required_completion_bindings').all(),trigger:db.prepare("SELECT sql FROM sqlite_master WHERE name='branch_domain_v2_runs_UPDATE'").get()},before);
 db.exec("UPDATE runs SET prompt='unrelated' WHERE id=12");assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'branch_domain_v3_child_context_%'").get().n,3);
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('runner callback uses persistent branch guard for each service run',()=>{const text=fs.readFileSync(new URL('../runner.js',import.meta.url),'utf8');assert.match(text,/protectedRun:id=>[^\n]*branchDispatchHeld\(db,id\)/);});

for(const held of [1,2,4])test('SQL branch holds fence either endpoint including ancestor '+held,()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY,parent_run INTEGER);INSERT INTO runs VALUES(1,4),(2,1),(3,NULL),(4,NULL)');
 ensureChildContextSchema(db);
 db.exec("INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(1,2,'old','f','t','p'),(3,3,'safe','f','t','p')");
 db.prepare('INSERT INTO branch_host_holds VALUES(?,?)').run(held,'fixture');
 const statements=["INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(3,2,'new','f','t','p')","UPDATE child_context SET child_run=2 WHERE parent_run=3","UPDATE child_context SET parent_run=3,child_run=3 WHERE parent_run=1","DELETE FROM child_context WHERE parent_run=1"];
 for(const sql of statements)assert.throws(()=>db.exec(sql),/protected_lifecycle_domain/);
 db.exec("UPDATE child_context SET prompt='legitimate' WHERE parent_run=3;DELETE FROM child_context WHERE parent_run=3");
 db.close();
 const reopened=new DatabaseSync(':memory:');reopened.close();
 }finally{try{db.close();}catch{}}
});

test('context SQL fences survive reopen before any service initialization',()=>{
 const dir=fs.mkdtempSync(path.join(process.env.TMP,'persistent-'));const file=path.join(dir,'owned.sqlite');let db=new DatabaseSync(file);
 try{
 db.exec('CREATE TABLE runs(id INTEGER PRIMARY KEY,parent_run INTEGER);INSERT INTO runs VALUES(1,NULL),(2,1),(3,NULL)');
 ensureChildContextSchema(db);
 db.exec("INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(1,2,'one','f','t','p');INSERT INTO branch_host_domain_holds VALUES('run','2','old')");
 db.close();db=new DatabaseSync(file);
 for(const sql of ["INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(3,2,'two','f','t','p')","UPDATE child_context SET prompt='blocked' WHERE id=1","DELETE FROM child_context WHERE id=1"])assert.throws(()=>db.exec(sql),/protected_lifecycle_domain/);
 db.exec("INSERT INTO child_context(parent_run,child_run,request_key,fingerprint,target,prompt) VALUES(3,3,'ok','f','t','p')");
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

