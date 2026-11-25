import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDocumentStore,exportName} from '../runtime/documents.js';
import {workspaceDownload} from '../runtime/download-path.js';
import {download,downloadFilename,installDownloads} from '../public/downloads.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('lazy isolated store, owner denial, revision/hash guards and atomic rollback',()=>{
  const db=new DatabaseSync(':memory:');try{
    const s=createDocumentStore(db);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='live_documents'").get().n,0);
    const d=s.create({title:'Report, final!',markdown:'original'},'alice'),b=d.blocks[0];
    assert.throws(()=>s.get(d.id,'bob'),e=>e.code==='not_found');
    assert.throws(()=>s.apply(d.id,{ifRev:1,ops:[{op:'delete',id:b.id,ifHash:'bad'}]},'alice'),e=>e.code==='guard_mismatch');
    assert.throws(()=>s.apply(d.id,{ifRev:1,ops:[{op:'replace',id:b.id,ifHash:b.hash,markdown:'new'},{op:'delete',id:'absent',ifHash:'bad'}]},'alice'));
    assert.deepEqual(s.get(d.id,'alice'),d);
    const next=s.apply(d.id,{ifRev:1,ops:[{op:'replace',id:b.id,ifHash:b.hash,markdown:'new'}]},'alice');
    assert.equal(next.rev,2);assert.notEqual(next.blocks[0].hash,b.hash);
    assert.throws(()=>s.apply(d.id,{ifRev:1,ops:[]},'alice'),e=>e.code==='guard_mismatch');
    assert.equal(s.versions(d.id,'alice').length,2);
    assert.equal(s.exportDoc(d.id,'md','alice').name,'Report, final!.md');
    for(const format of ['docx','pdf'])assert.throws(()=>s.exportDoc(d.id,format,'alice'),e=>e.code==='unavailable'&&e.statusCode===503);
  }finally{db.close();}
});
test('safe Windows names and malformed download filename fallback',()=>{
  assert.equal(exportName('CON'),'_CON');assert.equal(exportName('Report, final!'),'Report, final!');
  assert.equal(exportName('...'),'document');
  assert.equal(downloadFilename("attachment; filename*=UTF-8''R%C3%A9sum%C3%A9.md"),'Résumé.md');
  assert.equal(downloadFilename("attachment; filename*=UTF-8''%ZZ",'fallback'),'fallback');
});
test('workspace download rejects traversal, sibling prefix and junction escapes',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-download-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const root=path.join(dir,'root'),other=path.join(dir,'root-other');fs.mkdirSync(root);fs.mkdirSync(other);
  fs.writeFileSync(path.join(root,'ok'),'ok');fs.writeFileSync(path.join(other,'secret'),'secret');
  assert.equal(workspaceDownload(root,'ok'),fs.realpathSync(path.join(root,'ok')));
  for(const file of ['../root-other/secret','missing','.',other])assert.equal(workspaceDownload(root,file),null);
  fs.symlinkSync(other,path.join(root,'outside'),process.platform==='win32'?'junction':'dir');
  assert.equal(workspaceDownload(root,'outside/secret'),null);
});
test('download errors and authentication never produce a successful save',async()=>{
  for(const status of [401,403,500]){
    const errors=[],location={href:'http://localhost/',origin:'http://localhost'};
    await download('/file','file',{location,fetch:async()=>({ok:false,status,json:async()=>({error:'denied'})}),report:m=>errors.push(m)});
    if(status===401){assert.equal(location.href,'/login');assert.deepEqual(errors,[]);}else assert.deepEqual(errors,['denied']);
  }
});
test('same-click download listener stops subsequent document/menu listeners, ignoring blob recursion',()=>{
  let handler,stopped=false;
  installDownloads({document:{addEventListener:(_,fn)=>{handler=fn;}}});
  handler({target:{closest:()=>({href:'blob:test'})}});
  handler({target:{closest:()=>({href:'https://example.com/',getAttribute:()=>''})},preventDefault(){},stopImmediatePropagation(){stopped=true;}});
  assert.equal(stopped,true);
});
