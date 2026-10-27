// Explicit publication only. No draft/export hooks and no live adapter by default.
import {randomUUID,createHash} from 'node:crypto';
import {DocumentError} from './documents.js';
const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const fail=(code,message)=>{throw new DocumentError(code,message);};
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
export const publicationAudience='Shared Lumos knowledge; authored Nimbus material, not independently validated authority';
export function createPublicationService({db,documents,adapter=null,citations=null}){
 db.exec(`CREATE TABLE IF NOT EXISTS publication_identity(id INTEGER PRIMARY KEY CHECK(id=1),uuid TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS document_publications(request_id TEXT PRIMARY KEY,owner TEXT NOT NULL,doc_id TEXT NOT NULL,payload_hash TEXT NOT NULL,value TEXT NOT NULL);`);
 db.prepare('INSERT OR IGNORE INTO publication_identity VALUES(1,?)').run(randomUUID());
 const installation=db.prepare('SELECT uuid FROM publication_identity WHERE id=1').get().uuid;
 db.exec('CREATE TABLE IF NOT EXISTS publication_execution(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER NOT NULL,token TEXT NOT NULL)');
 // Host-local non-expiring PID lease. Paused processes and reused PIDs fail closed.
 async function leased(id,key,owner,operation){
  read(id,key,owner);
  const token=randomUUID();db.exec('BEGIN IMMEDIATE');
  try{
   const held=db.prepare('SELECT * FROM publication_execution WHERE id=1').get();
   if(held){
    let alive=true;try{process.kill(held.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
    if(alive){db.exec('COMMIT');return read(id,key,owner);}
    db.prepare('DELETE FROM publication_execution WHERE id=1').run();
   }
   db.prepare('INSERT INTO publication_execution VALUES(1,?,?)').run(process.pid,token);
   db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
  try{return await operation();}
  finally{db.prepare('DELETE FROM publication_execution WHERE id=1 AND token=?').run(token);}
 }
 const active=new Set();
 const rows=()=>db.prepare('SELECT * FROM document_publications').all();
 const save=p=>db.prepare('UPDATE document_publications SET value=? WHERE request_id=?').run(JSON.stringify(p),p.requestId);
 const read=(id,requestId,owner)=>{
  documents.get(id,owner);
  const r=db.prepare('SELECT * FROM document_publications WHERE request_id=? AND doc_id=? AND owner=?').get(requestId,id,owner);
  if(!r)fail('not_found','Publication not found');return JSON.parse(r.value);
 };
 const last=id=>rows().filter(r=>r.doc_id===id).map(r=>JSON.parse(r.value)).filter(p=>p.receipt).sort((a,b)=>b.rev-a.rev)[0]?.rev??null;
 function preview(id,owner){
  const d=documents.get(id,owner),markdown=documents.exportDoc(id,'md',owner).buf.toString('utf8');
  if(Buffer.byteLength(markdown)>1000000||d.title.length>500)fail('bad_request','Publication exceeds companion limits');
  return {documentId:id,rev:d.rev,sha256:sha(markdown),markdown,title:d.title,audience:publicationAudience,expectedPublishedRev:last(id),enabled:!!adapter};
 }
 function validate(input){
  if(!input||Object.keys(input).some(k=>!['requestId','ifRev','expectedPublishedRev','sha256','audience','citations'].includes(k)))fail('bad_request','Unknown publication fields');
  if(!uuid(input.requestId)||!Number.isSafeInteger(input.ifRev)||input.ifRev<1||!(input.expectedPublishedRev===null||Number.isSafeInteger(input.expectedPublishedRev)&&input.expectedPublishedRev>0)||!/^[a-f0-9]{64}$/.test(input.sha256)||input.audience!==publicationAudience)fail('bad_request','Exact preview confirmation required');
  if(!Array.isArray(input.citations)||input.citations.length>20)fail('bad_request','At most 20 citations required');
  for(const c of input.citations){
   if(!c||Object.keys(c).some(k=>!['record_id','fingerprint','quote','locator'].includes(k))||typeof c.record_id!=='string'||c.record_id.length<1||c.record_id.length>100||!/^[a-f0-9]{64}$/.test(c.fingerprint)||typeof c.quote!=='string'||c.quote.length<12||c.quote.length>800||c.locator!==undefined&&(typeof c.locator!=='string'||c.locator.length>200))fail('bad_request','Invalid citation');
  }
 }
 // Synchronous capture/guard/insert: no await between draft read and durable snapshot.
 function publish(id,input,owner){
  documents.get(id,owner);validate(input);
  const payloadHash=sha(canonical({id,owner,...input}));
  const existing=db.prepare('SELECT * FROM document_publications WHERE request_id=?').get(input.requestId);
  if(existing){if(existing.owner!==owner||existing.doc_id!==id||existing.payload_hash!==payloadHash)fail('guard_mismatch','Request id payload conflict');return JSON.parse(existing.value);}
  db.exec('BEGIN IMMEDIATE');
  try{
  const concurrent=db.prepare('SELECT * FROM document_publications WHERE request_id=?').get(input.requestId);
  if(concurrent){
   if(concurrent.owner!==owner||concurrent.doc_id!==id||concurrent.payload_hash!==payloadHash)fail('guard_mismatch','Request id payload conflict');
   db.exec('COMMIT');return JSON.parse(concurrent.value);
  }
  const v=preview(id,owner);
  if(v.rev!==input.ifRev||v.sha256!==input.sha256||last(id)!==input.expectedPublishedRev)fail('guard_mismatch','Draft or published revision changed; preview again');
  if(rows().some(r=>['queued','validating','ingesting','needs_reconciliation'].includes(JSON.parse(r.value).state)))fail('guard_mismatch','Installation publication busy; reconcile outstanding request');
  if(!adapter)fail('unavailable','Publication deployment gate: supported adapter not configured');
  if(input.citations.length&&!citations)fail('unavailable','Validated citation adapter not configured');
  const p={requestId:input.requestId,documentId:id,rev:v.rev,sha256:v.sha256,audience:v.audience,owner,installation,payloadHash,input,snapshot:documents.get(id,owner),markdown:v.markdown,state:'queued',previousPublishedRev:input.expectedPublishedRev,createdAt:new Date().toISOString(),reconcileRequired:false};
  db.prepare('INSERT INTO document_publications VALUES(?,?,?,?,?)').run(p.requestId,owner,id,payloadHash,JSON.stringify(p));
  db.exec('COMMIT');return p;
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 function commit(p,r){
  if(r?.status!=='committed'||r.request_id!==p.requestId||r.namespace!=='nimbus:'+installation||r.source_document_id!==p.documentId||r.revision!==p.rev||r.sha256!==p.sha256||r.previous_revision!==p.previousPublishedRev||!Number.isSafeInteger(r.kb_document_id)||r.kb_document_id<1)throw Error('Unmatched or incomplete committed receipt');
  p.receipt=r;p.state=p.input.citations.length?'indexed_links_pending':'indexed_retrieval_unverified';p.reconcileRequired=false;save(p);
 }
 async function runOwned(id,requestId,owner){
  const p=read(id,requestId,owner);
  if(p.state!=='queued')return p; // never blindly repeat a started submission
  active.add(requestId);p.state='validating';save(p);
  try{
   if(p.input.citations.length)await citations.validate(p.input.citations);
  }catch(e){active.delete(requestId);p.state='failed_precommit';p.error=String(e.message).slice(0,1000);save(p);return p;}
  active.delete(requestId);
  p.state='ingesting';save(p); // durable before any external effect
  try{commit(p,await adapter.publish(p));}
  catch(e){p.state='needs_reconciliation';p.reconcileRequired=true;p.error=String(e.message).slice(0,1000);save(p);return p;}
  return linkPhase(p);
 }
 function checkedReceipt(link,r){
  const {request_id,...payload}={...link.payload,request_id:link.requestId};
  if(!r||r.request_id!==request_id||r.operation!=='write_cited_link'||r.payload_hash!==sha(canonical({operation:'write_cited_link',payload}))||!r.record_id)throw Error('Unmatched link receipt');
  return r;
 }
 async function linkPhase(p){
  if(!p.input.citations.length)return p;
  if(active.has(p.requestId))return read(p.documentId,p.requestId,p.owner);
  active.add(p.requestId);
  try{
   if(!citations)throw Error('Citation adapter unavailable');
   if(!p.links){
    await citations.validate(p.input.citations);
    const links=await citations.prepare(p.receipt,p.input.citations);
    if(!Array.isArray(links)||links.length!==p.input.citations.length)throw Error('Incomplete supported link plan');
    links.forEach((link,i)=>{
     const c=p.input.citations[i],keys=['source','target','source_fingerprint','target_fingerprint','relationship','confidence','explanation','source_evidence','target_evidence'];
     const evidence=e=>e&&Object.keys(e).every(k=>['quote','locator'].includes(k))&&typeof e.quote==='string'&&e.quote.length>=12&&e.quote.length<=800&&(e.locator===undefined||typeof e.locator==='string'&&e.locator.length<=200);
     if(!link||Object.keys(link).length!==keys.length||Object.keys(link).some(k=>!keys.includes(k))||
       typeof link.source!=='string'||!link.source.length||link.source.length>100||link.source===link.target||
       link.target!==c.record_id||link.target_fingerprint!==c.fingerprint||!/^[a-f0-9]{64}$/.test(link.source_fingerprint)||
       link.relationship!=='explicitly cites'||link.confidence!==1||
       typeof link.explanation!=='string'||link.explanation.length<12||link.explanation.length>2000||
       !evidence(link.source_evidence)||!evidence(link.target_evidence)||
       link.target_evidence.quote!==c.quote||link.target_evidence.locator!==c.locator)throw Error('Invalid semantic link plan');
    });
    p.links=links.map(payload=>({payload,requestId:'np-'+sha(p.requestId+canonical(payload)),state:'prepared'}));save(p);
   }
   for(const link of p.links){
    if(link.state==='linked')continue;
    const payload={...link.payload,request_id:link.requestId};
    // Readback precedes source validation: committed same-key receipts survive source changes.
    const prior=await citations.status(payload);
    if(prior){link.result=checkedReceipt(link,prior);link.state='linked';save(p);continue;}
    if(link.state==='submitting')throw Error('Unknown link submission; no receipt yet. No blind retry.');
    await citations.validate(p.input.citations);
    link.state='submitting';save(p);
    await citations.write(payload);
    link.result=checkedReceipt(link,await citations.status(payload));link.state='linked';save(p);
   }
   p.state='indexed_retrieval_unverified';delete p.error;save(p);
  }catch(e){p.state='indexed_links_pending';p.error=String(e.message).slice(0,1000);save(p);}
  finally{active.delete(p.requestId);}
  return p;
 }
 async function reconcileOwned(id,requestId,owner){
  const p=read(id,requestId,owner);
  if(p.receipt)return linkPhase(p);
  // Exclusive lease proves no live service executor; validation has no effects.
  if(p.state==='validating'){p.state='queued';save(p);}
  if(p.state==='queued')return runOwned(id,requestId,owner);
  if(!['ingesting','needs_reconciliation'].includes(p.state))return p;
  if(!adapter)fail('unavailable','Adapter unavailable');
  try{const r=await adapter.status(p.requestId);if(r?.status==='committed')commit(p,r);else {p.state='needs_reconciliation';p.reconcileRequired=true;p.error='No committed receipt; does not prove submission stopped. No automatic retry.';save(p);}}
  catch(e){p.error=String(e.message).slice(0,1000);save(p);}
  return p.receipt?linkPhase(p):p;
 }
 const run=(id,key,owner)=>leased(id,key,owner,()=>runOwned(id,key,owner));
 const reconcile=(id,key,owner)=>leased(id,key,owner,()=>reconcileOwned(id,key,owner));
 return {preview,publish,read,run,reconcile};
}
export function registerPublicationRoutes({route,body,json,db,documents,owner,adapter=null,citations=null}){
 const service=createPublicationService({db,documents,adapter,citations});
 route('GET','/api/documents/:id/publication-preview',(req,res,p)=>json(res,200,service.preview(p.id,owner(req))));
 route('POST','/api/documents/:id/publish',async(req,res,p)=>{
  const who=owner(req),publication=service.publish(p.id,await body(req),who);
  json(res,202,publication);void service.run(p.id,publication.requestId,who).catch(()=>{});
 });
 route('GET','/api/documents/:id/publications/:requestId',(req,res,p)=>json(res,200,service.read(p.id,p.requestId,owner(req))));
 route('POST','/api/documents/:id/publications/:requestId/reconcile',async(req,res,p)=>json(res,200,await service.reconcile(p.id,p.requestId,owner(req))));
 return service;
}
