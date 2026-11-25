import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
test('hidden resources retained and all additions invalidate provenance and CLI status',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hidden-regression-'));
 try{
 const src=path.join(root,'src'),out=path.join(root,'out');fs.mkdirSync(path.join(src,'.assets'),{recursive:true});
 fs.writeFileSync(path.join(src,'SKILL.md'),'---\nname: hidden\nprivate_field: synthetic-private\n---\n');
 fs.writeFileSync(path.join(src,'.assets/template.txt'),'template');importSkills(src,out);
 assert.equal(fs.readFileSync(path.join(out,'.assets/template.txt'),'utf8'),'template');
 const run=()=>spawnSync(process.execPath,[path.resolve('bin/skills.mjs'),'verify',out],{encoding:'utf8'});
 assert.equal(run().status,0);
 fs.mkdirSync(path.join(out,'__pycache__'));fs.writeFileSync(path.join(out,'__pycache__/untracked'),'added');
 assert.equal(inspectSkillImport(out).valid,false);const r=run();assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).valid,false);
 const listing=JSON.stringify(discoverSkills([src]));assert.ok(!listing.includes('synthetic-private'));assert.ok(!listing.includes('rawMetadata'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('canonical Unicode case and repeated-space identities agree across discovery and import',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'identity-regression-'));
 try{for(const [dir,name] of [['a',' Demo   Skill '],['b','Ｄｅｍｏ skill']]){fs.mkdirSync(path.join(root,dir));fs.writeFileSync(path.join(root,dir,'SKILL.md'),'---\nname: '+name+'\n---\n');}
 assert.equal(discoverSkills([root]).skills.length,1);assert.throws(()=>importSkills(root,root+'-out'),/identity/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('block paragraphs remain selectable and unknown metadata is not model-facing',()=>{
 const p=skillMetadata('---\nname: block\ndescription: |\n  first\n\n  second\nprivate_field: withheld\n---\n');
 assert.equal(p.metadata.description,'first\n\nsecond\n');assert.equal(p.metadata.private_field,undefined);assert.equal(p.rawMetadata,undefined);
});
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {discoverSkills,importSkills,inspectSkillImport,skillMetadata,skillTree} from '../runtime/skills.js';
test('nested packages preserve resources, provenance, matching and immutable updates',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skills-'));
 try{
 const source=path.join(root,'source'),pkg=path.join(source,'category','example');fs.mkdirSync(path.join(pkg,'scripts'),{recursive:true});
 fs.writeFileSync(path.join(pkg,'SKILL.md'),'---\nname: example\ndescription: >\n  Nested arithmetic\n  helper\n---\nUse scripts/run.txt');
 fs.writeFileSync(path.join(pkg,'scripts/run.txt'),'fixture');
 const result=discoverSkills([source],{query:'arithmetic'});
 assert.equal(result.skills.length,1);assert.equal(result.skills[0].description,'Nested arithmetic helper\n');assert.equal(result.skills[0].resources.length,2);
 const dest=path.join(root,'import');const receipt=importSkills(source,dest);
 assert.equal(receipt.files.length,2);assert.equal(fs.readFileSync(path.join(dest,'category/example/scripts/run.txt'),'utf8'),'fixture');
 assert.throws(()=>importSkills(source,dest),/exists/);
 assert.throws(()=>skillTree(source,{maxDepth:0}),/depth/);
 assert.throws(()=>skillTree(source,{maxFiles:1}),/limit/);
 assert.equal(discoverSkills([source,dest]).warnings.filter(w=>w.reason.startsWith('duplicate')).length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('versioned updates verify provenance and preserve old resources',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-update-'));
 try{
 const src=path.join(root,'source'),v1=path.join(root,'v1'),v2=path.join(root,'v2');
 fs.mkdirSync(src);fs.writeFileSync(path.join(src,'SKILL.md'),'---\nname: demo\n---\nOriginal');
 importSkills(src,v1);
 assert.equal(inspectSkillImport(v1).valid,true);
 fs.writeFileSync(path.join(src,'SKILL.md'),'---\nname: demo\n---\nUpdated');
 importSkills(src,v2,{previous:v1});
 assert.match(fs.readFileSync(path.join(v1,'SKILL.md'),'utf8'),/Original/);
 assert.equal(inspectSkillImport(v2).valid,true);
 fs.writeFileSync(path.join(v1,'extra.txt'),'local edit');
 assert.equal(inspectSkillImport(v1).valid,false);
 assert.throws(()=>importSkills(src,path.join(root,'v3'),{previous:v1}),/modified/);
 assert.throws(()=>importSkills(src,path.join(src,'nested')),/overlap/);
 fs.mkdirSync(path.join(src,'duplicate'));fs.writeFileSync(path.join(src,'duplicate','SKILL.md'),'---\nname: DEMO\n---\n');
 assert.throws(()=>importSkills(src,path.join(root,'dup')),/identity/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('actual imported packages retain hashes and explicit compatibility blockers',()=>{
 const root=path.resolve('data/skills/hermes-installed-20261029');
 assert.ok(fs.existsSync(root),'canonical imported corpus required');
 const verified=inspectSkillImport(root);assert.equal(verified.valid,true,JSON.stringify(verified.issues));
 const result=discoverSkills([root]);
 assert.ok(result.skills.length>=70);
 assert.ok(result.skills.some(s=>s.references.platforms.length||s.references.binaries.length||s.references.tools.length));
 assert.ok(result.skills.some(s=>s.blockers.some(b=>b.includes('Hermes'))));
 assert.ok(result.skills.every(s=>s.readiness!=='ready'));
});
test('metadata does not evaluate YAML tags',()=>assert.ok(skillMetadata('---\nname: x\nmetadata:\n  os: [darwin]\n---\n').warnings.length));
test('symlink roots excluded',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'skill-link-'));try{
 fs.mkdirSync(path.join(root,'real'));fs.writeFileSync(path.join(root,'real','SKILL.md'),'data');
 fs.symlinkSync(path.join(root,'real'),path.join(root,'link'),process.platform==='win32'?'junction':'dir');
 assert.equal(discoverSkills([path.join(root,'link')]).skills.length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
