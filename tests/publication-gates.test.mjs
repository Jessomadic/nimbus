import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createDocumentStore} from '../runtime/documents.js';
import {createPublicationService,registerPublicationRoutes} from '../runtime/document-publications.js';
import {createPythonPublicationAdapter} from '../runtime/publication-python.js';
const input=(s,d,citations=[])=>{const v=s.preview(d.id,'alice');return {requestId:randomUUID(),ifRev:v.rev,expectedPublishedRev:v.expectedPublishedRev,sha256:v.sha256,audience:v.audience,citations};};
const receipt=p=>({status:'committed',request_id:p.requestId,namespace:'nimbus:'+p.installation,source_document_id:p.documentId,revision:p.rev,sha256:p.sha256,previous_revision:p.previousPublishedRev,kb_document_id:1});
test('cross-process lease protects live validation and recovers killed validator',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lease-')),file=path.join(dir,'db');
 const db=new DatabaseSync(file);const documents=createDocumentStore(db),d=documents.create({title:'Lease',markdown:'Durable authored text'},'alice');
 let calls=0;const adapter={publish:async p=>{calls++;return receipt(p);}};
 const citations={validate:async()=>{},prepare:async()=>{throw Error('fixture stops before links');}};
 const s=createPublicationService({db,documents,adapter,citations}),i=input(s,d,[{record_id:'target',fingerprint:'b'.repeat(64),quote:'Exact target evidence'}]);s.publish(d.id,i,'alice');
 const source=`import {DatabaseSync} from 'node:sqlite';import {createDocumentStore} from './runtime/documents.js';import {createPublicationService} from './runtime/document-publications.js';const db=new DatabaseSync(process.argv[1]);const s=createPublicationService({db,documents:createDocumentStore(db),adapter:{},citations:{validate:()=>new Promise(()=>{})}});s.run(process.argv[2],process.argv[3],'alice');setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--no-warnings','--input-type=module','-e',source,file,d.id,i.requestId],{cwd:new URL('..',import.meta.url),windowsHide:true,stdio:['ignore','ignore','pipe']});
 let childError='';child.stderr.setEncoding('utf8');child.stderr.on('data',chunk=>{childError=(childError+chunk).slice(-8000);});
 const closed=new Promise(r=>child.on('exit',r));
 t.after(async()=>{child.kill();await closed;db.close();fs.rmSync(dir,{recursive:true,force:true});});
 for(let n=0;n<100&&s.read(d.id,i.requestId,'alice').state!=='validating';n++)await new Promise(r=>setTimeout(r,20));
 assert.equal(s.read(d.id,i.requestId,'alice').state,'validating',`validator exit=${child.exitCode}: ${childError}`);
 await s.reconcile(d.id,i.requestId,'alice');assert.equal(calls,0);
 child.kill();await closed;
 assert.equal((await s.reconcile(d.id,i.requestId,'alice')).state,'indexed_links_pending');assert.equal(calls,1);
});
test('semantic injected target substitution is rejected before overlay write',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());const documents=createDocumentStore(db),d=documents.create({title:'Semantic'},'alice');let writes=0;
 const c={record_id:'target',fingerprint:'b'.repeat(64),quote:'Exact target evidence'};
 const citations={validate:async()=>{},prepare:async()=>[{source:'source',target:'wrong',source_fingerprint:'a'.repeat(64),target_fingerprint:c.fingerprint,relationship:'explicitly cites',confidence:1,explanation:'Explicit attribution only.',source_evidence:{quote:'Exact source evidence'},target_evidence:{quote:c.quote}}],write:async()=>writes++};
 const s=createPublicationService({db,documents,adapter:{publish:async p=>receipt(p)},citations}),i=input(s,d,[c]);s.publish(d.id,i,'alice');
 const p=await s.run(d.id,i.requestId,'alice');assert.match(p.error,/semantic/);assert.equal(writes,0);
});
test('enabled loopback HTTP routes execute real supported companion CLI on isolated home',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'publication-http-'));
 const db=new DatabaseSync(path.join(root,'nimbus.db')),documents=createDocumentStore(db),d=documents.create({title:'Unicode π',markdown:'Exact authored fixture content for publication.'},'alice');
 const inputRoot=path.join(root,'input'),archiveRoot=path.join(root,'archive');fs.mkdirSync(inputRoot);fs.mkdirSync(archiveRoot);
 const adapter=createPythonPublicationAdapter({python:'F:\\Projects\\Lumos\\HermesPilot\\integrations\\knowledge_tools\\.venv\\Scripts\\python.exe',cwd:path.resolve('integration/lumos-brain/knowledge_tools'),db:path.join(root,'knowledge.sqlite3'),inputRoot,archiveRoot});
 const routes=new Map();registerPublicationRoutes({db,documents,adapter,route:(m,p,h)=>routes.set(m+' '+p,h),owner:req=>req.headers['x-fixture-owner'],body:async req=>{let b='';for await(const x of req)b+=x;return JSON.parse(b);},json:(res,status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));}});
 const server=http.createServer(async(req,res)=>{try{
 if(!req.headers['x-fixture-owner']){res.writeHead(401);res.end();return;}
 const parts=req.url.split('/'),id=parts[3],key=parts[5];
 const pattern=key?'/api/documents/:id/publications/:requestId':'/api/documents/:id/'+parts[4];
 await routes.get(req.method+' '+pattern)(req,res,{id,requestId:key});
 }catch(e){res.writeHead(e.code==='not_found'?404:400);res.end(String(e.message));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>server.close(r));db.close();fs.rmSync(root,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port+'/api/documents/'+d.id;
 const get=async(url,owner='alice')=>fetch(url,{headers:{'x-fixture-owner':owner}});
 assert.equal((await fetch(base+'/publication-preview')).status,401);
 assert.equal((await get(base+'/publication-preview','bob')).status,404);
 const v=await (await get(base+'/publication-preview')).json();assert.equal(v.enabled,true);
 const i={requestId:randomUUID(),ifRev:v.rev,expectedPublishedRev:null,sha256:v.sha256,audience:v.audience,citations:[]};
 assert.equal((await fetch(base+'/publish',{method:'POST',headers:{'x-fixture-owner':'alice'},body:JSON.stringify(i)})).status,202);
 let p;for(let n=0;n<150;n++){p=await(await get(base+'/publications/'+i.requestId)).json();if(!['queued','validating','ingesting'].includes(p.state))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(p.state,'indexed_retrieval_unverified',p.error);assert.deepEqual(await adapter.status(i.requestId),p.receipt);
 assert.equal(fs.readFileSync(p.receipt.archive_path,'utf8'),v.markdown);
});
