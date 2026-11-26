import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
process.env.NIMBUS_DATA=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-env-'));
process.env.NIMBUS_SYNTHETIC_PRIVATE='must-not-leak';
process.env.PATHEXT??='.COM;.EXE;.BAT;.CMD';
const {WorkerConnectors,invokeConnector}=await import('../runtime/mcp.js');
const {effectTransportHash}=await import('../runtime/mcp-scope.js');

// Live 2026-11-25: servers got no PATHEXT, so PowerShell inside the local specialist
// treated lms.exe as a document. Servers still get only an allowlisted environment.
test('MCP servers receive the Windows system variables they need and nothing private',{timeout:20000},async()=>{
  const def={command:process.execPath,args:[fileURLToPath(new URL('./helpers/env-connector.mjs',import.meta.url))],env:{CONFIGURED_SETTING:'x'},reviewedTools:['env'],reviewedEffects:{}};
  def.reviewedEffects.env={effect:'read',transportHash:effectTransportHash('envtest',def)};
  const m=new WorkerConnectors(),state={principal:{id:22},mcpServers:{envtest:def},mcpScopeGroups:{}};
  try{
    const list=await m.tools(22,state.mcpServers,()=>state);
    const keys=JSON.parse((await invokeConnector(list.bindings.get('mcp__envtest__env'),22,{})).content[0].text);
    assert.ok(keys.includes('PATHEXT'),'PATHEXT is passed');
    assert.ok(keys.includes('CONFIGURED_SETTING'),'configured env is passed');
    assert.ok(!keys.includes('NIMBUS_SYNTHETIC_PRIVATE'),'other parent variables are not passed');
  }finally{await m.close?.();}
});
