import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMcpScopes,permits,transportHash} from '../runtime/mcp-scope.js';
import {WorkerConnectors} from '../runtime/mcp.js';
const p={id:22};
test('disabled connectors never launch even with all-worker legacy scope or direct connect',async()=>{
 const d={enabled:false,command:'must-not-exist'};
 assert.equal(permits(d,p),false);
 const w=new WorkerConnectors();
 await assert.rejects(w.connect(22,'disabled',d),/disabled/);
 const r=await w.tools(22,{disabled:d});assert.equal(r.available.length,0);assert.equal(r.errors.length,0);assert.equal(w.clients.size,0);
});
test('reviewed tool allowlist denies unknown discoveries without widening server scope',()=>{
 const d={scope:{allow:{workerIds:[22]}},reviewedTools:['read']};
 validateMcpScopes({mcpServers:{s:d}});
 assert.equal(permits(d,p,{},'read'),true);assert.equal(permits(d,p,{},'new-write'),false);
 assert.equal(permits(d,{id:3},{},'read'),false);
 assert.equal(permits({...d,reviewedTools:[]},p,{},'read'),false);
 assert.notEqual(transportHash(d),transportHash({...d,reviewedTools:[]}));
});
test('malformed flags, allowlists and unsupported protected bindings fail closed',()=>{
 for(const d of [{enabled:'false'},{reviewedTools:'read'},{reviewedTools:['x','x']},{reviewedTools:[null]},{credentialBinding:{sourceId:'owner-reference'}}])assert.throws(()=>validateMcpScopes({mcpServers:{s:d}}));
});
