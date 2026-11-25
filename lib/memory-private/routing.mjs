import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createRecallBinding} from './recall.mjs';
const root='F:/Nimbus/data/projects/hermes-capability-parity/memory-transfer-20261112/archive/';
const surfaces=Object.freeze({
 brain:['home/memory_store.db','facts','fact_id','content'],
 archive:['integrations/openhuman_memory/memory.db','memory_docs','document_id','content'],
 sessions:['home/state.db','messages','id','content'],
 relationships:['home/state/brain-links/links.sqlite3','links','id','payload'],
 chunks:['integrations/openhuman_memory/chunks.db','mem_tree_chunks','id','content']
});
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Error(code)};
const bound=(v,d,max)=>{v??=d;if(!Number.isInteger(v)||v<0||v>max)fail('INVALID_ARGUMENTS');return v;};
// resolvePrincipal is a host-only authenticated-session resolver, never a tool argument.
// All routes fail closed before any filesystem access. No write/learning dispatch exists.
export function createPrivateRouter({resolvePrincipal,authorize,pins}){
 if(typeof resolvePrincipal!=='function'||typeof authorize!=='function'||!pins)fail('INVALID_CONFIGURATION');
 const attachment=createRecallBinding(authorize);
 return function invoke(session,operation,args={}){
  let principal;
  try {principal=resolvePrincipal(session);if(!principal||authorize(principal,'memory:read')!==true)fail('FORBIDDEN');}
  catch {fail('FORBIDDEN');}
  if(!['recall','search','get'].includes(operation))fail('OPERATION_DISABLED');
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['surface','query','id','offset','limit','textOffset','textLimit'].includes(k)))fail('INVALID_ARGUMENTS');
  const {surface,query,id}=args;
  if(surface!=='attachment'&&!Object.hasOwn(surfaces,surface))fail('INVALID_ARGUMENTS');
  const offset=bound(args.offset,0,1000000),limit=bound(args.limit,8,20);
  const textOffset=bound(args.textOffset,0,10000000),textLimit=bound(args.textLimit,512,2048);
  if(limit<1||textLimit<1)fail('INVALID_ARGUMENTS');
  if(operation!=='get'&&(typeof query!=='string'||!query.trim()||query.length>256))fail('INVALID_ARGUMENTS');
  if(operation==='get'&&(typeof id!=='string'||!id||id.length>256))fail('INVALID_ARGUMENTS');
  try {
   if(surface==='attachment'){
    if(args.offset!==undefined&&args.textOffset!==undefined)fail('INVALID_ARGUMENTS');
    return attachment(principal,operation==='get'?'get':'search',{...(operation==='get'?{id}:{query}),...(args.textOffset!==undefined?{textOffset}:{offset}),limit:textLimit});
   }
   if(authorize(principal,'memory:'+surface+':read')!==true)fail('FORBIDDEN');
   const [relative,table,key,body]=surfaces[surface],path=root+relative;
   if(!pins[relative]||digest(fs.readFileSync(path))!==pins[relative])fail('STORE_UNAVAILABLE');
   const db=new DatabaseSync(path,{readOnly:true});
   try {
    const where=operation==='get'? 'CAST('+key+' AS TEXT)=?':'instr(lower('+body+'),lower(?))>0';
    const privacy=surface==='archive'?" AND namespace != 'conversation_raw'":'';
    const rows=db.prepare('SELECT CAST('+key+' AS TEXT) AS id, '+body+' AS text FROM '+table+' WHERE '+where+privacy+' ORDER BY '+key+' LIMIT ? OFFSET ?').all(operation==='get'?id:query,limit+1,offset);
    const items=rows.slice(0,limit).map(r=>({id:r.id,text:String(r.text??'').slice(textOffset,textOffset+textLimit),offset:textOffset,
      nextTextOffset:textOffset+textLimit<String(r.text??'').length?textOffset+textLimit:null,
      citation:{surface,id:r.id,storeSha256:pins[relative]}}));
    return {items,nextOffset:rows.length>limit?offset+limit:null,historical:true,untrusted:true};
   } finally {db.close();}
  } catch(e) {if(e.message==='FORBIDDEN')fail('FORBIDDEN');fail('STORE_UNAVAILABLE');}
 };
}
