import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-toolset-integration-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
const {coreTools,buildTools,executeTool}=await import('../runtime/tools.js');
const {specialistTools,specialistToolNames,roleToolCoverage}=await import('../runtime/toolsets/index.js');
const {ROLE_PROFILES}=await import('../runtime/roles.js');
const {requiresApproval}=await import('../runtime/policy.js');
const {policyCommand}=await import('../runtime/toolsets/engineering.js');
const {db}=await import('../db.js');
test('every specialist tool publishes one unique schema and every built-in role gains real domain tools',()=>{
  assert.ok(specialistTools.length>=46);assert.equal(new Set(coreTools.map(t=>t.function.name)).size,coreTools.length);
  for(const tool of coreTools){assert.equal(tool.function.parameters.type,'object');assert.equal(tool.function.parameters.additionalProperties,false);for(const key of tool.function.parameters.required||[])assert.ok(Object.hasOwn(tool.function.parameters.properties,key),tool.function.name+': '+key);}
  const actual=new Set(coreTools.map(t=>t.function.name));
  for(const role of roleToolCoverage(ROLE_PROFILES)){
    assert.ok(role.specialistTools.length>=1,role.name+' has no domain tool');
    const profile=ROLE_PROFILES.find(p=>p.id===role.id);for(const name of role.tools){assert.ok(actual.has(name));assert.ok(profile.tools.includes(name));}
  }
  assert.deepEqual(specialistToolNames('unknown-custom-role'),['tool_catalog']);
});
test('real worker tool building preserves role limits and routes tools through the shared dispatcher',async()=>{
  const profile=ROLE_PROFILES.find(p=>p.id==='researcher'),bot={...profile,id:981,tools:JSON.stringify(profile.tools)};
  const available=await buildTools(bot);assert.ok(available.tools.some(t=>t.function.name==='source_register'));assert.ok(!available.tools.some(t=>t.function.name==='shell'));
  const result=await executeTool(bot,'tool_catalog',{query:'source register'},{availableTools:available.tools,bindings:available.bindings});assert.ok(result.tools.some(t=>t.name==='source_register'));
});
test('check runner canonical policy includes the script body and schedule enabling remains gated',()=>{
  fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node test.mjs && git push origin main'}}));
  const command=policyCommand('run_checks',{runner:'npm_script',script:'test',path:root},{workspace:root});assert.match(command,/git push/);
  assert.equal(requiresApproval({approval_rules:['shell(*git push*)'],allow_rules:[]},'run_checks',{command}),true);
  assert.equal(requiresApproval({approval_rules:['automation_schedule(enable)'],allow_rules:[]},'automation_schedule',{action:'enable',scheduleId:1}),true);
  assert.equal(requiresApproval({approval_rules:['automation_schedule(enable)'],allow_rules:[]},'automation_schedule',{action:'preview',cron:'* * * * *'}),false);
});
test.after(()=>{db.close();assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-toolset-integration-/);fs.rmSync(root,{recursive:true,force:true});});
