import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {inspectCurrentReadback,hasCurrentReadback} from '../runtime/completion-readback.js';
import {inspectDelegatedCompletion,delegatedCompletionDecision} from '../runtime/delegated-completion.js';
import {readWorkerFile} from '../runtime/file-read.js';
import {encodeRedacted} from '../redact.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-readback-guidance-'));
const output=path.join(root,'report.json');
const content='x'.repeat(3999)+'😀'+'y'.repeat(7000);
fs.writeFileSync(output,content);
const sha256=createHash('sha256').update(content).digest('hex'),bytes=Buffer.byteLength(content);
const read=args=>({run_id:71,id:'71:read-'+args.offset,name:'read_file',state:'done',args:JSON.stringify(args),result:encodeRedacted(readWorkerFile(output,args))});
const page=offset=>read({path:output,offset,limit:4000,expectedSha256:sha256});
const inspect=(rows,lastCheck=-1)=>inspectCurrentReadback({rows,lastCheck,output,content,sha256,bytes});
const first=page(0),firstEnd=JSON.parse(first.result).nextOffset;
const second=page(firstEnd),secondEnd=JSON.parse(second.result).nextOffset;
const third=page(secondEnd);

test('missing readback yields an exact hash-bound first-page instruction',()=>{
 assert.deepEqual(inspect([]),{complete:false,coveredCharacters:0,totalCharacters:content.length,nextRead:{path:output,offset:0,limit:4000,expectedSha256:sha256}});
});
test('partial read continues at the actual Unicode-safe cursor, not offset zero',()=>{
 const r=inspect([first]);assert.equal(r.complete,false);assert.equal(r.coveredCharacters,firstEnd);assert.equal(r.nextRead.offset,firstEnd);assert.notEqual(firstEnd,4000);
 assert.equal(readWorkerFile(output,r.nextRead).sha256,sha256);
});
test('a repeated first page does not create progress or complete the output',()=>{
 assert.deepEqual(inspect([first,first]),inspect([first]));assert.equal(hasCurrentReadback({rows:[first,first],lastCheck:-1,output,content,sha256,bytes}),false);
});
test('out-of-order observations report the first real gap, then advance across retained pages',()=>{
 assert.equal(inspect([third,first]).nextRead.offset,firstEnd);
 const r=inspect([third,first,second]);assert.equal(r.complete,true);assert.equal(r.coveredCharacters,content.length);assert.equal(r.nextRead,null);
});
test('stale, truncated and incorrect content cannot advance the recovery cursor',()=>{
 for(const change of [{sha256:'0'.repeat(64)},{truncated:true},{content:'incorrect'},{bytes:bytes+1},{totalCharacters:content.length+1}]){
  const bad={...first,result:JSON.stringify({...JSON.parse(first.result),...change})};assert.equal(inspect([bad]).nextRead.offset,0);
 }
});
test('a new required check resets readback coverage',()=>{
 assert.equal(inspect([first,second],1).nextRead.offset,0);
 assert.equal(inspect([first,second],0).nextRead.offset,0);
});
test('full reads and the legacy exact-content API retain completion compatibility',()=>{
 const full=read({path:output});assert.equal(inspect([full]).complete,true);
 assert.equal(inspect([{...full,result:JSON.stringify({content})}]).complete,true);
});

const args={runner:'node_test',path:root,files:[path.join(root,'fake.test.mjs')]};
const contract={outputs:[output],checks:[{args,assertions:[{path:'pass',equals:true}]}]};
const binding={runId:71,parentRun:70,contract};
const run={id:71,parent_run:70,status:'running'};
const checked={run_id:71,id:'71:check',name:'run_checks',state:'done',args:JSON.stringify(args),result:JSON.stringify({pass:true,exitCode:0,command:{executable:'node'}})};
const input=rows=>({binding,run,rows,requiredCompletion:true});
test('delegated completion exposes actionable remaining pages while retaining its missing-evidence gate',()=>{
 const r=inspectDelegatedCompletion(input([checked,first]));assert.equal(r.complete,false);assert.equal(r.code,'missing_evidence');
 assert.ok(r.feedback.includes('Verified consecutive characters '+firstEnd+'/'+content.length));
 assert.ok(r.feedback.includes(JSON.stringify(inspect([first]).nextRead)));
 assert.equal(inspectDelegatedCompletion(input([checked,first,second,third])).complete,true);
});
test('guidance never waives a stale check or unresolved effect',()=>{
 const mutated={run_id:71,id:'71:shell',name:'shell',state:'done',args:'{}',result:'{}'};
 assert.match(inspectDelegatedCompletion(input([checked,mutated,first,second,third])).feedback,/Fresh checks required/);
 assert.equal(inspectDelegatedCompletion(input([checked,{...mutated,state:'uncertain'}])).code,'protected_boundary');
});
test('completion fingerprints distinguish actual paging progress from repeated first-page finalization',()=>{
 const a=inspectDelegatedCompletion(input([checked,first])),b=inspectDelegatedCompletion(input([checked,first,second]));
 assert.notEqual(a.contractFingerprint,b.contractFingerprint);
 assert.equal(a.contractFingerprint,inspectDelegatedCompletion(input([checked,first,first])).contractFingerprint);
 const state={};delegatedCompletionDecision(input([checked,first]),state);
 const secondDecision=delegatedCompletionDecision(input([checked,first,first]),state);assert.equal(secondDecision.code,'no_progress');
});
test.after(()=>{
 const relative=path.relative(path.resolve(os.tmpdir()),path.resolve(root));
 assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(root,{recursive:true,force:true});
});
