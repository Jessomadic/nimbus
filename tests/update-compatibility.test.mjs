import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createDocumentStore,registerDocumentRoutes,exportName} from '../runtime/documents.js';
test('startup registration is schema-free; legacy owners remain isolated and publication defaults disabled',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const routes=new Map();registerDocumentRoutes({db,route:(m,p,f)=>routes.set(m+' '+p,f),body:async r=>r.input,json:(_r,_s,v)=>v});
 assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),[]);
 const old=createDocumentStore(db),user={email:'Alice@Example.com',role:'owner'};
 const local=old.create({title:'Local'},JSON.stringify({localAdmin:true}));
 const doc=old.create({title:'Legacy',markdown:'Preserve me'},JSON.stringify(user));
 const get=(id,who)=>routes.get('GET /api/documents/:id')({user:who},{},{id});
 assert.equal(get(doc.id,user).title,'Legacy');assert.equal(get(local.id,undefined).title,'Local');
 assert.throws(()=>get(doc.id,{email:'alice@example.com',role:'owner'}),/not found/);
 assert.throws(()=>get(doc.id,{email:'Bob@example.com',role:'owner'}),/not found/);
 const preview=routes.get('GET /api/documents/:id/publication-preview')({user},{},{id:doc.id});
 assert.equal(preview.enabled,false);
 assert.equal(db.prepare('SELECT owner FROM live_documents WHERE id=?').get(doc.id).owner,JSON.stringify(user));
 const edited=await routes.get('POST /api/documents/:id/ops')({user,input:{ifRev:1,ops:[],title:'Still owned'}},{},{id:doc.id});
 assert.equal(edited.rev,2);assert.equal(get(doc.id,user).title,'Still owned');
 assert.equal(routes.get('GET /api/documents/:id/versions')({user},{},{id:doc.id}).length,2);
});
test('Unicode filename truncation never splits surrogate pairs',()=>{
 assert.equal(exportName('😀'.repeat(100)),'😀'.repeat(80));
 assert.equal(exportName('\ud800x'),'�x');
});
