
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
test('unchanged core role selection distinguishes execution-capable and read-only skill roles',()=>{
 // Evaluate only declarative core profiles, replacing specialist enumeration with no extra tools.
 // This avoids importing runtime/database/connectors and does not simulate host grants.
 let source=fs.readFileSync(new URL('../runtime/roles.js',import.meta.url),'utf8');
 source=source.replace(/^import .*;\r?\n/,'const specialistToolNames=()=>[];\n').replaceAll('export const ','const ').replaceAll('export function ','function ');
 const profiles=vm.runInNewContext(source+';ROLE_PROFILES');
 const builder=profiles.find(p=>p.id==='builder'),writer=profiles.find(p=>p.id==='researcher'),coord=profiles.find(p=>p.id==='orchestrator');
 assert.ok(builder);assert.ok(writer);assert.ok(coord);
 for(const tool of ['skills','read_file','exec_command'])assert.ok(builder.tools.includes(tool),tool);
 for(const tool of ['skills','read_file'])assert.ok(writer.tools.includes(tool),tool);
 assert.equal(writer.tools.includes('exec_command'),false);
 assert.equal(coord.tools.includes('skills'),false);
 const tools=fs.readFileSync(new URL('../runtime/tools.js',import.meta.url),'utf8');
 assert.match(tools,/coreTools.filter\(t => allowed.has\(t.function.name\)/);
 assert.match(tools,/listSkills\(\[path.join\(ROOT,'skills'\),path.join\(DATA_DIR,'skills'\)\],args\)/);
});
