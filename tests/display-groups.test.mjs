import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {capture} from '../runtime/process.js';
import {DISPLAY_GROUPS,defaultDisplayGroup,validateDisplayGroup} from '../public/agent-groups.js';

const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const expected={
  architect:'engineering',builder:'engineering','frontend-designer':'engineering',
  reviewer:'quality','qa-engineer':'quality','security-reviewer':'quality',
  researcher:'research','data-analyst':'research','knowledge-curator':'research','technical-writer':'research',
  'windows-operator':'operations','automation-engineer':'operations','browser-operator':'operations','office-assistant':'operations',
  'github-coordinator':'github','github-sync':'github','github-commits':'github','github-push':'github','github-pull-requests':'github','github-actions':'github',
};
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture(t,{existingGroupColumn=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-display-groups-')),data=path.join(root,'data');fs.mkdirSync(data);
  const file=path.join(data,'nimbus.db'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE bots(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,role TEXT,instructions TEXT,color TEXT,effort TEXT,model TEXT,
    approval_rules TEXT,allow_rules TEXT,created_at INTEGER,shape TEXT,template TEXT,computer INTEGER,runtime TEXT,default_model TEXT,parent_bot_id INTEGER,tools TEXT
    ${existingGroupColumn?",display_group TEXT DEFAULT ''":''}
  );
  CREATE TABLE rooms(id INTEGER PRIMARY KEY,name TEXT,goal TEXT,lead_bot_id INTEGER,bots_can_talk INTEGER);
  CREATE TABLE room_members(room_id INTEGER,bot_id INTEGER,PRIMARY KEY(room_id,bot_id));
  CREATE TABLE plugins(id TEXT PRIMARY KEY,secrets TEXT,installed_at INTEGER);
  CREATE TABLE bot_plugins(bot_id INTEGER,plugin_id TEXT,PRIMARY KEY(bot_id,plugin_id));
  CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,status TEXT,prompt TEXT,session_id TEXT,cost_usd REAL,effort TEXT,started_at INTEGER,ended_at INTEGER,parent_run INTEGER,checkpoint TEXT,requested_model TEXT,actual_model TEXT,route_reason TEXT,fallback_reason TEXT,backend TEXT,input_tokens INTEGER,output_tokens INTEGER,last_error TEXT,source TEXT,quiet INTEGER,depth INTEGER,origin_message_id INTEGER,origin_request_id TEXT);
  CREATE TABLE worker_history(bot_id INTEGER,thread TEXT,messages TEXT,updated_at INTEGER,PRIMARY KEY(bot_id,thread));`);
  let id=0;
  for(const template of [...Object.keys(expected),'custom-fixture']){
    id++;db.prepare('INSERT INTO bots(id,name,role,instructions,color,effort,model,approval_rules,allow_rules,created_at,shape,template,computer,runtime,default_model,parent_bot_id,tools) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id,'Fixture '+template,'Role '+template,'Retain user instructions '+id,'#123456','high','astra',JSON.stringify(['shell(*git push*)']),JSON.stringify(['shell(Get-*)']),123456+id,'blob',template,id%2,'auto','local',id===1?null:1,JSON.stringify(['read_file','write_file','ask_worker']));
  }
  db.exec("INSERT INTO rooms VALUES(7,'Retained room','Keep communication graph',1,1); INSERT INTO room_members VALUES(7,1); INSERT INTO room_members VALUES(7,2); INSERT INTO plugins VALUES('fixture','{}',123); INSERT INTO bot_plugins VALUES(2,'fixture');");
  db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(88,2,'bot:2','running','Retained active prompt','session-fixture',0,'high',100,null,55,JSON.stringify({messages:[{role:'user',content:'Do not replay completed work'}]}),'astra','fixture-model','explicit','none','codex',44,7,null,'user',0,1,9,'origin-fixture');
  db.prepare('INSERT INTO worker_history VALUES(?,?,?,?)').run(2,'bot:2',JSON.stringify([{role:'assistant',content:'Retained history'}]),3456);
  const before={bots:plain(db.prepare('SELECT * FROM bots ORDER BY id').all()),rooms:plain(db.prepare('SELECT * FROM rooms ORDER BY id').all()),members:plain(db.prepare('SELECT * FROM room_members ORDER BY room_id,bot_id').all()),plugins:plain(db.prepare('SELECT * FROM bot_plugins ORDER BY bot_id,plugin_id').all()),runs:plain(db.prepare('SELECT * FROM runs ORDER BY id').all()),history:plain(db.prepare('SELECT * FROM worker_history ORDER BY bot_id,thread').all())};db.close();
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-display-groups-/);fs.rmSync(root,{recursive:true,force:true});});
  return{root,data,file,before};
}
async function startup(f){
  const source=`import {db} from ${JSON.stringify(pathToFileURL(path.join(workspace,'db.js')).href)};\nconst result={bots:db.prepare('SELECT * FROM bots ORDER BY id').all(),rooms:db.prepare('SELECT * FROM rooms ORDER BY id').all(),members:db.prepare('SELECT * FROM room_members ORDER BY room_id,bot_id').all(),plugins:db.prepare('SELECT * FROM bot_plugins ORDER BY bot_id,plugin_id').all(),runs:db.prepare('SELECT * FROM runs ORDER BY id').all(),history:db.prepare('SELECT * FROM worker_history ORDER BY bot_id,thread').all(),column:db.prepare('PRAGMA table_info(bots)').all().find(c=>c.name==='display_group')};console.log(JSON.stringify(result));db.close();`;
  const env={...process.env,NIMBUS_DATA:f.data,NIMBUS_CONFIG:path.join(f.root,'config.json')};delete env.NODE_TEST_CONTEXT;
  return JSON.parse(await capture(process.execPath,['--no-warnings','--input-type=module','-e',source],{cwd:workspace,env,timeout:20000}));
}

test('canonical display group IDs/labels and profile defaults are exact and purely visual',()=>{
  assert.deepEqual(DISPLAY_GROUPS.map(group=>({...group})),[{id:'engineering',label:'Engineering'},{id:'quality',label:'Quality & Security'},{id:'research',label:'Research & Knowledge'},{id:'operations',label:'Operations'},{id:'github',label:'GitHub'},{id:'',label:'Other agents'}]);
  for(const [template,group]of Object.entries(expected))assert.equal(defaultDisplayGroup(template),group,template);
  assert.equal(defaultDisplayGroup('github-another-specialist'),'github');
  for(const unknown of ['',undefined,null,3,{},'custom','Builder','__proto__'])assert.equal(defaultDisplayGroup(unknown),'');
});
test('display group validation accepts only exact known string IDs without coercion',()=>{
  for(const {id}of DISPLAY_GROUPS)assert.equal(validateDisplayGroup(id),id);
  for(const invalid of [undefined,null,0,true,false,[],{},new String('engineering'),'Engineering',' engineering','engineering ','other','unknown','__proto__'])assert.throws(()=>validateDisplayGroup(invalid),/Invalid display group/);
});
test('first display column migration initializes defaults while preserving every runtime/communication value',async t=>{
  const f=fixture(t),after=await startup(f);
  assert.equal(after.column.type,'TEXT');assert.equal(after.column.dflt_value,"''");
  assert.deepEqual(after.bots.map(({display_group,...bot})=>bot),f.before.bots);
  for(const bot of after.bots)assert.equal(bot.display_group,expected[bot.template]||'');
  assert.deepEqual(after.rooms,f.before.rooms);assert.deepEqual(after.members,f.before.members);assert.deepEqual(after.plugins,f.before.plugins);assert.deepEqual(after.runs,f.before.runs);assert.deepEqual(after.history,f.before.history);
});
test('repeated startup preserves user-selected groups including explicit Other instead of reseeding',async t=>{
  const f=fixture(t);await startup(f);const db=new DatabaseSync(f.file);db.prepare('UPDATE bots SET display_group=? WHERE template=?').run('operations','builder');db.prepare('UPDATE bots SET display_group=? WHERE template=?').run('','github-coordinator');db.prepare('UPDATE bots SET display_group=? WHERE template=?').run('quality','custom-fixture');const chosen=plain(db.prepare('SELECT * FROM bots ORDER BY id').all());db.close();
  const again=await startup(f);assert.deepEqual(again.bots,chosen);assert.deepEqual((await startup(f)).bots,chosen);
});
test('a preexisting display column retains explicit metadata without any startup backfill',async t=>{
  const f=fixture(t,{existingGroupColumn:true}),db=new DatabaseSync(f.file);db.prepare('UPDATE bots SET display_group=? WHERE template=?').run('quality','builder');const chosen=plain(db.prepare('SELECT * FROM bots ORDER BY id').all());db.close();assert.deepEqual((await startup(f)).bots,chosen);
});
test('display migration is atomic: a failed backfill does not leave a partially added column or changed runtime state',async t=>{
  const f=fixture(t),db=new DatabaseSync(f.file);db.exec("CREATE TRIGGER reject_fixture_group BEFORE UPDATE ON bots WHEN NEW.template='builder' BEGIN SELECT RAISE(ABORT,'fixture group refusal'); END;");db.close();
  await assert.rejects(startup(f),/fixture group refusal/);const retained=new DatabaseSync(f.file);assert.equal(retained.prepare('PRAGMA table_info(bots)').all().some(column=>column.name==='display_group'),false);assert.deepEqual(plain(retained.prepare('SELECT * FROM bots ORDER BY id').all()),f.before.bots);retained.exec('DROP TRIGGER reject_fixture_group');retained.close();
  const recovered=await startup(f);assert.equal(recovered.bots.find(bot=>bot.template==='builder').display_group,'engineering');
});
