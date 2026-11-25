import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMcpScopes,permits,policyHash,policyView} from '../runtime/mcp-scope.js';
import {tools,roleTools,execute} from '../runtime/toolsets/generated/mcp_connector_scope.js';
const principal={id:22,template:'orchestrator'};
test('server IDs, exact templates and security groups; selectors OR and legacy compatibility',()=>{
  for(const allow of [{workerIds:[22]},{templates:['orchestrator']},{groups:['operators']}]){
    const c={mcpScopeGroups:{operators:{workerIds:[22]}},mcpServers:{s:{scope:{allow}}}};
    validateMcpScopes(c);assert.equal(permits(c.mcpServers.s,principal,c.mcpScopeGroups),true);
    assert.equal(permits(c.mcpServers.s,{id:3,template:'reviewer'},c.mcpScopeGroups),false);
  }
  assert.equal(permits({},principal),true);assert.equal(permits({scope:{allow:{}}},principal),false);
  assert.equal(permits({scope:{allow:{templates:['orchestrator']}}},{id:3,template:'orchestrator-helper'}),false);
});
test('tool allow only narrows and deny wins; unlisted tools inherit',()=>{
  const def={scope:{allow:{workerIds:[22]},tools:{write:{allow:{templates:['orchestrator']},deny:{workerIds:[22]}}}}};
  assert.equal(permits(def,principal,{},'read'),true);
  assert.equal(permits(def,principal,{},'write'),false);
  assert.equal(permits(def,{id:3,template:'orchestrator'},{},'write'),false);
});
test('reject malformed, unknown and credential-shaped policy fields',()=>{
  const invalid=[null,{}, {allow:null},{allow:{workerIds:[0]}},{allow:{workerIds:[22,22]}},{allow:{templates:['']}},{allow:{groups:['missing']}},{allow:{token:'secret'}},{allow:{},password:'secret'},{allow:{},tools:{x:{}}},{allow:{},tools:{x:{deny:null}}}];
  for(const scope of invalid)assert.throws(()=>validateMcpScopes({mcpServers:{s:{scope}}}));
  assert.throws(()=>validateMcpScopes({mcpScopeGroups:{g:{groups:['g']}}}));
  assert.throws(()=>validateMcpScopes({mcpScopeGroups:null}));
  assert.throws(()=>validateMcpScopes(JSON.parse('{"mcpServers":{"s":{"scope":{"allow":{},"tools":{"__proto__":{"deny":{}}}}}}}')));
});
test('policy hash excludes credentials and is deterministic, includes revocation',()=>{
  const a={mcpServers:{s:{headers:{Authorization:'sentinel'},scope:{allow:{workerIds:[22]}}}}};
  const b=structuredClone(a);b.mcpServers.s.headers.Authorization='changed';
  assert.equal(policyHash(a),policyHash(b));assert.ok(!JSON.stringify(policyView(a)).includes('sentinel'));
  b.mcpServers.s.scope.allow.workerIds=[];assert.notEqual(policyHash(a),policyHash(b));
});
test('native pack exact schema, consumer grant, direct denial and explicit incomplete-write guard',()=>{
  assert.equal(tools.length,1);assert.equal(tools[0].function.name,'mcp_connector_scope');
  assert.equal(tools[0].function.parameters.type,'object');assert.equal(tools[0].function.parameters.additionalProperties,false);
  assert.deepEqual(roleTools,{}); // Explicit original-consumer activation belongs to the host.
  assert.throws(()=>execute('mcp_connector_scope',{action:'validate',server:'s',scope:{allow:{}},expectedPolicyHash:'a'.repeat(64)},{bot:{tools:'["mcp_connector_scope"]'}}),/does not accept/);
  assert.throws(()=>execute('mcp_connector_scope',{action:'status'},{bot:{tools:'[]'}}),/not enabled/);
  const ctx={bot:{tools:'["mcp_connector_scope"]'}};
  assert.throws(()=>execute('mcp_connector_scope',{action:'set'},ctx),/required/);
  assert.throws(()=>execute('mcp_connector_scope',{action:'status',token:'x'},ctx),/Invalid/);
});
