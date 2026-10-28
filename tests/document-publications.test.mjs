import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {createDocumentStore,registerDocumentRoutes} from '../runtime/documents.js';
import {createPublicationService} from '../runtime/document-publications.js';
function fixture(t,options={}){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const documents=createDocumentStore(db),doc=documents.create({title:'Source',markdown:'Actual authored content'},'alice');
 let calls=0;
 const adapter={publish:async p=>{calls++;return {status:'committed',request_id:p.requestId,namespace:'nimbus:'+p.installation,source_document_id:p.documentId,revision:p.rev,sha256:p.sha256,previous_revision:p.previousPublishedRev,kb_document_id:9};},status:async()=>({status:'not_committed'})};
 const s=createPublicationService({db,documents,adapter,...options});
 const input=()=>{const p=s.preview(doc.id,'alice');return {requestId:randomUUID(),ifRev:p.rev,expectedPublishedRev:p.expectedPublishedRev,sha256:p.sha256,audience:p.audience,citations:[]};};
 return {db,documents,doc,s,input,calls:()=>calls};
}
test('drafts/exports never publish; preview owner isolation, exact capture and idempotency',async t=>{
 const f=fixture(t);f.documents.exportDoc(f.doc.id,'md','alice');assert.equal(f.calls(),0);
 assert.throws(()=>f.s.preview(f.doc.id,'bob'),/not found/);
 const i=f.input();const p=f.s.publish(f.doc.id,i,'alice');
 assert.equal(f.s.publish(f.doc.id,i,'alice').payloadHash,p.payloadHash);
 assert.throws(()=>f.s.publish(f.doc.id,{...i,sha256:'a'.repeat(64)},'alice'),/conflict/);
 f.documents.apply(f.doc.id,{ifRev:1,ops:[],title:'Changed'},'alice');
 await f.s.run(f.doc.id,p.requestId,'alice');assert.equal(f.calls(),1);
 const r=f.s.read(f.doc.id,p.requestId,'alice');assert.equal(r.snapshot.title,'Source');assert.equal(r.rev,1);assert.equal(r.state,'indexed_retrieval_unverified');
 await f.s.run(f.doc.id,p.requestId,'alice');assert.equal(f.calls(),1);
 assert.throws(()=>f.s.read(f.doc.id,p.requestId,'bob'),/not found/);
});
test('stale draft/publication, unknown path and busy rejected before effects',async t=>{
 const f=fixture(t),i=f.input();
 assert.throws(()=>f.s.publish(f.doc.id,{...i,ifRev:2},'alice'),/changed/);
 assert.throws(()=>f.s.publish(f.doc.id,{...i,expectedPublishedRev:1},'alice'),/changed/);
 assert.throws(()=>f.s.publish(f.doc.id,{...i,markdown_path:'C:\\evil'},'alice'),/Unknown/);
 f.s.publish(f.doc.id,i,'alice');assert.throws(()=>f.s.publish(f.doc.id,f.input(),'alice'),/busy/);assert.equal(f.calls(),0);
});
test('unknown adapter effect is durable, blocks replay and reconciles only by receipt',async t=>{
 let count=0;
 const f=fixture(t,{adapter:{publish:async()=>{count++;throw Error('lost output');},status:async()=>({status:'not_committed'})}});
 const i=f.input();f.s.publish(f.doc.id,i,'alice');await f.s.run(f.doc.id,i.requestId,'alice');
 assert.equal(f.s.read(f.doc.id,i.requestId,'alice').state,'needs_reconciliation');
 await f.s.run(f.doc.id,i.requestId,'alice');await f.s.reconcile(f.doc.id,i.requestId,'alice');assert.equal(count,1);
 assert.equal(f.s.preview(f.doc.id,'alice').expectedPublishedRev,null);
});
test('citation prevalidation blocks ingestion; postcommit linking failure preserves indexed receipt',async t=>{
 const f=fixture(t,{citations:{validate:async()=>{},prepare:async()=>{throw Error('Brain provenance unavailable');}}});
 const i={...f.input(),citations:[{record_id:'real-fixture',fingerprint:'a'.repeat(64),quote:'fixture quote only'}]};
 f.s.publish(f.doc.id,i,'alice');const p=await f.s.run(f.doc.id,i.requestId,'alice');
 assert.equal(p.state,'indexed_links_pending');assert.equal(p.receipt.kb_document_id,9);
 await f.s.run(f.doc.id,i.requestId,'alice');assert.equal(f.calls(),1);
 assert.equal(f.s.preview(f.doc.id,'alice').expectedPublishedRev,1);
 const g=fixture(t,{citations:{validate:async()=>{throw Error('stale');}}});
 const j={...g.input(),citations:i.citations};g.s.publish(g.doc.id,j,'alice');assert.equal((await g.s.run(g.doc.id,j.requestId,'alice')).state,'failed_precommit');assert.equal(g.calls(),0);
});
test('routes expose preview/status but production publish is explicitly gated',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const routes=new Map();
 registerDocumentRoutes({db,route:(m,p,h)=>routes.set(m+' '+p,h),body:async r=>r.input,json:(r,status,data)=>Object.assign(r,{status,data})});
 const req={user:{email:'alice@example.invalid'},input:{title:'Draft'}};let res={};
 await routes.get('POST /api/documents')(req,res);const id=res.data.id;res={};
 routes.get('GET /api/documents/:id/publication-preview')(req,res,{id});assert.equal(res.data.enabled,false);
 const p=res.data;req.input={requestId:randomUUID(),ifRev:p.rev,expectedPublishedRev:null,sha256:p.sha256,audience:p.audience,citations:[]};
 await assert.rejects(()=>routes.get('POST /api/documents/:id/publish')(req,{}, {id}),/deployment gate/);
});
