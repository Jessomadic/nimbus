import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createDocumentStore} from '../runtime/documents.js';
import {createPublicationService} from '../runtime/document-publications.js';

const sha=v=>createHash('sha256').update(v).digest('hex');
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
test('real Python canonical optional locator passes; forged and mismatched locators fail',async()=>{
 // Existing fixture runs the real bridge/overlay API with isolated Reader/storage.
 // No live BrainData, ingestion, credentials or production writes.
 const fixture=fileURLToPath(new URL('./publication-brain-fixture.py',import.meta.url));
 const python=process.env.PUBLICATION_TEST_PYTHON||'F:/Projects/Lumos/HermesPilot/integrations/knowledge_tools/.venv/Scripts/python.exe';
 const brain=process.env.PUBLICATION_TEST_BRAIN_ROOT||'F:/Projects/Lumos/HermesPilot/brain_viewer';
 const script='import runpy,json,sys; sys.argv=[sys.argv[1],sys.argv[2]]; v=runpy.run_path(sys.argv[0]); print(json.dumps({"citation":v["c"],"links":v["links"]}))';
 const py=spawnSync(python,['-c',script,fixture,brain],{encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
 assert.equal(py.status,0,py.error?.message||py.stderr);
 const prepared=JSON.parse(py.stdout.trim().split(/\r?\n/).at(-1));
 assert.equal(Object.hasOwn(prepared.citation,'locator'),false);
 assert.equal(prepared.links[0].target_evidence.locator,'');
 assert.equal(prepared.links[0].source_evidence.locator,'line:1');
 async function run(c,mutate=()=>{}){
  const db=new DatabaseSync(':memory:');
  try{
   const documents=createDocumentStore(db),d=documents.create({title:'Locator regression',markdown:'Authored isolated fixture evidence.'},'owner');
   let writes=0,receipt=null;
   const links=structuredClone(prepared.links);mutate(links[0]);
   const adapter={publish:async p=>({status:'committed',request_id:p.requestId,namespace:'nimbus:'+p.installation,source_document_id:p.documentId,revision:p.rev,sha256:p.sha256,previous_revision:null,kb_document_id:9})};
   const citations={validate:async()=>{},prepare:async()=>links,status:async()=>receipt,write:async p=>{
    writes++;const {request_id,...payload}=p;
    receipt={request_id,operation:'write_cited_link',record_id:'isolated-link',payload_hash:sha(canonical({operation:'write_cited_link',payload}))};
   }};
   const s=createPublicationService({db,documents,adapter,citations}),v=s.preview(d.id,'owner');
   const input={requestId:randomUUID(),ifRev:v.rev,expectedPublishedRev:null,sha256:v.sha256,audience:v.audience,citations:[c]};
   s.publish(d.id,input,'owner');
   return {p:await s.run(d.id,input.requestId,'owner'),writes};
  }finally{db.close();}
 }
 const omitted=await run(prepared.citation),empty=await run({...prepared.citation,locator:''});
 for(const result of [omitted,empty]){
  assert.equal(result.p.state,'indexed_retrieval_unverified');assert.equal(result.p.error,undefined);assert.equal(result.writes,1);
 }
 assert.deepEqual(omitted.p.links[0].payload,empty.p.links[0].payload);
 const negatives=[
  [{...prepared.citation,locator:'line:forged'},()=>{}],
  [prepared.citation,link=>{link.target_evidence.locator='line:forged';}],
  [prepared.citation,link=>{link.target_evidence.quote='Forged evidence quote.';}],
  [prepared.citation,link=>{link.target_fingerprint='f'.repeat(64);}],
  [prepared.citation,link=>{link.relationship='supports';}],
  [prepared.citation,link=>{link.confidence=0.5;}],
 ];
 for(const [citation,mutate] of negatives){
  const result=await run(citation,mutate);
  assert.equal(result.p.state,'indexed_links_pending');assert.equal(result.p.error,'Invalid semantic link plan');assert.equal(result.writes,0);
 }
});
