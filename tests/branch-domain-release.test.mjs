import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import fs from 'node:fs';import path from 'node:path';
import {domainTables,captureDomains,installDomainFences,holdDomains} from '../runtime/branch-domains.js';
// Port of held-message relationship / persistent-v2 controls referenced in leader2009 reports.
// Every write targets this test-owned SQLite file; no runner, provider or production imports.
test('held message relation closure and persistent v2 fences across reopen',()=>{
const dir=fs.mkdtempSync(path.join(import.meta.dirname,'domain-owned-'));let db;
try{const file=path.join(dir,'fixture.sqlite');db=new DatabaseSync(file);
for(const t of domainTables)db.exec('CREATE TABLE '+t+'(id INTEGER PRIMARY KEY,run_id INTEGER,parent_run INTEGER,message_id INTEGER,prompt TEXT)');
db.exec("INSERT INTO runs(id) VALUES(1),(2),(3);INSERT INTO messages(id,run_id) VALUES(10,1),(20,3);INSERT INTO run_context(id,run_id,message_id) VALUES(1,2,10),(2,3,20)");
assert.deepEqual(captureDomains(db,1).runs,[1,2]);
db.exec("CREATE TRIGGER branch_domain_run_context_INSERT BEFORE INSERT ON run_context WHEN 0 BEGIN SELECT RAISE(ABORT,'legacy'); END");
installDomainFences(db);holdDomains(db,captureDomains(db,1),'fixture');
db.close();db=new DatabaseSync(file);installDomainFences(db);
const before=JSON.stringify(db.prepare('SELECT * FROM branch_host_domain_holds').all());
assert.throws(()=>db.exec('INSERT INTO run_context(run_id,message_id) VALUES(3,10)'),/protected_lifecycle_domain/);
assert.throws(()=>db.exec('UPDATE run_context SET message_id=10 WHERE id=2'),/protected_lifecycle_domain/);
assert.throws(()=>db.exec('UPDATE run_context SET message_id=20 WHERE id=1'),/protected_lifecycle_domain/);
assert.throws(()=>db.exec('DELETE FROM run_context WHERE id=1'),/protected_lifecycle_domain/);
db.exec("UPDATE run_context SET prompt='safe unrelated' WHERE id=2");
assert.equal(JSON.stringify(db.prepare('SELECT * FROM branch_host_domain_holds').all()),before);
}finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}});
