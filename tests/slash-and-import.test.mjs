import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
const {isLocalSlash,runLocalSlash,contextBreakdown}=await import('../runtime/slash.js');
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

function fixture(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-slash-'));
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE bots (id INTEGER PRIMARY KEY,name TEXT,role TEXT,template TEXT,model TEXT,default_model TEXT,effort TEXT); CREATE TABLE worker_history (bot_id INTEGER,thread TEXT,messages TEXT); CREATE TABLE runs (id INTEGER PRIMARY KEY,bot_id INTEGER,thread TEXT,status TEXT)");
  db.prepare("INSERT INTO bots VALUES (1,'Builder','Implements software changes and verifies working behavior','builder','auto','sol','medium')").run();
  fs.mkdirSync(path.join(dir,'bots','1'),{recursive:true});fs.writeFileSync(path.join(dir,'bots','1','AGENTS.md'),'x'.repeat(400));fs.writeFileSync(path.join(dir,'bots','1','MEMORY.md'),'m'.repeat(100));
  db.prepare('INSERT INTO worker_history VALUES (1,?,?)').run('bot:1',JSON.stringify([{role:'user',content:'u'.repeat(50)},{role:'assistant',content:'a'.repeat(30)},{role:'tool',content:'t'.repeat(20)}]));
  const query=sql=>db.prepare(sql);
  const bot=()=>query('SELECT * FROM bots WHERE id=1').get();
  const ctx=(extra={})=>({query,bot:bot(),thread:'bot:1',dataDir:dir,settings:{maxHistoryChars:1000},stopRun:()=>{},
    providerStatus:async()=>({openai:{ok:true,subscription:true,plan:'pro',tiers:['luna','terra','sol','astra']},claude:{ok:true,enabled:true,mode:'token',plan:'max',allowedTiers:['claude-haiku','claude-sonnet','claude-opus','claude-fable']}}),...extra});
  return {db,query,bot,ctx,dir};
}

test('local slash commands change worker settings and report status without a model turn',async()=>{
  const f=fixture();
  assert.ok(isLocalSlash('/model claude-opus'));assert.ok(!isLocalSlash('/compact'));assert.ok(!isLocalSlash('please /model'));
  assert.match(await runLocalSlash('/model claude-opus',f.ctx()),/Claude subscription/);assert.equal(f.bot().model,'claude-opus');
  await assert.rejects(runLocalSlash('/model gpt-9',f.ctx()),e=>e.statusCode===400);
  assert.match(await runLocalSlash('/effort xhigh',f.ctx()),/xhigh/);assert.equal(f.bot().effort,'xhigh');
  const providers=await runLocalSlash('/providers',f.ctx());
  assert.match(providers,/engineering/);assert.match(providers,/claude-opus → sol/);
  const usage=await runLocalSlash('/usage',f.ctx());assert.match(usage,/OpenAI: connected \(pro\)/);assert.match(usage,/Claude: connected \(saved token, max\)/);
  const context=await runLocalSlash('/context',f.ctx());assert.match(context,/Context 60% of 1,000/);assert.match(context,/Tool results: 20 chars/);
  assert.deepEqual(contextBreakdown({query:f.query,botId:1,thread:'bot:1',dataDir:f.dir,settings:{maxHistoryChars:1000}}).parts,{instructions:400,memory:100,user:50,assistant:30,tool:20});
  f.db.prepare("INSERT INTO runs VALUES (7,1,'bot:1','running')").run();const stopped=[];
  assert.match(await runLocalSlash('/stop',f.ctx({stopRun:id=>stopped.push(id)})),/#7/);assert.deepEqual(stopped,[7]);
  assert.match(await runLocalSlash('/rename Ada',f.ctx()),/Ada/);assert.equal(f.bot().name,'Ada');
});

test('Codex import is a dry run by default, redacts secrets, and never overwrites a changed file',()=>{
  const codex=fs.mkdtempSync(path.join(os.tmpdir(),'codex-home-')),data=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-data-'));
  fs.writeFileSync(path.join(codex,'AGENTS.md'),'Ask questions rather than guess');
  fs.mkdirSync(path.join(codex,'memories','rollout_summaries'),{recursive:true});
  fs.writeFileSync(path.join(codex,'memories','memory_summary.md'),'token ghp_'+'A'.repeat(36)+' here');
  fs.writeFileSync(path.join(codex,'memories','rollout_summaries','one.md'),'summary');
  fs.mkdirSync(path.join(codex,'memories','skills','my-skill'),{recursive:true});fs.writeFileSync(path.join(codex,'memories','skills','my-skill','SKILL.md'),'---\nname: my-skill\n---\nDo it');
  fs.mkdirSync(path.join(codex,'skills','.system','imagegen'),{recursive:true});fs.writeFileSync(path.join(codex,'skills','.system','imagegen','SKILL.md'),'x');
  const run=(...args)=>JSON.parse(execFileSync(process.execPath,['--no-warnings',path.join(ROOT,'bin','import-codex.mjs'),'--codex-home',codex,...args],{env:{...process.env,NIMBUS_DATA:data},encoding:'utf8'}).split('\nDry run')[0]);
  const dry=run();assert.equal(dry.mode,'dry-run');assert.equal(dry.wouldWrite,4);assert.ok(!fs.existsSync(path.join(data,'shared')));
  assert.equal(dry.skipped.length,1);
  const applied=run('--apply');assert.equal(applied.written,4);assert.equal(applied.filesWithRedactions,1);
  assert.equal(fs.readFileSync(path.join(data,'shared','codex','AGENTS.md'),'utf8'),'Ask questions rather than guess');
  assert.doesNotMatch(fs.readFileSync(path.join(data,'shared','codex','memory_summary.md'),'utf8'),/ghp_A{36}/);
  assert.ok(fs.existsSync(path.join(data,'skills','my-skill','SKILL.md')));
  assert.equal(run('--apply').unchanged,4);
  fs.writeFileSync(path.join(data,'shared','codex','AGENTS.md'),'edited in Nimbus');
  const again=run('--apply');assert.deepEqual(again.conflicts,[path.join('shared','codex','AGENTS.md')]);
  assert.equal(fs.readFileSync(path.join(data,'shared','codex','AGENTS.md'),'utf8'),'edited in Nimbus');
});
