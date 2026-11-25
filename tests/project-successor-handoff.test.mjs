import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {tools,roleTools,execute} from '../runtime/toolsets/generated/project_successor_handoff.js';
import {hasSpecialistTool,specialistToolNames} from '../runtime/toolsets/index.js';
import {normalizeHandoffIntent,handoffFingerprint,assertHandoffAuthorization,assertHandoffActivation,boundedHandoffContext} from '../runtime/project-successor-handoff.js';
const bytes=Buffer.from('Current authoritative checkpoint');
const hash=createHash('sha256').update(bytes).digest('hex');
const fixture=()=>normalizeHandoffIntent({reservationId:'reservation',project:'hermes',leaderRunId:633,checkpointRef:'shared/hermes/current.md',checkpointSha256:hash,successorRequestId:'postboot-successor',taskSummary:'Continue exact authorized migration',deployment:{snapshotId:'c40654af-647a-466c-94e8-c4fd77f375e7',validatedHash:hash,oldPid:10},continuationPolicy:'none'});
const evidence=()=>({receipt:{id:fixture().deployment.snapshotId,state:'applied',validatedHash:hash,candidate:{hash},bootHash:hash,pid:11},currentPid:11,currentHash:hash,bootHash:hash,pending:null,supervised:true,checkpointHash:hash,policy:{ownerAuthorized:true,project:'hermes',leaderRunId:633,stopped:false,sourceHeld:false,uncertain:false,rejectedApproval:false,noProgress:false,activeEffects:false}});
test('native pack is strict and consumer-only, with no host fallback',()=>{
 assert.equal(tools.length,1);assert.equal(tools[0].function.name,'project_successor_handoff');
 assert.equal(tools[0].function.parameters.additionalProperties,false);
 assert.deepEqual(roleTools,{orchestrator:['project_successor_handoff']});
 assert.ok(hasSpecialistTool('project_successor_handoff'));
 assert.ok(specialistToolNames('orchestrator').includes('project_successor_handoff'));
 assert.ok(!specialistToolNames('builder').includes('project_successor_handoff'));
 assert.throws(()=>execute('project_successor_handoff',{action:'status',reservationId:'r'}),/unavailable/);
});
test('worker cannot supply owner, adoption, leader or shell authority',()=>{
 for(const field of ['owner','runId','botId','adopt','command','skipHistory']){
  assert.throws(()=>execute('project_successor_handoff',{action:'reserve',reservationId:'r',expectedCheckpointHash:hash,[field]:true},{projectSuccessorHandoff(){assert.fail('must not dispatch');}}),/Invalid/);
 }
 assert.throws(()=>execute('project_successor_handoff',{action:'reserve',reservationId:'r'}),/requires/);
 let calls=0;assert.equal(execute('project_successor_handoff',{action:'status',reservationId:'r'},{projectSuccessorHandoff:a=>{calls++;return a.action;}}),'status');assert.equal(calls,1);
});
test('intent fingerprint rejects unknown fields and is stable across key order',()=>{
 const i=fixture();assert.equal(handoffFingerprint(i),handoffFingerprint(Object.fromEntries(Object.entries(i).reverse())));
 for(const ref of ['../x','shared/../x','shared/a\\b','shared/C:x','shared//x']){
  assert.throws(()=>normalizeHandoffIntent({...i,checkpointRef:ref}),/invalid_pin/);
 }
 assert.throws(()=>normalizeHandoffIntent({...i,owner:'forged'}),/invalid_fields/);
 assert.throws(()=>normalizeHandoffIntent({...i,taskSummary:'x'.repeat(8193)}),/invalid_summary/);
});
test('owner and original active parentless leader are mandatory; DONE633 and stopped631 cannot authorize',()=>{
 const i=fixture(),a={principal:{kind:'named-owner',id:'owner'},leader:{id:633,parent_run:null,template:'orchestrator',status:'waiting_tool'},project:'hermes',ownerArmed:true};
 assert.doesNotThrow(()=>assertHandoffAuthorization(i,a));
 for(const status of ['done','stopped','failed','queued'])assert.throws(()=>assertHandoffAuthorization(i,{...a,leader:{...a.leader,status}}),/inactive/);
 assert.throws(()=>assertHandoffAuthorization(i,{...a,leader:{...a.leader,id:631}}),/inactive/);
 assert.throws(()=>assertHandoffAuthorization(i,{...a,principal:{kind:'worker',id:'22'}}),/owner_required/);
 assert.throws(()=>assertHandoffAuthorization(i,{...a,project:'other'}),/binding/);
});
test('postboot exact deployment gates reject missing, stale or uncertain evidence',()=>{
 const i=fixture();assert.doesNotThrow(()=>assertHandoffActivation(i,evidence()));
 for(const [k,v] of Object.entries({currentPid:10,currentHash:'0'.repeat(64),bootHash:'0'.repeat(64),pending:{},supervised:false,checkpointHash:'0'.repeat(64)}))
  assert.throws(()=>assertHandoffActivation(i,{...evidence(),[k]:v}));
 for(const k of ['stopped','sourceHeld','uncertain','rejectedApproval','noProgress','activeEffects']){
  const e=evidence();e.policy[k]=true;assert.throws(()=>assertHandoffActivation(i,e),/policy_gate/);
  delete e.policy[k];assert.throws(()=>assertHandoffActivation(i,e),/policy_gate/);
 }
 for(const k of ['pid','id','state','validatedHash','bootHash','candidate']){
  const e=evidence();delete e.receipt[k];assert.throws(()=>assertHandoffActivation(i,e));
 }
});
test('context preserves exact checkpoint pins, verifies archive bytes, never includes history',()=>{
 const i=fixture(),artifacts=[{ref:i.checkpointRef,bytes}];
 const prompt=boundedHandoffContext(i,artifacts);
 assert.ok(prompt.includes(hash));assert.ok(Buffer.byteLength(prompt)<32768);
 assert.throws(()=>boundedHandoffContext(i,[{...artifacts[0],bytes:Buffer.from('changed')}] ),/hash_mismatch/);
 const history=Buffer.alloc(4_850_000,120);
 assert.throws(()=>boundedHandoffContext(i,[{...artifacts[0],bytes:history}]),/oversized/);
 assert.throws(()=>boundedHandoffContext(i,[]),/archive_missing/);
});
