import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
process.env.NIMBUS_DATA=fs.mkdtempSync(path.join(os.tmpdir(),'call-timeout-'));
const {WorkerConnectors,invokeConnector}=await import('../runtime/mcp.js');
const {validateMcpScopes,effectTransportHash}=await import('../runtime/mcp-scope.js');

// Live 2026-11-25: the local specialist model needs ~160 s to load and answer, but every
// connector call was capped at 120 s. callTimeoutMs lets one connector have a longer deadline.
function slowServer(callTimeoutMs){
  const def={command:process.execPath,args:[fileURLToPath(new URL('./helpers/slow-connector.mjs',import.meta.url))],env:{DELAY_MS:'1500'},reviewedTools:['slow'],reviewedEffects:{},...(callTimeoutMs?{callTimeoutMs}:{})};
  def.reviewedEffects.slow={effect:'read',transportHash:effectTransportHash('slow',def)};
  return def;
}
async function call(def){
  const m=new WorkerConnectors(),state={principal:{id:22},mcpServers:{slow:def},mcpScopeGroups:{}};
  try{const list=await m.tools(22,state.mcpServers,()=>state);return await invokeConnector(list.bindings.get('mcp__slow__slow'),22,{});}
  finally{await m.close?.();}
}

test('callTimeoutMs is validated',()=>{
  for(const bad of [0,999,900001,1.5,'60000'])assert.throws(()=>validateMcpScopes({mcpServers:{x:{command:'x',callTimeoutMs:bad}},mcpScopeGroups:{}}),/Invalid MCP call deadline/);
  assert.doesNotThrow(()=>validateMcpScopes({mcpServers:{x:{command:'x',callTimeoutMs:300000}},mcpScopeGroups:{}}));
});

test('a connector call uses its configured deadline',{timeout:20000},async()=>{
  await assert.rejects(call(slowServer(1000)),/timed out/i);
  const ok=await call(slowServer(10000));
  assert.equal(ok.content[0].text,'answer 391');
});
