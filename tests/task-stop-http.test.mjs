import test from 'node:test';import assert from 'node:assert/strict';import {sidebarFixture} from './helpers/sidebar-fixture.mjs';
test('real stop HTTP route distinguishes missing, requested, and already settled state',async t=>{
 const f=await sidebarFixture(t,{ownedContext:true});
 const missing=await f.api('/api/runs/2147483647/stop','POST',{});assert.equal(missing.status,404);assert.deepEqual(missing.value,{ok:false,changed:false,reasonCode:'not_found'});
 const id=await f.seedOwnedRun(f.bots.builder.id,'bot:'+f.bots.builder.id,'waiting_cloud','api');
 const requested=await f.api('/api/runs/'+id+'/stop','POST',{});assert.equal(requested.status,200);assert.deepEqual(requested.value,{ok:true,changed:false,requested:true,reasonCode:'stop_requested'});
 const until=Date.now()+5000;let status;do{status=(await f.api('/api/runs/'+id)).value.status;if(status==='stopped')break;await new Promise(r=>setTimeout(r,25));}while(Date.now()<until);assert.equal(status,'stopped');
 const settled=await f.api('/api/runs/'+id+'/stop','POST',{});assert.equal(settled.status,200);assert.deepEqual(settled.value,{ok:true,changed:false,reasonCode:'already_terminal'});
});
