import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const runner=fs.readFileSync(new URL('../runner.js',import.meta.url),'utf8');
const callback=runner.slice(runner.indexOf('export async function recoverProjectRequest('),runner.indexOf('export function startToolDevelopment(')).replace('export ','');
test('actual recovery callback rejects ownership before first-review dispatch and forwards exact CAS payload',async()=>{
 const events=[],args={action:'initiate_source_review',requestId:'consumer',priorRequestId:'prior',expectedVersion:8,stageRunId:892,expectedSourceHash:'a'.repeat(64),reason:'Review'};
 let allowed=false;
 const ownership={assertOwned:(id,context)=>{events.push({id,context});if(!allowed)throw Error('Not owned');}};
 const service={initiateSourceReview:(id,input)=>{events.push({dispatch:id,input});return{reviewTaskId:123};}};
 const recover=new Function('projectLifecycleOwnership','toolDevelopment','scopedDispatch',callback+';return recoverProjectRequest;')(ownership,service,id=>assert.equal(id,10));
 await assert.rejects(recover(10,22,args,'call'),/Not owned/);assert.equal(events.length,1);
 allowed=true;assert.deepEqual(await recover(10,22,args,'call'),{reviewTaskId:123});
 assert.deepEqual(events[1],{id:'consumer',context:{runId:10,botId:22,requestKey:'call'}});assert.equal(events[2].input,args);
});
test('owner HTTP route preserves authentication before and after body read',()=>{
 const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const route=server.slice(server.indexOf("route('POST','/api/tool-requests/:id/review-source'"),server.indexOf("route('POST','/api/runs/:id/resume'"));
 assert.equal((route.match(/continuationOwner\(req,res\)/g)||[]).length,2);
 assert.ok(route.indexOf('continuationOwner')<route.indexOf('await body'));
 assert.ok(route.lastIndexOf('continuationOwner')>route.indexOf('await body'));
 assert.ok(route.lastIndexOf('continuationOwner')<route.indexOf('toolDevelopment.initiateSourceReview'));
});
