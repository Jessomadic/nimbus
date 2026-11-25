import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';import {Maintenance} from '../runtime/maintenance.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const pins={"surfaces.mjs":"cae0ad542e9f90fd0063a23668abcbb8f66be4d9e35d215d94a5dee53d4fc4fd","http-route.mjs":"a21b9c93864543ac6f003075beade9e5a8de9679549530fe16e03b0511c12e34","recall.mjs":"814438adc0eb79386c0dc7aeacbb413548aac6eb4da15b1b9105dec8034cfa9e","routing.mjs":"4a9e930a91b1ac4b22b1edd0cc7b6fc19863751b5a00e61567dbc9133f0fcfe2","server-composition.mjs":"5fd61a442e9ac631301fdd01280b66833355bd759e9e5943dd9f60486837685e","session-adapter.mjs":"077296638511066c05f9acc02377b6ee56a0743a2004d58ab62969febf074a21","worker-binding.mjs":"e4668e96b99f520384863b1f78fae457d33e4604a8e1bd29995fa0318926fc24"};
test('production inventory includes all exact memory pins and active imports use runtime',()=>{
 const inv=new Maintenance({root,dataDir:path.join(root,'data')}).inventory();
 for(const [name,sha]of Object.entries(pins))assert.equal(inv.files['runtime/memory-private/'+name],sha);
 assert.ok(inv.files['tests/memory-runtime-inventory.test.mjs']);
 for(const name of ['server.js','runtime/tools.js'])assert.ok(!fs.readFileSync(path.join(root,name),'utf8').includes('lib/memory-private'));
});
test('isolated nested edits change inventory, snapshot copies and restore removes only candidate source',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-inventory-'));const src=path.join(tmp,'source'),data=path.join(tmp,'data');
 fs.mkdirSync(path.join(src,'runtime/memory-private'),{recursive:true});
 for(const name of Object.keys(pins))fs.copyFileSync(path.join(root,'runtime/memory-private',name),path.join(src,'runtime/memory-private',name));
 fs.mkdirSync(path.join(src,'untracked'));fs.writeFileSync(path.join(src,'untracked/retained'),'keep');
 const m=new Maintenance({root:src,dataDir:data});const base=m.inventory();const snap=m.snapshot();
 for(const name of Object.keys(pins)){const f=path.join(src,'runtime/memory-private',name);const bytes=fs.readFileSync(f);assert.deepEqual(fs.readFileSync(path.join(data,'updates',snap.id,'source/runtime/memory-private',name)),bytes);fs.appendFileSync(f,'\n// mutation');assert.notEqual(m.inventory().hash,base.hash);fs.writeFileSync(f,bytes);}
 fs.writeFileSync(path.join(src,'runtime/memory-private/candidate.mjs'),'export const candidate=true;');fs.appendFileSync(path.join(src,'runtime/memory-private/recall.mjs'),'\n// edit');
 const receipt=m.load(snap.id);receipt.candidate=m.inventory();m.save(receipt);m.restore(snap.id);
 assert.equal(m.inventory().hash,base.hash);assert.ok(!fs.existsSync(path.join(src,'runtime/memory-private/candidate.mjs')));assert.equal(fs.readFileSync(path.join(src,'untracked/retained'),'utf8'),'keep');
});
test('isolated invalid nested mjs is rejected by actual Maintenance validation',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'memory-invalid-'));const src=path.join(tmp,'source');fs.mkdirSync(path.join(src,'runtime/memory-private'),{recursive:true});fs.mkdirSync(path.join(src,'tests'));
 fs.writeFileSync(path.join(src,'tests/ok.test.mjs'),"import {test} from 'node:test';test('ok',()=>{});");
 const m=new Maintenance({root:src,dataDir:path.join(tmp,'data')});const snap=m.snapshot();fs.writeFileSync(path.join(src,'runtime/memory-private/broken.mjs'),'export const = ;');
 await assert.rejects(m.validate(snap.id));const receipt=m.load(snap.id);assert.equal(receipt.state,'validation_failed');assert.ok(!receipt.validatedHash);
});
