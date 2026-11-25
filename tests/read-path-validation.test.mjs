import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set both locations before any module that can initialize Nimbus's database.
const previous={data:process.env.NIMBUS_DATA,config:process.env.NIMBUS_CONFIG};
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-read-path-integration-'));
process.env.NIMBUS_DATA=path.join(fixture,'data');
process.env.NIMBUS_CONFIG=path.join(fixture,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{enabled:false},local:{enabled:false},mcpServers:{}}));
const {db,botDir,DATA_DIR}=await import('../db.js');
const {executeTool,connectors,terminals,browsers}=await import('../runtime/tools.js');
const {observeProgress}=await import('../runtime/progress-execution.js');
assert.equal(path.resolve(DATA_DIR),path.resolve(process.env.NIMBUS_DATA));
const worker={id:999999},directory=botDir(worker.id),read=args=>executeTool(worker,'read_file',args);
fs.writeFileSync(path.join(directory,'Unicode file.txt'),'A😀B retained evidence');

test('real executeTool rejects malformed read paths before filesystem access',async()=>{
  const methods=['statSync','openSync','readFileSync','mkdirSync'],original=new Map(methods.map(k=>[k,fs[k]]));
  try{
    for(const key of methods)fs[key]=()=>{throw Error('Unexpected filesystem operation '+key);};
    for(const args of [undefined,null,{},[],{path:undefined},{path:null},{path:''},{path:' \t\r\n '},{path:1},{path:false},{path:{}},{path:[]}]){
      const result=await read(args);assert.equal(result.code,'missing_path');assert.match(result.error,/exact absolute or workspace-relative file path/);
      assert.equal(Object.hasOwn(result,'content'),false);assert.equal(Object.hasOwn(result,'path'),false);
    }
  }finally{for(const [key,value] of original)fs[key]=value;}
});

test('real relative and absolute reads preserve Unicode, spaces and hash-bound pages',async()=>{
  const absolute=path.join(directory,'Unicode file.txt'),relative=await read({path:'Unicode file.txt'});
  assert.equal(relative.content,'A😀B retained evidence');assert.equal((await read({path:absolute})).sha256,relative.sha256);
  const first=await read({path:absolute,offset:0,limit:2});assert.equal(first.content,'A');assert.equal(first.nextOffset,1);
  assert.equal((await read({offset:first.nextOffset,limit:2,expectedSha256:first.sha256})).code,'missing_path');
  const second=await read({path:absolute,offset:first.nextOffset,limit:2,expectedSha256:first.sha256});assert.equal(second.content,'😀');
  fs.appendFileSync(absolute,' changed');assert.equal((await read({path:absolute,offset:second.nextOffset,limit:2,expectedSha256:first.sha256})).code,'file_changed');
  assert.equal((await read({path:directory})).code,'not_a_file');await assert.rejects(read({path:'nonexistent.txt'}),e=>e.code==='ENOENT');
});

test('actual malformed read results pause on the third identical observation across checkpoints',async()=>{
  let state={};const args={offset:0,limit:4000};
  for(let i=0;i<2;i++){observeProgress(state,'read_file',args,await read(args));state=JSON.parse(JSON.stringify(state));}
  const third=await read(args);assert.throws(()=>observeProgress(state,'read_file',args,third),e=>e.pause===true&&e.code==='no_progress');
  state=JSON.parse(JSON.stringify(state));assert.equal(state.noProgress,true);assert.equal(state.malformedReadStreak.count,3);assert.match(state.repairReason,/explicit valid file path/);
});

test('a real corrected read resets the streak without clearing a retained hold',async()=>{
  const state={};observeProgress(state,'read_file',{},await read({}));observeProgress(state,'read_file',{},await read({}));
  const corrected={path:'Unicode file.txt'};observeProgress(state,'read_file',corrected,await read(corrected));
  assert.equal(state.malformedReadStreak,undefined);assert.notEqual(state.noProgress,true);
  observeProgress(state,'read_file',{},await read({}));assert.equal(state.malformedReadStreak.count,1);
  state.noProgress=true;observeProgress(state,'read_file',corrected,await read(corrected));assert.equal(state.noProgress,true);
});

test('distinct malformed diagnostic requests do not impose an action cap',async()=>{
  const state={};for(let offset=0;offset<80;offset++){const args={offset,limit:4000};observeProgress(state,'read_file',args,await read(args));}
  assert.equal(state.malformedReadStreak.count,1);assert.notEqual(state.noProgress,true);
});

test.after(async()=>{
  await connectors.close();await browsers.close();await terminals.close();db.close();
  for(const [key,value] of [['NIMBUS_DATA',previous.data],['NIMBUS_CONFIG',previous.config]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  assert.equal(path.dirname(path.resolve(fixture)),path.resolve(os.tmpdir()));assert.match(path.basename(fixture),/^nimbus-read-path-integration-/);
  fs.rmSync(fixture,{recursive:true,force:true});
});
