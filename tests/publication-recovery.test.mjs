import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {createDocumentStore} from '../runtime/documents.js';
import {createPublicationService} from '../runtime/document-publications.js';
const hash=v=>createHash('sha256').update(v).digest('hex');
const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
test('committed ingestion and uncertain link reconcile without ingest or stale-source validation',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());
 const documents=createDocumentStore(db),d=documents.create({title:'Unicode π',markdown:'Published content long enough'},'a');
 let ingests=0,writes=0,stale=false,receipt=null,hidden=true;
 const citations={validate:async()=>{if(stale)throw Error('stale');},prepare:async()=>[{source:'actual-source',target:'target',source_fingerprint:'a'.repeat(64),target_fingerprint:'b'.repeat(64),relationship:'explicitly cites',explanation:'Explicit attribution only, not authority.',confidence:1,source_evidence:{quote:'Published source evidence',locator:'line:1'},target_evidence:{quote:'Exact target evidence'}}],
 write:async p=>{writes++;const {request_id,...payload}=p;receipt={request_id,operation:'write_cited_link',record_id:'link-id',payload_hash:hash(canon({operation:'write_cited_link',payload}))};throw Error('output lost');},
 status:async()=>hidden?null:receipt};
 const adapter={publish:async p=>{ingests++;return {request_id:p.requestId,status:'committed',namespace:'nimbus:'+p.installation,source_document_id:p.documentId,revision:p.rev,sha256:p.sha256,previous_revision:null,kb_document_id:9};}};
 const s=createPublicationService({db,documents,adapter,citations}),v=s.preview(d.id,'a');
 assert.equal(v.markdown,documents.exportDoc(d.id,'md','a').buf.toString());
 const i={requestId:randomUUID(),ifRev:v.rev,sha256:v.sha256,audience:v.audience,expectedPublishedRev:null,citations:[{record_id:'target',fingerprint:'b'.repeat(64),quote:'Exact target evidence'}]};
 s.publish(d.id,i,'a');let p=await s.run(d.id,i.requestId,'a');
 assert.equal(p.state,'indexed_links_pending');assert.equal(p.links[0].state,'submitting');
 await s.reconcile(d.id,i.requestId,'a');assert.equal(writes,1);
 hidden=false;stale=true;
 const restarted=createPublicationService({db,documents,adapter,citations});
 p=await restarted.reconcile(d.id,i.requestId,'a');
 assert.equal(p.state,'indexed_retrieval_unverified');assert.equal(ingests,1);assert.equal(writes,1);
 assert.equal(restarted.publish(d.id,i,'a').requestId,i.requestId);
});
