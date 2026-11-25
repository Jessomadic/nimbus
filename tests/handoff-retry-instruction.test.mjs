import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {ToolDevelopment} from '../runtime/tool-development.js';
test('automatic repair findings do not replace retained explicit retry instruction',()=>{
 const db=new DatabaseSync(':memory:');try{
 db.exec('CREATE TABLE tool_development_retries(request_id TEXT,attempt INTEGER,reason TEXT,previous_request_json TEXT)');
 const insert=db.prepare('INSERT INTO tool_development_retries VALUES(?,?,?,?)');
 insert.run('r',1,'Finish boot + diagnostic wiring; do not merely refine helper guards.',JSON.stringify({error_metadata:JSON.stringify({code:'stage_failed'})}));
 insert.run('r',2,'Automatic QA repair: missing boot hook.',JSON.stringify({error_metadata:JSON.stringify({code:'automatic_repair'})}));
 const before=db.prepare('SELECT * FROM tool_development_retries').all();
 const context={query:sql=>db.prepare(sql)};
 assert.match(ToolDevelopment.prototype._originalRetryInstruction.call(context,'r'),/Finish boot \+ diagnostic/);
 insert.run('r',3,'New explicit host instruction',JSON.stringify({error_metadata:JSON.stringify({code:'needs_review'})}));
 assert.equal(ToolDevelopment.prototype._originalRetryInstruction.call(context,'r'),'New explicit host instruction');
 assert.deepEqual(db.prepare('SELECT * FROM tool_development_retries WHERE attempt<3').all(),before);
 }finally{db.close();}
});
