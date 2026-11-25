
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-installed-contract-')),rt=tmp+'/runtime';
const put=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s);};
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
put(tmp+'/package.json','{"type":"module"}');
for(const f of ['skills.js','helper-readiness.js'])put(rt+'/'+f,fs.readFileSync(new URL('../runtime/'+f,import.meta.url)));
put(tmp+'/deps/module','dependency');put(tmp+'/helper','helper');
const lock={identity:{[tmp+'/helper']:hash(tmp+'/helper')},helper:tmp+'/helper',helperSha256:hash(tmp+'/helper'),dependencyRoot:tmp+'/deps',closure:{module:hash(tmp+'/deps/module')}};
for(const variant of ['private','installed']){
 const root=tmp+'/'+variant+'/pdf';
 put(root+'/SKILL.md','---\nname: pdf-text-stamp-r2\ndescription: text-only fixture\n---\n'+variant+' contract. HERMES_HOME remains reference-only.');
 put(root+'/runtime/environment-manifest.json',JSON.stringify(lock));
 put(rt+'/'+(variant==='private'?'helper-private-package-pins.json':'helper-package-pins.json'),JSON.stringify(['SKILL.md','runtime/environment-manifest.json'].map(relative=>({relative,sha256:hash(root+'/'+relative)}))));
}
const {discoverSkills}=await import(pathToFileURL(rt+'/skills.js'));
const {helperReadiness}=await import(pathToFileURL(rt+'/helper-readiness.js'));
test.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
test('private and installed contracts have truthful distinct messaging without authority',()=>{
 for(const [dir,variant] of [['private','private'],['installed','installed_use']]){
 const selected=discoverSkills([tmp+'/'+dir],{query:'pdf-text-stamp-r2'}).skills[0],r=selected.scopedReadiness;
 assert.equal(r.variant,variant);assert.equal(r.state,'ready_scoped');assert.equal(r.implemented,true);assert.equal(r.dependencyReady,true);
 assert.equal(r.installed,'unverified');assert.equal(r.ordinaryWorkerProof,false);assert.equal(r.executionAuthority,false);assert.equal(r.installationApproved,false);
 assert.equal(selected.broadReadiness,'blocked');assert.ok(!selected.guidance.includes('private overlay'));
 assert.equal(r.limitations.some(s=>s.startsWith('Private author')),variant==='private');
 assert.match(fs.readFileSync(selected.path,'utf8'),new RegExp(dir+' contract'));
 }
});
test('moved installed selection loads same contract and retains root-relative runtime path',()=>{
 fs.cpSync(tmp+'/installed/pdf',tmp+'/moved/skills/pdf',{recursive:true});fs.mkdirSync(tmp+'/moved/skills/pdf/runtime/work',{recursive:true});
 put(tmp+'/moved/skills/pdf/runtime/work/retained-output.txt','owned output is not package content');
 const s=discoverSkills([tmp+'/moved/skills'],{query:'pdf-text-stamp-r2'}).skills[0];
 assert.equal(s.scopedReadiness.variant,'installed_use');assert.equal(s.readiness,'ready_scoped');
 assert.equal(path.dirname(s.path),path.join(tmp,'moved/skills/pdf'));assert.equal(s.scopedReadiness.executionAuthority,false);
 assert.equal(helperReadiness('unrelated-role-skill',s.path),null);
});
test('drift of installed package or dependencies blocks without permission escalation',()=>{
 const p=tmp+'/installed/pdf/SKILL.md',old=fs.readFileSync(p);
 try{fs.appendFileSync(p,'drift');assert.equal(helperReadiness('pdf-text-stamp-r2',p).state,'blocked');}finally{put(p,old);}
 const dep=tmp+'/deps/module';try{put(dep,'drift');const r=helperReadiness('pdf-text-stamp-r2',p);assert.equal(r.state,'blocked');assert.equal(r.executionAuthority,false);}finally{put(dep,'dependency');}
 assert.equal(helperReadiness('pdf-text-stamp-r2',p).variant,'installed_use');
});
