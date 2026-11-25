import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-coordinator-pins-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
const {executeTool}=await import('../runtime/tools.js');
const {compileRequiredCompletion,completionAssignmentContext}=await import('../runtime/required-completion.js');
const {db}=await import('../db.js');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const owner={id:22,template:'orchestrator'};

test('coordinator can pin its shared checker through existing tools without a shell',async()=>{
 const input=await executeTool(owner,'shared_note',{key:'fixture/input.txt',content:'owned input\r\n\u00e9\ud83c\udf26\ufe0f'});
 const checker=await executeTool(owner,'shared_note',{key:'fixture/check.test.cjs',content:"require('node:test')('fixture',()=>{});\n"});
 for(const result of [input,checker]){
  const actual=fs.readFileSync(result.path);assert.equal(result.saved,true);assert.equal(result.bytes,actual.length);assert.equal(result.sha256,sha(actual));
 }
 const owned=path.join(root,'data/bots/4/artifacts'),outputRoot=path.join(owned,'finite'),output=path.join(outputRoot,'report.json');
 const descriptor={version:2,outputRoot,inputPins:[{path:input.path,sha256:input.sha256}],sourcePins:[{path:checker.path,sha256:checker.sha256}],outputs:[output],steps:[{id:'check',check:{args:{runner:'node_test',path:path.dirname(checker.path),files:[path.basename(checker.path)]},assertions:[{path:'pass',equals:true}]}}]};
 const contract=compileRequiredCompletion('execution',descriptor,owned);assert.equal(contract.sourcePins[0].sha256,checker.sha256);
 fs.appendFileSync(checker.path,'// changed after pin\n');assert.throws(()=>compileRequiredCompletion('execution',descriptor,owned),/Evidence pin mismatch/);
});

test('shared read hashes the complete bytes and distinguishes missing from empty',async()=>{
 const content='\u00e9'.repeat(100010)+'\ud83c\udf26\ufe0f';
 const written=await executeTool(owner,'shared_note',{key:'fixture/large.txt',content});
 const read=await executeTool(owner,'shared_note',{key:'fixture/large.txt'});
 assert.equal(read.content.length,100000);assert.equal(read.truncated,true);assert.equal(read.exists,true);
 assert.equal(read.sha256,written.sha256);assert.equal(read.sha256,sha(fs.readFileSync(read.path)));assert.equal(read.bytes,Buffer.byteLength(content));
 assert.notEqual(read.sha256,sha(Buffer.from(read.content)));
 const missing=await executeTool(owner,'shared_note',{key:'fixture/absent.txt'});assert.equal(missing.exists,false);assert.equal(missing.sha256,null);assert.equal(missing.content,'');
 await executeTool(owner,'shared_note',{key:'fixture/empty.txt',content:''});
 const empty=await executeTool(owner,'shared_note',{key:'fixture/empty.txt'});assert.equal(empty.exists,true);assert.equal(empty.bytes,0);assert.equal(empty.sha256,sha(Buffer.alloc(0)));assert.equal(empty.truncated,false);
 await assert.rejects(executeTool(owner,'shared_note',{key:'../outside.txt',content:'not allowed'}),/stay inside shared knowledge/);
});

test('private file write returns the hash of its UTF-8 bytes',async()=>{
 const content='first\r\n\u4e16\u754c\n',result=await executeTool({id:4},'write_file',{path:'artifacts/utf8.txt',content});
 assert.equal(result.path,path.join(root,'data/bots/4/artifacts/utf8.txt'));
 assert.equal(result.bytes,Buffer.byteLength(content));assert.equal(result.sha256,sha(fs.readFileSync(result.path)));assert.equal(fs.readFileSync(result.path,'utf8'),content);
});

test('completion prompt keeps v1 evidence and excludes unrelated caller fields',()=>{
 const pin={path:path.join(root,'pinned.txt'),sha256:'a'.repeat(64),authority:'not a grant'};
 const contract={version:1,outputRoot:root,inputPins:[pin],sourcePins:[pin],artifactPins:[pin],outputs:[pin.path],checks:[{args:{runner:'node_test',path:root,files:['check.test.cjs']},assertions:[{path:'pass',equals:true}]}],stepIds:['exact']};
 const prompt=completionAssignmentContext(contract);
 assert.ok(prompt.includes('"artifactPins"'));assert.ok(prompt.includes(pin.path.replaceAll('\\','\\\\')));assert.ok(prompt.includes('"id":"exact"'));
 assert.ok(!prompt.includes('not a grant'));assert.match(prompt,/not additional permissions/);assert.equal(completionAssignmentContext(undefined),'');
});

test.after(()=>{db.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^nimbus-coordinator-pins-/);fs.rmSync(root,{recursive:true,force:true});});
