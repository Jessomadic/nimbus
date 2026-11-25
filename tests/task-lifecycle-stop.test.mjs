import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-lifecycle-stop-'));process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({local:{enabled:false}}));
const {q,db}=await import('../db.js'),{stopRun,projectContinuation,drainRuntime}=await import('../runner.js');
const bot=Number(q("INSERT INTO bots(name,model) VALUES('stop fixture','luna')").run().lastInsertRowid);
const row=status=>Number(q('INSERT INTO runs(bot_id,thread,prompt,status) VALUES(?,?,?,?)').run(bot,'fixture','fixture',status).lastInsertRowid);
test('controller-less running stop preserves the durable row and unlimited continuation',()=>{
 const id=row('running');q('INSERT INTO project_continuations(run_id,project,checkpoint_ref,remaining,expires,stopped) VALUES(?,?,?,?,?,0)').run(id,'fixture','checkpoint.md',-1,0);
 const before=q('SELECT * FROM runs WHERE id=?').get(id);assert.deepEqual(stopRun(id),{changed:false,reasonCode:'reconciliation_required'});assert.deepEqual(q('SELECT * FROM runs WHERE id=?').get(id),before);assert.equal(projectContinuation.get(id).stopped,0);
});
test('safe inactive, protected terminal and absent outcomes are distinct',()=>{
 const paused=row('paused');assert.deepEqual(stopRun(paused),{changed:true,reasonCode:'stopped'});assert.equal(q('SELECT status FROM runs WHERE id=?').get(paused).status,'stopped');
 for(const status of ['done','error','stopped','needs_review']){const id=row(status),before=q('SELECT * FROM runs WHERE id=?').get(id);assert.deepEqual(stopRun(id),{changed:false,reasonCode:'already_terminal'});assert.deepEqual(q('SELECT * FROM runs WHERE id=?').get(id),before);}
 assert.deepEqual(stopRun(2147483647),{changed:false,reasonCode:'not_found'});
});
test.after(async()=>{await drainRuntime();db.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^nimbus-lifecycle-stop-/);fs.rmSync(root,{recursive:true,force:true});});
