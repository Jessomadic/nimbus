import test from 'node:test';
import assert from 'node:assert/strict';
import {chargeToolAttempt} from '../runtime/tool-budget.js';
import {observeProgress,taskTimeExceeded} from '../runtime/progress-execution.js';
test('passive owned wait is exempt but completed and nonowned polls stop',()=>{
 const s={};for(let i=0;i<100;i++)observeProgress(s,'worker_result',{runId:1},{status:'waiting_input'},{childProgress:1,ownedChildWaiting:true});
 assert.notEqual(s.noProgress,true);
 assert.throws(()=>{for(let i=0;i<16;i++)observeProgress(s,'worker_result',{runId:1},{status:'done'},{childProgress:2});},/no-progress/);
});
test('timestamp-only status stops while semantic milestones continue',()=>{
 assert.throws(()=>{const s={};for(let i=0;i<100;i++)observeProgress(s,'team_status',{}, {observedAt:String(i),runs:[{id:1,status:'running',updated_at:i}]});},/no-progress/);
 const s={};for(let i=0;i<100;i++)observeProgress(s,'team_status',{}, {observedAt:String(i),runs:[{id:1,status:'running',milestone:i}]});assert.notEqual(s.noProgress,true);
});
test('productive admission exceeds old cap and time ceiling',()=>{const s={};for(let i=0;i<80;i++){chargeToolAttempt(s,'read_file',{executionMode:'progress',maxSteps:32});observeProgress(s,'read_file',{path:i},{value:i});}assert.equal(s.steps,80);assert.equal(taskTimeExceeded({executionMode:'progress',timeoutMinutes:1},86400000),false);assert.equal(taskTimeExceeded({timeoutMinutes:1},61000),true);});
test('loop guard survives serialized checkpoint and rejects unchanged polls',()=>{let s={};for(let i=0;i<8;i++)observeProgress(s,'worker_result',{runId:1},{status:'running'});s=JSON.parse(JSON.stringify(s));assert.throws(()=>{for(let i=0;i<8;i++)observeProgress(s,'worker_result',{runId:1},{status:'running'});},/no-progress/);});
test('owned child event progress avoids unchanged poll false positive',()=>{const s={};for(let i=0;i<160;i++)observeProgress(s,'worker_result',{runId:1},{status:'running'},{childProgress:i});assert.equal(s.progressRecent.length,128);});
test('forty distinct failures are diagnostics, not an error budget',()=>{const s={progressErrors:100};for(let i=0;i<40;i++)observeProgress(s,'probe',{path:i},{error:'distinct diagnostic '+i});assert.notEqual(s.noProgress,true);});
test('unchanged cycles beyond four actions stop across checkpoints',()=>{for(const period of [5,7,16,32]){let s={},stopped=false;for(let i=0;i<Math.max(16,period*3);i++){try{observeProgress(s,'action'+i%period,{index:i%period},{error:'unchanged '+i%period});}catch(e){assert.equal(e.code,'no_progress');stopped=true;break;}s=JSON.parse(JSON.stringify(s));}assert.equal(stopped,true,'period '+period);}});
test('evolving results on repeated actions continue beyond history cap',()=>{const s={};for(let i=0;i<160;i++)observeProgress(s,'action'+i%5,{index:i%5},{error:'new evidence '+i});assert.notEqual(s.noProgress,true);});
test('few unique outcomes without periodicity are not loop evidence',()=>{const s={};for(let i=0;i<40;i++)observeProgress(s,'read',{}, {value:Math.floor(Math.sqrt(i))%4});assert.notEqual(s.noProgress,true);});
