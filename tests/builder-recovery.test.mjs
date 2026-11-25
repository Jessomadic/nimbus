import test from 'node:test';
import assert from 'node:assert/strict';
import {stageRecovery} from '../runtime/tool-development-recovery.js';
test('builder implementation findings normalize but safety holds never recover',()=>{
 const args={phase:'building',run:{status:'done',checkpoint:'{}'},receipt:{phase:'building',approved:false,summary:'Repair actual defect',failureKind:'implementation',findings:[{file:'runtime/mcp.js',detail:'group context missing'}]}};
 assert.deepEqual(stageRecovery(args).findings,['runtime/mcp.js: group context missing']);
 for(const failureKind of ['permission','setup','uncertain','external_input']) assert.equal(stageRecovery({...args,receipt:{...args.receipt,failureKind}}),null);
 assert.equal(stageRecovery({...args,uncertain:true}),null);
 assert.equal(stageRecovery({...args,run:{...args.run,checkpoint:'{"noProgress":true}'}}),null);
 assert.equal(stageRecovery({...args,receipt:{...args.receipt,findings:[{file:'x',detail:''}]}}),null);
});
