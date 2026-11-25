import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('context fixture preserves real queue ownership while orphan reconciliation remains active',async t=>{
 const {api,bots,database,seedOwnedRun,reconcileFixture}=await sidebarFixture(t,{ownedContext:true});
 const thread='bot:'+bots.root.id;
 const owned=await seedOwnedRun(bots.root.id,thread,'waiting_cloud');
 const orphan=database(db=>Number(db.prepare("INSERT INTO runs(bot_id,thread,prompt,status,source) VALUES(?,?,?,'waiting_cloud','user')").run(bots.root.id,thread,'orphan').lastInsertRowid));
 await reconcileFixture();
 assert.equal(database(db=>db.prepare('SELECT status FROM runs WHERE id=?').get(orphan).status),'interrupted');
 assert.equal(database(db=>db.prepare("SELECT count(*) n FROM task_events WHERE run_id=? AND type='task.orphan_reconciled'").get(orphan).n),1);
 for(let i=0;i<3;i++)assert.deepEqual(await reconcileFixture(),[]);
 assert.equal(database(db=>db.prepare('SELECT status FROM runs WHERE id=?').get(owned).status),'waiting_cloud');
 const route='/api/threads/'+encodeURIComponent(thread)+'/messages';
 const request={text:'Preserve current task',requestId:'owned-regression'};
 assert.equal((await api(route,'POST',request)).status,200);
 assert.equal((await api(route,'POST',request)).value.replayed,true);
 assert.deepEqual(await reconcileFixture(),[]);
 database(db=>{
   assert.equal(db.prepare('SELECT count(*) n FROM runs').get().n,2);
   assert.equal(db.prepare('SELECT count(*) n FROM run_context WHERE run_id=?').get(owned).n,1);
   assert.equal(db.prepare('SELECT count(*) n FROM run_context WHERE run_id=?').get(orphan).n,0);
   assert.equal(db.prepare('SELECT status FROM runs WHERE id=?').get(owned).status,'waiting_cloud');
 });
});
