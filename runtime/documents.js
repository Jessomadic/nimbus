// Safe API-only subset of upstream 9ea4785; no application DB import or provider hooks.
import {randomUUID,createHash} from 'node:crypto';
export class DocumentError extends Error {
  constructor(code,message){super(message);this.code=code;this.statusCode=({not_found:404,guard_mismatch:409,unavailable:503})[code]||400;}
}
const fail=(code,message)=>{throw new DocumentError(code,message);};
const text=(v,max=100000)=>{if(typeof v!=='string'||Buffer.byteLength(v)>max)fail('bad_request','Expected bounded text');return v;};
const hash=md=>createHash('sha256').update(md).digest('hex');
const block=markdown=>({id:randomUUID(),markdown,hash:hash(markdown)});
export function exportName(title){
  let name=Array.from(String(title).toWellFormed().replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g,'')).slice(0,80).join('').replace(/[. ]+$/g,'').trim()||'document';
  if(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))name='_'+name;
  return name;
}
export function createDocumentStore(db){
  let initialized=false;
  function init(){if(initialized)return;db.exec(`CREATE TABLE IF NOT EXISTS live_documents(id TEXT PRIMARY KEY,owner TEXT NOT NULL,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_document_versions(doc_id TEXT NOT NULL,rev INTEGER NOT NULL,value TEXT NOT NULL,PRIMARY KEY(doc_id,rev));`);initialized=true;}
  const q=sql=>{init();return db.prepare(sql);};
  function get(id,owner){const row=q('SELECT value FROM live_documents WHERE id=? AND owner=?').get(String(id),String(owner));if(!row)fail('not_found','Document not found');return JSON.parse(row.value);}
  function save(doc,owner,create=false){
    text(doc.title,800);
    if(doc.blocks.length>2000||Buffer.byteLength(JSON.stringify(doc))>500000)fail('too_large','Document exceeds limit');
    init();db.exec('SAVEPOINT live_document_write');
    try{
      if(create)q('INSERT INTO live_documents VALUES(?,?,?)').run(doc.id,String(owner),JSON.stringify(doc));
      else q('UPDATE live_documents SET value=? WHERE id=? AND owner=?').run(JSON.stringify(doc),doc.id,String(owner));
      q('INSERT INTO live_document_versions VALUES(?,?,?)').run(doc.id,doc.rev,JSON.stringify(doc));
      q('DELETE FROM live_document_versions WHERE doc_id=? AND rev<? AND rev<>1').run(doc.id,doc.rev-299);
      db.exec('RELEASE live_document_write');return doc;
    }catch(error){db.exec('ROLLBACK TO live_document_write; RELEASE live_document_write');throw error;}
  }
  function create({title='Untitled',markdown=''}={},owner){
    text(title,800);text(markdown,400000);
    return save({id:randomUUID(),title,rev:1,blocks:markdown?[block(markdown)]:[]},owner,true);
  }
  function apply(id,{ifRev,ops,title}={},owner){
    const doc=get(id,owner);
    if(!Number.isSafeInteger(ifRev)||ifRev<1)fail('bad_request','ifRev is required');
    if(ifRev!==doc.rev)fail('guard_mismatch','Document changed; read it again');
    if(!Array.isArray(ops)||ops.length>50||Buffer.byteLength(JSON.stringify(ops))>400000)fail('bad_request','Send at most 50 bounded operations');
    if(title!==undefined)doc.title=text(title,800);
    for(const op of ops){
      if(!op||typeof op!=='object')fail('bad_request','Invalid operation');
      if(op.op==='insert'){
        const at=op.after===null?-1:doc.blocks.findIndex(b=>b.id===op.after);
        if(op.after!==null&&at<0)fail('bad_request','Insert anchor not found');
        doc.blocks.splice(at+1,0,block(text(op.markdown)));continue;
      }
      const index=doc.blocks.findIndex(b=>b.id===op.id),old=doc.blocks[index];
      if(!old)fail('bad_request','Block not found');
      if(typeof op.ifHash!=='string'||op.ifHash!==old.hash)fail('guard_mismatch','Block hash changed or missing');
      if(op.op==='replace'){old.markdown=text(op.markdown);old.hash=hash(old.markdown);}
      else if(op.op==='delete')doc.blocks.splice(index,1);
      else if(op.op==='move'){
        if(op.after===op.id)fail('bad_request','Cannot move after itself');
        doc.blocks.splice(index,1);
        const at=op.after===null?-1:doc.blocks.findIndex(b=>b.id===op.after);
        if(op.after!==null&&at<0)fail('bad_request','Move anchor not found');
        doc.blocks.splice(at+1,0,old);
      }else fail('bad_request','Unknown operation');
    }
    doc.rev++;return save(doc,owner);
  }
  function versions(id,owner){get(id,owner);return q('SELECT rev FROM live_document_versions WHERE doc_id=? ORDER BY rev DESC LIMIT 300').all(String(id));}
  function exportDoc(id,format,owner){
    const doc=get(id,owner);
    if(!['md','docx','pdf'].includes(format))fail('bad_request','Unknown export format');
    if(format!=='md')fail('unavailable','Binary rendering is not enabled in this Windows port; export Markdown. No Office dependencies are assumed installed.');
    return {name:exportName(doc.title)+'.md',type:'text/markdown; charset=utf-8',buf:Buffer.from('# '+doc.title+'\n\n'+doc.blocks.map(b=>b.markdown).join('\n\n')+'\n')};
  }
  return {get,create,apply,versions,exportDoc};
}
// server.js checks authentication, HTTPS and same origin before dispatching these routes.
// Deliberately no /api/hook endpoints, agent calls or permission bypasses.
export function registerDocumentRoutes({route,body,json,db}){
  const store=createDocumentStore(db),owner=req=>req.user?.email ? 'email:'+req.user.email.trim().toLowerCase() : req.user?.username ? 'username:'+req.user.username : 'local-admin';
  route('POST','/api/documents',async(req,res)=>json(res,200,store.create(await body(req),owner(req))));
  route('GET','/api/documents/:id',(req,res,p)=>json(res,200,store.get(p.id,owner(req))));
  route('POST','/api/documents/:id/ops',async(req,res,p)=>json(res,200,store.apply(p.id,await body(req),owner(req))));
  route('GET','/api/documents/:id/versions',(req,res,p)=>json(res,200,store.versions(p.id,owner(req))));
  route('GET','/api/documents/:id/export',(req,res,p,url)=>{
    const out=store.exportDoc(p.id,url.searchParams.get('format')||'md',owner(req));
    res.writeHead(200,{'content-type':out.type,'content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(out.name),'cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(out.buf);
  });
}
