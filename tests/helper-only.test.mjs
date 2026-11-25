import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import os from 'node:os';import {pathToFileURL,fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-compose-'));
const pkg=path.join(temp,'skills/pdf'),runtime=path.join(temp,'runtime'),dep=path.join(temp,'deps/module');
const put=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
put(temp+'/package.json','{"type":"module"}');
for(const f of ['skills.js','helper-readiness.js'])put(runtime+'/'+f,fs.readFileSync(new URL('../runtime/'+f,import.meta.url)));
put(pkg+'/SKILL.md','---\nname: pdf-text-stamp-r2\ndescription: fixture\n---\nSynthetic fixture only. HERMES_HOME adapter remains blocked.');
put(pkg+'/LICENSE','fixture');put(dep,'dependency');put(temp+'/helper','helper');
put(pkg+'/runtime/environment-manifest.json',JSON.stringify({identity:{[temp+'/helper']:hash(temp+'/helper')},helper:temp+'/helper',helperSha256:hash(temp+'/helper'),dependencyRoot:path.dirname(dep),closure:{module:hash(dep)}}));
put(runtime+'/helper-package-pins.json',JSON.stringify(['SKILL.md','LICENSE','runtime/environment-manifest.json'].map(relative=>({relative,sha256:hash(pkg+'/'+relative)}))));
put(runtime+'/helper-private-package-pins.json',fs.readFileSync(runtime+'/helper-package-pins.json'));
const {discoverSkills}=await import(pathToFileURL(runtime+'/skills.js'));
const {helperReadiness}=await import(pathToFileURL(runtime+'/helper-readiness.js'));
test.after(()=>fs.rmSync(temp,{recursive:true,force:true}));

test('helper-only relocated discovery denies execution and installation authority',()=>{
 const found=discoverSkills([path.dirname(pkg)],{query:'pdf-text-stamp-r2'}).skills.find(s=>s.name==='pdf-text-stamp-r2');
 assert.ok(found);assert.equal(found.readiness,'ready_scoped');assert.equal(found.broadReadiness,'blocked');
 assert.equal(found.scopedReadiness.executionAuthority,false);assert.equal(found.scopedReadiness.installationApproved,false);
 assert.equal(helperReadiness('unrelated',pkg+'/SKILL.md'),null);
});
test('helper-only relocated discovery fails closed on changed package',()=>{
 const root=pathToFileURL(temp+'/changed/');fs.mkdirSync(root,{recursive:true});
 const dest=new URL('pdf/',root);fs.cpSync(pkg,dest,{recursive:true});
 fs.appendFileSync(new URL('LICENSE',dest),'composed-change');
 const found=discoverSkills([fileURLToPath(root)],{query:'pdf-text-stamp-r2'}).skills[0];
 assert.ok(found);assert.equal(found.readiness,'blocked');assert.equal(found.scopedReadiness.executionAuthority,false);
});
test('helper-only imports remain portable and broad admission blocked',()=>{
 const skills=fs.readFileSync(new URL('../runtime/skills.js',import.meta.url),'utf8');
 assert.match(skills,/helper-readiness.js/);
 const ready=helperReadiness('pdf-text-stamp-r2',pkg+'/SKILL.md');
 assert.equal(ready.state,'ready_scoped');assert.ok(ready.limitations.some(x=>x.includes('Broad PDF/image')));
});

test('dependency mismatch fails closed',()=>{try{put(dep,'mismatch');assert.equal(helperReadiness('pdf-text-stamp-r2',pkg+'/SKILL.md').state,'blocked');}finally{put(dep,'dependency');}});
test('malformed environment fails closed',()=>{const p=pkg+'/runtime/environment-manifest.json',before=fs.readFileSync(p);try{put(p,'{');assert.equal(helperReadiness('pdf-text-stamp-r2',pkg+'/SKILL.md').state,'blocked');}finally{put(p,before);}});
