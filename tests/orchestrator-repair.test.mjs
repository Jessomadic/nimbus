import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROLE_PROFILES} from '../runtime/roles.js';
import {PROMPT_VERSION,buildWorkerBrief} from '../runtime/prompts.js';
import {LEGACY_ORCHESTRATOR_INSTRUCTIONS,CUSTOM_INSTRUCTIONS_MARKER,planOrchestratorRepair,repairOrchestrator} from '../bin/repair-orchestrator.mjs';

const clone=value=>JSON.parse(JSON.stringify(value));
const rootProfile=()=>ROLE_PROFILES.find(profile=>profile.id==='orchestrator');
const removed=['read_file','write_file','list_files','shell','exec_command','apply_patch','browser','view_image','skills','write_stdin'];
const expected=['update_plan','request_user_input','capabilities','request_tool','tool_request_status','shared_note','ask_worker','self_update','tool_catalog','connector_inventory','task_history','team_status'];
function fixture(t,{instructions=LEGACY_ORCHESTRATOR_INSTRUCTIONS,active=0,queued=0}={}){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-orchestrator-repair-')),calls=[],oldTools=['shell','exec_command','write_stdin','apply_patch','read_file','write_file','list_files','view_image','skills','update_plan','request_user_input','capabilities','request_tool','tool_request_status','browser','shared_note','ask_worker','self_update','tool_catalog','connector_inventory','task_history','team_status'];
  const root={id:22,name:'Orchestrator',template:'orchestrator',parent_bot_id:null,instructions,tools:JSON.stringify(oldTools),model:'astra',default_model:'terra',effort:'max',role:'Keep custom role',color:'#abc123',shape:'square',runtime:'auto',computer:0,display_group:'',created_at:44,approval_rules:['Retain approvals'],allow_rules:['Retain permissions'],plugins:['configured-plugin'],status:{state:'idle'},today:{runs:1}},builder={id:2,name:'Builder',template:'builder',parent_bot_id:22,instructions:'Retain Builder custom instructions',tools:JSON.stringify(['shell','read_file','apply_patch']),model:'sol',default_model:'terra',approval_rules:['Keep specialist rules'],plugins:['retain-specialist-plugin']};
  const state={bots:[builder,root],queues:{workers:{active,queued}},rooms:[{id:5,members:[2,22]}],history:[{id:53,status:'paused',checkpoint:'Never resume or overwrite'}],mcpServers:{fixture:{configured:true}}};
  const f={temp,calls,state,before:clone(state),reads:0,receipt:path.join(temp,'repair.json'),onRead:null,onPatch:null};
  f.api=async(route,method='GET',body)=>{calls.push({route,method,body:clone(body??null)});if(route==='/api/state'&&method==='GET'){f.reads++;f.onRead?.(f.reads);return clone(state);}assert.equal(route,'/api/bots/22');assert.equal(method,'PATCH');assert.deepEqual(Object.keys(body).sort(),['instructions','tools']);f.onPatch?.(body);root.instructions=body.instructions;root.tools=JSON.stringify(body.tools);return clone(root);};
  t.after(()=>{assert.equal(path.dirname(temp),os.tmpdir());assert.match(path.basename(temp),/^nimbus-orchestrator-repair-/);fs.rmSync(temp,{recursive:true,force:true});});return f;
}

test('Coordinator has only coordination and inventory tools while specialists retain direct execution',()=>{
  assert.deepEqual([...rootProfile().tools].sort(),[...expected].sort());
  for(const name of removed)assert.ok(!rootProfile().tools.includes(name),name);
  for(const id of ['builder','architect','windows-operator','automation-engineer','qa-engineer']){
    const profile=ROLE_PROFILES.find(item=>item.id===id);for(const name of removed)assert.ok(profile.tools.includes(name),id+': '+name);
  }
});

