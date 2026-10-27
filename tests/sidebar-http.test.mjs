import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarFixture} from './helpers/sidebar-fixture.mjs';

test('sidebar API persists nested groups and atomic agent moves while retaining all execution state',async t=>{
  const {base,api,bots,database,snapshot}=await sidebarFixture(t),{root,builder,architect,github,sync}=bots;
  database(db=>{db.prepare("INSERT INTO runs(bot_id,thread,status,prompt,checkpoint) VALUES(?,?,'paused',?,?)").run(builder.id,'bot:'+builder.id,'Retained paused task',JSON.stringify({messages:[{role:'user',content:'Keep completed evidence'}],steps:4}));db.prepare('INSERT INTO worker_history(bot_id,thread,messages) VALUES(?,?,?)').run(builder.id,'bot:'+builder.id,JSON.stringify([{role:'assistant',content:'Retained conversation'}]));});
  const baseline=snapshot();
  const move=body=>api('/api/sidebar/move','POST',body),layout=async()=>(await api('/api/state')).value.sidebarLayout;
  await t.test('groups can nest, reorder, unnest and retain nested children',async()=>{
    assert.equal((await move({kind:'group',id:'github',parent:'engineering'})).status,200);
    assert.equal((await move({kind:'group',id:'quality',parent:'github'})).status,200);
    let saved=await layout();assert.equal(saved.groups.find(g=>g.id==='quality').parent,'github');
    assert.equal((await move({kind:'group',id:'engineering',parent:'research'})).status,200);
    saved=await layout();assert.equal(saved.groups.find(g=>g.id==='github').parent,'engineering');
    assert.equal((await move({kind:'group',id:'engineering',parent:null,before:'operations'})).status,200);
    assert.equal((await layout()).groups.find(g=>g.id==='engineering').parent,null);
    assert.deepEqual(snapshot(),baseline);
  });
  await t.test('cycle, unknown-group and stale-parent requests cannot alter layout',async()=>{
    const before=await layout();
    for(const body of [{kind:'group',id:'engineering',parent:'github'},{kind:'group',id:'github',parent:'github'},{kind:'group',id:'unknown',parent:null},{kind:'group',id:'research',parent:'orchestrator'}])assert.equal((await move(body)).status,400);
    assert.equal((await move({kind:'group',id:'github',parent:null,expectedParent:null})).status,409);
    assert.deepEqual(await layout(),before);
  });
  await t.test('moving a parent and its visible child is atomic display metadata only',async()=>{
    const result=await move({kind:'agents',ids:[github.id,sync.id],group:'operations',expectedGroup:'github',before:'bot:'+bots.operator.id,order:Object.values(bots).map(bot=>'bot:'+bot.id)});
    assert.equal(result.status,200);const state=(await api('/api/state')).value;
    for(const id of [github.id,sync.id])assert.equal(state.bots.find(bot=>bot.id===id).display_group,'operations');
    assert.equal(state.bots.find(bot=>bot.id===sync.id).parent_bot_id,github.id);
    assert.ok(state.sideOrder.indexOf('bot:'+github.id)<state.sideOrder.indexOf('bot:'+bots.operator.id));assert.deepEqual(snapshot(),baseline);
  });
  await t.test('invalid, stale, mixed and root-agent moves leave every agent and ordering unchanged',async()=>{
    const state=(await api('/api/state')).value;
    for(const body of [{ids:[root.id],group:'operations'},{ids:[builder.id,999999],group:'operations'},{ids:[builder.id,builder.id],group:'operations'},{ids:[builder.id],group:'rooms'},{ids:[builder.id],group:'engineering',before:'bot:'+github.id}])assert.equal((await move({kind:'agents',...body})).status,400);
    assert.equal((await move({kind:'agents',ids:[github.id,sync.id],group:'engineering',expectedGroup:'github'})).status,409);
    const after=(await api('/api/state')).value;assert.deepEqual(after.bots.map(bot=>[bot.id,bot.display_group]),state.bots.map(bot=>[bot.id,bot.display_group]));assert.deepEqual(after.sideOrder,state.sideOrder);assert.deepEqual(snapshot(),baseline);
  });
  await t.test('Other agents accepts moves and same-group reorder preserves unrelated entries',async()=>{
    assert.equal((await move({kind:'agents',ids:[builder.id],group:'',expectedGroup:'engineering'})).status,200);
    assert.equal((await move({kind:'agents',ids:[builder.id],group:'engineering',expectedGroup:'',before:'bot:'+architect.id})).status,200);
    const state=(await api('/api/state')).value;assert.ok(state.sideOrder.indexOf('bot:'+builder.id)<state.sideOrder.indexOf('bot:'+architect.id));assert.deepEqual(snapshot(),baseline);
  });
  await t.test('a database failure during a multi-agent move rolls back every row and the sidebar order',async()=>{
    const before=(await api('/api/state')).value;
    database(db=>db.exec(`CREATE TRIGGER reject_sidebar_fixture BEFORE UPDATE OF display_group ON bots WHEN NEW.id=${sync.id} AND NEW.display_group='research' BEGIN SELECT RAISE(ABORT,'Synthetic display move failure'); END;`));
    try{assert.equal((await move({kind:'agents',ids:[github.id,sync.id],group:'research',expectedGroup:'operations'})).status,400);}finally{database(db=>db.exec('DROP TRIGGER reject_sidebar_fixture'));}
    const after=(await api('/api/state')).value;assert.deepEqual(after.bots.map(bot=>[bot.id,bot.display_group]),before.bots.map(bot=>[bot.id,bot.display_group]));assert.deepEqual(after.sideOrder,before.sideOrder);assert.deepEqual(snapshot(),baseline);
  });
  await t.test('anonymous callers cannot change sidebar layout',async()=>{
    const response=await fetch(base+'/api/sidebar/move',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind:'group',id:'github',parent:null})});assert.equal(response.status,401);
  });
});
