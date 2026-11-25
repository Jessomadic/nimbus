import test from 'node:test';
import assert from 'node:assert/strict';
import {implementationFindings} from '../runtime/implementation-findings.js';
import {stageRecovery} from '../runtime/tool-development-recovery.js';

test('Builder1121 code/detail failures normalize without approving a partial stub',()=>{
 const findings=[{code:'HOST_AUTHORITY_MISSING',detail:'Actual host attachment remains unimplemented.'},{code:'FREEZE_AND_DISPATCH_MISSING',detail:'Writer freeze and dispatcher are not integrated.'}];
 assert.deepEqual(implementationFindings(findings),['HOST_AUTHORITY_MISSING: Actual host attachment remains unimplemented.','FREEZE_AND_DISPATCH_MISSING: Writer freeze and dispatcher are not integrated.']);
 const receipt={requestId:'retained',phase:'building',approved:false,failureKind:'implementation',summary:'Partial stub does not fulfill the accepted design',findings};
 assert.equal(stageRecovery({phase:'building',run:{status:'done',checkpoint:'{}'},receipt}).kind,'repair');
 assert.equal(receipt.approved,false);
 for(const bad of [{code:'bad code',detail:'x'},{code:'HOST',detail:''},{code:'HOST',detail:'x',approved:true},{code:'HOST',detail:'x',file:'x'},{code:'HOST',detail:'x'.repeat(4001)},{code:'X'.repeat(81),detail:'x'}])assert.equal(implementationFindings([bad]),null);
 assert.equal(implementationFindings([findings[0],{code:'OTHER'}]),null);
 for(const failureKind of ['permission','setup','uncertain','external_input'])assert.equal(stageRecovery({phase:'building',run:{status:'done',checkpoint:'{}'},receipt:{...receipt,failureKind}}),null);
 assert.equal(stageRecovery({phase:'building',run:{status:'done',checkpoint:'{"noProgress":true}'},receipt}),null);
 assert.equal(stageRecovery({phase:'building',run:{status:'done',checkpoint:'{}'},receipt,uncertain:true}),null);
});
test('structured reproduction evidence is preserved and malformed evidence fails closed',()=>{
 const f={title:'Lease',steps:'Run concurrent validators',expected:'Lease excludes second caller',actual:'COMMIT database locked'};
 const canonical='Lease:\nSteps: Run concurrent validators\nExpected: Lease excludes second caller\nActual: COMMIT database locked';
 assert.deepEqual(implementationFindings([f]),[canonical]);
 assert.deepEqual(stageRecovery({phase:'testing',run:{status:'done',checkpoint:'{}'},receipt:{phase:'testing',approved:false,summary:'repair',failureKind:'implementation',findings:[f]}}).findings,[canonical]);
 for(const bad of [{...f,steps:[]},{...f,actual:''},{...f,expected:'x'.repeat(4001)},{...f,extra:true},{title:'only'}])assert.equal(implementationFindings([bad]),null);
 assert.equal(implementationFindings([{...f,steps:'x'.repeat(2000),actual:'y'.repeat(2000)}]),null);
});
test('bounded string, file/detail and title/detail findings normalize consistently',()=>{
 assert.deepEqual(implementationFindings([' a ',{file:'x.js',detail:' bug '},{title:'Dispatch',detail:'missing callback'}]),['a','x.js: bug','Dispatch: missing callback']);
 for(const findings of [[],['ok',{}],['x'.repeat(4001)],Array(21).fill('bug'),[{title:'x',detail:''}]])assert.equal(implementationFindings(findings),null);
 const receipt={phase:'testing',approved:false,summary:'repair needed',failureKind:'implementation',findings:[{title:'Dispatch',detail:'missing callback'}]};
 assert.deepEqual(stageRecovery({phase:'testing',run:{status:'done',checkpoint:'{}'},receipt}).findings,['Dispatch: missing callback']);
 for(const failureKind of ['permission','setup','uncertain','external_input'])assert.equal(stageRecovery({phase:'testing',run:{status:'done',checkpoint:'{}'},receipt:{...receipt,failureKind}}),null);
});

test('Builder severity/description receipts normalize to the same bounded findings as strings',()=>{
 const finding={severity:'blocking',description:' Repair the implementation defect '};
 assert.deepEqual(implementationFindings([finding]),['Repair the implementation defect']);
 assert.deepEqual(implementationFindings([{description:'Repair the implementation defect',severity:'blocking'}]),implementationFindings(['Repair the implementation defect']));
 assert.deepEqual(implementationFindings([{severity:'blocking',description:'x'.repeat(4000)}]),['x'.repeat(4000)]);
 for(const phase of ['building','testing','reviewing']){
  const receipt={phase,approved:false,summary:'A real implementation defect remains',failureKind:'implementation',findings:[finding]};
  const run={status:'done',checkpoint:'{}'};
  assert.deepEqual(stageRecovery({phase,run,receipt}),{kind:'repair',phase,reason:receipt.summary,findings:['Repair the implementation defect']});
  for(const failureKind of ['permission','setup','uncertain','external_input'])assert.equal(stageRecovery({phase,run,receipt:{...receipt,failureKind}}),null);
  assert.equal(stageRecovery({phase,run,receipt,uncertain:true}),null);
  assert.equal(stageRecovery({phase,run:{...run,checkpoint:'{"noProgress":true}'},receipt}),null);
  assert.equal(stageRecovery({phase,run,receipt:{...receipt,approved:true}}),null);
 }
});

test('severity/description compatibility fails closed on unknown, mixed, oversized or malformed fields',()=>{
 const valid={severity:'blocking',description:'Real defect'};
 const malformed=[
  {...valid,extra:true},{...valid,title:'Mixed legacy shape',detail:'Must not fall through'},
  {severity:'blocking'}, {description:'Missing severity'},
  ...['warning','critical','BLOCKING',' blocking ',''].map(severity=>({...valid,severity})),
  ...['','   ','x'.repeat(4001),' '+ 'x'.repeat(4000),null,7,[],{}].map(description=>({...valid,description})),
  {severity:null,description:'Real defect'}
 ];
 for(const bad of malformed){
  assert.equal(implementationFindings([bad]),null,JSON.stringify(bad).slice(0,150));
  assert.equal(implementationFindings([valid,bad]),null,'No partial acceptance of mixed malformed arrays');
 }
 assert.equal(implementationFindings(Array(21).fill(valid)),null);
});