test('Coordinator prompt requires an early current-run handoff and preserves clarification and authority',()=>{
  assert.equal(PROMPT_VERSION,'2026-10-27.3');const profile=rootProfile(),brief=buildWorkerBrief({bot:{id:22,...profile,template:'orchestrator'},team:[{id:2,name:'Builder',parent_bot_id:22}]});
  assert.match(brief,/first coordination tool call is team_status/);assert.match(brief,/within about three coordination calls/);assert.match(brief,/exact worker ID returned by team_status/);assert.match(brief,/children created by this CURRENT run/);assert.match(brief,/Simple conversation/);assert.match(brief,/disabled coordinator tool is not a missing implementation/);assert.match(brief,/human owner remains the authority/);assert.match(brief,/host-supplied memory/);assert.doesNotMatch(brief,/Read MEMORY.md in your workspace/);
  const specialist=buildWorkerBrief({bot:{...ROLE_PROFILES.find(item=>item.id==='builder'),template:'builder'}});assert.doesNotMatch(specialist,/## Coordination lane/);assert.match(specialist,/Read MEMORY.md in your workspace/);assert.match(specialist,/Delegate a bounded specialist task only when it helps/);
});

test('Legacy repair provenance is bound to the actual shipped original profile text',()=>{
  assert.equal(createHash('sha256').update(LEGACY_ORCHESTRATOR_INSTRUCTIONS).digest('hex'),'64eea6e04a879ecbb1ebe69085e75d495e4dec9b8194d7754bc3c0feece3504b');
});

test('Dry-run reads the actual coordinator and reports exact removals without writes or receipt',async t=>{
  const f=fixture(t),result=await repairOrchestrator({api:f.api,source:'Read-only fixture API'});assert.equal(result.apply,false);assert.equal(result.plan.botId,22);assert.equal(result.plan.classification,'legacy_default');assert.deepEqual([...result.plan.removedTools].sort(),[...removed].sort());assert.deepEqual(result.plan.tools,rootProfile().tools);assert.equal(result.plan.patch,undefined);assert.deepEqual(f.state,f.before);assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(fs.existsSync(f.receipt),false);
});

test('Repair updates only root tools/instructions and retains old assignments in a durable receipt',async t=>{
  const f=fixture(t),result=await repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt,source:{kind:'Fixture API',request:'repair-1'}});assert.equal(result.verified,true);assert.equal(result.changed,true);assert.equal(result.botId,22);
  const observed=f.state.bots.find(bot=>bot.id===22),before=f.before.bots.find(bot=>bot.id===22);assert.equal(observed.instructions,rootProfile().instructions);assert.deepEqual(JSON.parse(observed.tools),expected);assert.deepEqual({...observed,instructions:before.instructions,tools:before.tools},before);assert.deepEqual(f.state.bots[0],f.before.bots[0]);assert.deepEqual(f.state.history,f.before.history);assert.deepEqual(f.state.rooms,f.before.rooms);assert.deepEqual(f.state.mcpServers,f.before.mcpServers);assert.equal(f.calls.filter(call=>call.method==='PATCH').length,1);
  const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.complete,true);assert.equal(receipt.before.tools,before.tools);assert.equal(receipt.before.instructions,LEGACY_ORCHESTRATOR_INSTRUCTIONS);assert.equal(receipt.provenance.profileSource,'runtime/roles.js');assert.deepEqual(receipt.unexpectedChanges,[]);assert.deepEqual(receipt.plan.removedTools,result.removedTools);assert.equal(receipt.operations[0].status,'observed');
  const second=await repairOrchestrator({api:f.api,apply:true,receiptFile:path.join(f.temp,'second.json')});assert.equal(second.changed,false);assert.equal(f.calls.filter(call=>call.method==='PATCH').length,1);
});

