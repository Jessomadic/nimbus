import test from 'node:test';
import assert from 'node:assert/strict';
import {validateMcpScopes} from '../runtime/mcp-scope.js';
import {WorkerConnectors} from '../runtime/mcp.js';
const validate=d=>validateMcpScopes({mcpServers:{fixture:d}});
test('unresolved credential maps fail before client creation, without value disclosure',async()=>{
 const synthetic='fixture-only-sensitive-marker';
 for(const field of ['headers','env'])for(const value of [{ref:synthetic},[synthetic],null,42]){
  const def={command:'must-not-launch', [field]:{TOKEN:value}};
  assert.throws(()=>validate(def),e=>!e.message.includes(synthetic)&&/credential transport map/.test(e.message));
  const w=new WorkerConnectors();
  await assert.rejects(w.connect(22,'fixture',def),/credential transport map/);
  assert.equal(w.clients.size,0);
 }
});
test('malformed maps, control injection and Windows case aliases fail closed',()=>{
 for(const d of [{env:null},{headers:[]},{env:{TOKEN:'x\u0000y'}},{headers:{Authorization:'x\r\ny'}},{headers:{'bad header':'fixture'}},{env:{TOKEN:'one',token:'two'}}])
  assert.throws(()=>validate(d));
});
test('legacy owner environment strings preserved; protected bindings remain unavailable',()=>{
 const d={enabled:false,command:'fixture',env:{USERPROFILE:'C:\\Users\\Fixture',TOKEN:'synthetic-only'},headers:{Authorization:'Bearer synthetic-only'}};
 assert.equal(validate(d).mcpServers.fixture,d);
 assert.equal(d.env.USERPROFILE,'C:\\Users\\Fixture');
 assert.throws(()=>validate({...d,credentialBinding:{sourceId:'fixture-owner'}}),/resolver unavailable/);
});
