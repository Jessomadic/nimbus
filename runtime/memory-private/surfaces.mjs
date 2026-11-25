import fs from 'node:fs';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
export const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const root='F:/Nimbus/data/projects/hermes-capability-parity/memory-transfer-20261112/archive/';
export function createSurfaceRepair({resolvePrincipal,authorize,pins,attachmentManifest,baseline,archiveRoot=root}){
 const read=(p,h)=>{if(hash(p)!==h)throw Error('STORE_UNAVAILABLE');return JSON.parse(fs.readFileSync(p,'utf8'))};
 return (session,operation,args={})=>{
 const p=resolvePrincipal(session);if(!p||authorize(p,'memory:read')!==true)throw Error('FORBIDDEN');
 if(!['topics','attachments'].includes(args.surface)&&!(args.surface==='sessions'&&('sessionId'in args||'role'in args)))return baseline(session,operation,args);
 const surface=args.surface;if(authorize(p,'memory:'+surface+':read')!==true)throw Error('FORBIDDEN');
 if(!['recall','search','get'].includes(operation))throw Error('OPERATION_DISABLED');
 const allowed=['surface','query','id','limit','offset','textLimit','textOffset',...(surface==='sessions'?['sessionId','role']:[])];
 if(Object.keys(args).some(k=>!allowed.includes(k)))throw Error('INVALID_ARGUMENTS');
 for(const [k,max]of [['limit',20],['offset',1000000],['textLimit',2048],['textOffset',10000000]])if(args[k]!==undefined&&(!Number.isInteger(args[k])||args[k]<(k.includes('Limit')||k==='limit'?1:0)||args[k]>max))throw Error('INVALID_ARGUMENTS');
 if(operation==='get'?(typeof args.id!=='string'||args.id.length<1||args.id.length>256):typeof args.query!=='string'||!args.query.trim()||args.query.length>256)throw Error('INVALID_ARGUMENTS');
 for(const k of ['sessionId','role'])if(args[k]!==undefined&&(typeof args[k]!=='string'||!args[k]||args[k].length>256))throw Error('INVALID_ARGUMENTS');
 let rows,sha;
 if(surface==='attachments'){
 const m=read(attachmentManifest.path,attachmentManifest.sha256);sha=attachmentManifest.sha256;
 rows=Object.entries(m).flatMap(([status,list])=>Array.isArray(list)?list.map((r,i)=>({id:String(r.id??status+':'+i),text:r.path??'',availability:status==='copied'?'COPIED_RECORDED':'BLOCKED_SOURCE',recordedStatus:status,sourceSha256:r.sha256??null,target:r.target??null})):[]);
 rows=rows.filter(r=>operation==='get'?r.id===args.id:r.text.toLowerCase().includes(args.query.toLowerCase())).sort((a,b)=>a.id.localeCompare(b.id));
 }else{
 const rel=surface==='topics'?'integrations/openhuman_memory/memory.db':'home/state.db',path=archiveRoot+rel;sha=pins[rel];if(!sha||hash(path)!==sha)throw Error('STORE_UNAVAILABLE');
 const db=new DatabaseSync(path,{readOnly:true});try{
 let sql=surface==='topics'?"SELECT segment_id id,coalesce(nullif(topic_keywords,''),summary,'') text,session_id sessionId,namespace FROM conversation_segments":'SELECT CAST(id AS TEXT) id,content text,session_id sessionId,role FROM messages';
 let where=[],values=[];where.push(operation==='get'?(surface==='topics'?'segment_id=?':'CAST(id AS TEXT)=?'):(surface==='topics'?"instr(lower(coalesce(nullif(topic_keywords,''),summary,'')),lower(?))>0":"instr(lower(content),lower(?))>0"));values.push(operation==='get'?args.id:args.query);
 for(const [k,col]of [['sessionId','session_id'],['role','role']])if(args[k]!==undefined){where.push(col+'=?');values.push(args[k])}
 rows=db.prepare(sql+' WHERE '+where.join(' AND ')+' ORDER BY id').all(...values);
 }finally{db.close()}
 }
 const offset=args.offset??0,limit=args.limit??8,start=args.textOffset??0,size=args.textLimit??512;
 return {items:rows.slice(offset,offset+limit).map(r=>({...r,text:String(r.text??'').slice(start,start+size),nextTextOffset:start+size<String(r.text??'').length?start+size:null,citation:{surface,id:r.id,storeSha256:sha}})),nextOffset:rows.length>offset+limit?offset+limit:null,historical:true,untrusted:true};
 };
}