test('Documented legacy/current profile prefixes preserve the custom suffix byte-for-byte',async t=>{
  const suffix='Retain exact owner constraint.\r\n\r\nUse project α and never change external account settings.\n';
  for(const prefix of [LEGACY_ORCHESTRATOR_INSTRUCTIONS,rootProfile().instructions]){
    const f=fixture(t,{instructions:prefix+CUSTOM_INSTRUCTIONS_MARKER+suffix}),result=await repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt});assert.equal(result.customPreserved,true);assert.equal(f.state.bots[1].instructions,rootProfile().instructions+CUSTOM_INSTRUCTIONS_MARKER+suffix);assert.equal(f.state.bots[1].instructions.split(CUSTOM_INSTRUCTIONS_MARKER).length,2);
    const second=await repairOrchestrator({api:f.api,apply:true,receiptFile:path.join(f.temp,'second.json')});assert.equal(second.changed,false);assert.equal(f.state.bots[1].instructions,rootProfile().instructions+CUSTOM_INSTRUCTIONS_MARKER+suffix);
  }
});

test('Unrecognized custom instructions require explicit preservation; an opted-in repair never loses text',async t=>{
  const custom='Owner-only custom instructions without any known profile prefix.\nPreserve this entire text.';
  const f=fixture(t,{instructions:custom});await assert.rejects(repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt}),error=>error.code==='custom_instructions_require_review');assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(fs.existsSync(f.receipt),false);assert.equal(f.state.bots[1].instructions,custom);
  const result=await repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt,preserveCustom:true});assert.equal(result.customPreserved,true);assert.equal(f.state.bots[1].instructions,rootProfile().instructions+CUSTOM_INSTRUCTIONS_MARKER+custom);
});

test('Missing, duplicate or parented coordinators block repair without changing any agent',async t=>{
  for(const variant of ['missing','duplicate','parented','name_collision']){
    const f=fixture(t);if(variant==='missing')f.state.bots.pop();if(variant==='duplicate')f.state.bots.push({...f.state.bots[1],id:23});if(variant==='parented')f.state.bots[1].parent_bot_id=2;if(variant==='name_collision')f.state.bots[1].template='custom';const before=clone(f.state);
    await assert.rejects(repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt}),error=>[404,409].includes(error.statusCode));assert.deepEqual(f.state,before);assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(fs.existsSync(f.receipt),false);
  }
});

test('Busy/unknown queues and a worker starting after the plan block the PATCH',async t=>{
  for(const mode of ['active','queued','unknown','started_after_plan']){
    const f=fixture(t,{active:mode==='active'?1:0,queued:mode==='queued'?1:0});if(mode==='unknown')delete f.state.queues;if(mode==='started_after_plan')f.onRead=count=>{if(count===2)f.state.queues.workers.active=1;};
    await assert.rejects(repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt}),error=>['workers_active','queue_state_unknown'].includes(error.code));assert.ok(f.calls.every(call=>call.method==='GET'));assert.equal(f.state.bots[1].instructions,LEGACY_ORCHESTRATOR_INSTRUCTIONS);
    if(fs.existsSync(f.receipt)){const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.complete,false);assert.match(receipt.error,/active and queued/);}
  }
});

test('Concurrent source drift is retained and stops repair before any mutation',async t=>{
  const f=fixture(t);f.onRead=count=>{if(count===2)f.state.bots[1].instructions='New owner edits after dry-run';};await assert.rejects(repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt}),error=>error.code==='repair_source_drift');assert.equal(f.state.bots[1].instructions,'New owner edits after dry-run');assert.ok(f.calls.every(call=>call.method==='GET'));const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.complete,false);assert.match(receipt.error,/changed after the repair plan/);
});

test('Unexpected unrelated changes are reported without overwriting them or claiming verified completion',async t=>{
  const f=fixture(t);f.onPatch=()=>{f.state.bots[1].model='local';f.state.bots[0].instructions='Concurrent specialist edit';};await assert.rejects(repairOrchestrator({api:f.api,apply:true,receiptFile:f.receipt}),/unexpected settings changes/);assert.equal(f.state.bots[1].model,'local');assert.equal(f.state.bots[0].instructions,'Concurrent specialist edit');const receipt=JSON.parse(fs.readFileSync(f.receipt,'utf8'));assert.equal(receipt.complete,false);assert.ok(receipt.unexpectedChanges.some(change=>change.field==='model'));assert.ok(receipt.unexpectedChanges.some(change=>change.field==='other_agents'));
});
