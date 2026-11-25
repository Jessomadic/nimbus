import test from 'node:test';
import assert from 'node:assert/strict';
import {capabilityRequest,groupToolRequestMessages,renderToolRequestChain} from '../public/tool-request-chain.js';
import {stageRecovery} from '../runtime/tool-development-recovery.js';
const update=(id,requestId,status,version,extra={})=>({id,kind:'capability',thread:'bot:1',author:'system',created_at:1793127300+id,body:JSON.stringify({requestId,title:'Scoped MCP connector authorization for Nimbus workers',toolName:'mcp_connector_scope',status,version,message:status+' stage update'}),...extra});
test('one request has one stable card while messages, separate requests and threads keep their order',()=>{
  const messages=[update(1,'first','queued',1),{id:2,kind:'text',body:'Normal message'},update(3,'first','designing',2),update(4,'second','queued',1),update(5,'first','building',3),update(6,'first','queued',1,{thread:'bot:2'})],before=structuredClone(messages),grouped=groupToolRequestMessages(messages);
  assert.deepEqual(grouped.map(item=>item.id),[1,2,4,6]);assert.deepEqual(grouped[0].capabilityUpdates.map(item=>item.id),[1,3,5]);assert.deepEqual(messages,before);
  const html=renderToolRequestChain(grouped[0],{formatTime:()=> '3:00 PM'});assert.equal((html.match(/data-tool-request-chain=/g)||[]).length,1);assert.match(html,/Building/);assert.match(html,/Earlier updates <span>2/);assert.doesNotMatch(html,/<details[^>]*\sopen\b/);assert.match(html,/data-tool-development="first"/);assert.match(html,/data-capability-mid="1"/);assert.match(html,/data-capability-mid="3"/);
});
test('late older updates remain history and an expanded chain stays expanded',()=>{
  const grouped=groupToolRequestMessages([update(1,'r','building',3),update(2,'r','designing',2)]),html=renderToolRequestChain(grouped[0],{open:true});
  assert.match(html,/runtime-capability-heading[\s\S]*?Building/);assert.match(html,/<details[^>]*\sopen\b/);assert.match(html,/data-capability-mid="2"/);assert.doesNotMatch(html,/<li data-capability-mid="1"/);
});
test('malformed updates remain visible and all request content is escaped',()=>{
  const malformed={id:4,kind:'capability',body:'{bad'},anonymous={id:5,kind:'capability',body:'{}'};assert.equal(capabilityRequest(malformed),null);assert.equal(groupToolRequestMessages([malformed,anonymous]).length,2);assert.match(renderToolRequestChain(malformed),/unavailable/);
  const value=update(6,'r\" onclick=\"bad','blocked',4);value.body=JSON.stringify({...JSON.parse(value.body),title:'<script>bad()</script>',message:'<img onerror=bad()>',toolName:'"<bad>'});const html=renderToolRequestChain(value);assert.doesNotMatch(html,/<script>|<img|<bad>/);assert.match(html,/&lt;script&gt;/);
});
test('recovery classifies exact exhausted build checkpoints and concrete QA defects',()=>{
  const run={status:'done'},receipt={phase:'building',approved:false,summary:'Partial implementation; action budget exhausted.',remainingWork:['Complete dispatcher enforcement']};
  assert.equal(stageRecovery({phase:'building',run,receipt,budget:{exhausted:true}}).kind,'continuation');assert.equal(stageRecovery({phase:'building',run,receipt,budget:{exhausted:false}}),null);assert.equal(stageRecovery({phase:'building',run,receipt,budget:{exhausted:true},uncertain:'Unknown side effect'}),null);assert.equal(stageRecovery({phase:'building',run:{status:'stopped'},receipt,budget:{exhausted:true}}),null);
  assert.equal(stageRecovery({phase:'reviewing',run,receipt:{phase:'reviewing',approved:false,summary:'Wrong empty-input result',failureKind:'implementation',findings:['Empty input must yield zero']}}).kind,'repair');for(const failureKind of ['permission','uncertain','setup','external_input'])assert.equal(stageRecovery({phase:'reviewing',run,receipt:{phase:'reviewing',approved:false,summary:'Requires another authority',failureKind,findings:['A decision is missing']}}),null);
});

test('reserved receipt action requires matching incomplete evidence and a host budget boundary',()=>{
  const run={status:'done'},receipt={phase:'building',approved:false,reasonCode:'tool_budget_exhausted',summary:'Candidate remains incomplete.',remainingWork:['Complete implementation and collect verification.']};
  assert.equal(stageRecovery({phase:'building',run,receipt,budget:{exhausted:false,actionRemaining:1}}).kind,'continuation');
  for(const actionRemaining of [2,20,null,undefined,'1',NaN])assert.equal(stageRecovery({phase:'building',run,receipt,budget:{exhausted:false,actionRemaining}}),null);
  for(const failureKind of ['permission','setup','uncertain','external_input'])assert.equal(stageRecovery({phase:'building',run,receipt:{...receipt,failureKind},budget:{exhausted:true,actionRemaining:0}}),null);
  for(const status of ['stopped','interrupted','error','needs_review','queued','running'])assert.equal(stageRecovery({phase:'building',run:{status},receipt,budget:{actionRemaining:1}}),null);
  for(const change of [{approved:true},{phase:'reviewing'},{remainingWork:[]},{reasonCode:undefined}])assert.equal(stageRecovery({phase:'building',run,receipt:{...receipt,...change},budget:{actionRemaining:1}}),null);
});
