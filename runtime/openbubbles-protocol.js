// Disabled-adapter protocol primitives. No network, credentials, timers or discovery.
import {createHash,randomBytes} from 'node:crypto';
import fs from 'node:fs';
import {mkdtemp,open,rm} from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
const fail=m=>{throw new Error(m)};
export const MAX_FILE=25*1024*1024;
export const MIME=['image/jpeg','image/png','image/gif','image/heic','image/webp','video/mp4','video/quicktime','audio/mpeg','audio/mp4','audio/x-m4a','application/pdf','text/plain'];
const digest=b=>createHash('sha256').update(b).digest('hex');
const effects=new Set(['slam','loud','gentle','invisible ink','echo','spotlight','balloons','confetti','love','lasers','fireworks','celebration']);
export function fileMetadata(f){
 const mime=String(f.mime).split(';')[0].trim().toLowerCase();
 if(typeof f.name!=='string'||!f.name||['.','..'].includes(f.name)||Buffer.byteLength(f.name)>255||/[\p{C}\p{Zl}\p{Zp}/\\:<>"|?*&]/u.test(f.name)||!MIME.includes(mime))fail('invalid attachment metadata');
 if(!Number.isSafeInteger(f.size)||f.size<1||f.size>MAX_FILE||typeof f.ref!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(f.ref)||!/^[a-f0-9]{64}$/.test(f.sha256))fail('invalid private blob reference');
 return {ref:f.ref,name:f.name,mime,size:f.size,sha256:f.sha256};
}
export function chunks(text){
 if(typeof text!=='string'||!text.length)fail('empty text');
 const out=[];let s='';for(const c of text){if(Buffer.byteLength(s+c)>4000){out.push(s);s='';}s+=c;}if(s)out.push(s);return out;
}
export function planRequests(p,{chat,ledger=[]}){
 if(!p||typeof p.operationId!=='string'||!p.operationId||p.operationId.length>128||!chat)fail('invalid operation');
 if(Object.keys(p).some(k=>['chat','owner','binding','runId','topicId','transport'].includes(k)))fail('authority in arguments');
 const common={chatGuid:chat};
 if(p.effect!==undefined){const e=p.effect.trim().toLowerCase().replaceAll('_',' ');if(!effects.has(e))fail('invalid effect');common.effect=e;}
 const target=id=>ledger.find(x=>x.guid===id&&x.chat===chat);
 const part=(v,max)=>{if(v===undefined)return 0;if(!Number.isInteger(v)||v<0||v>max)fail('invalid part');return v;};
 if(p.replyToMessageGuid){if(!target(p.replyToMessageGuid))fail('unknown native reply');common.replyToMessageGuid=p.replyToMessageGuid;common.replyPartIndex=part(p.replyPartIndex,1000);}
 else if(p.replyPartIndex!==undefined)fail('reply part without target');
 const request=(kind,url,body,index=0,method='POST',files)=>({kind,path:'/api/v1/'+url,method,body,files,index});
 const temp=i=>digest(chat+'\0'+p.operationId+'\0'+i);
 if(p.kind==='text')return chunks(p.text).map((message,i)=>request('text','message/text',{...common,message,tempGuid:temp(i)},i));
 if(p.kind==='attachments'){
  if(!Array.isArray(p.files)||p.files.length<1||p.files.length>4)fail('1..4 files required');
  const files=p.files.map(fileMetadata);if(p.text&&chunks(p.text).length!==1)fail('caption too long');
  return [request(p.kind,'message/attachment',{...common,message:p.text||'',tempGuid:temp(0)},0,'POST',files)];
 }
 const c=encodeURIComponent(chat),t=target(p.targetGuid);
 if(p.kind==='typing'){if(typeof p.active!=='boolean')fail('active boolean required');return [request(p.kind,'chat/'+c+'/typing',{},0,p.active?'POST':'DELETE')];}
 if(!t)fail('unknown native target');
 if(p.kind==='read'){if(t.ownText)fail('read needs inbound');return [request(p.kind,'chat/'+c+'/read',{messageGuid:p.targetGuid})];}
 if(p.kind==='reaction'){if(typeof p.reaction!=='string'||!p.reaction.trim()||p.reaction==='-'||Buffer.byteLength(p.reaction)>64)fail('invalid reaction');return [request(p.kind,'message/react',{chatGuid:chat,selectedMessageGuid:p.targetGuid,reaction:p.reaction,partIndex:part(p.partIndex,4096)})];}
 if(!t.ownText||!['edit','unsend'].includes(p.kind))fail('not API-owned text');
 if(p.kind==='edit'&&chunks(p.text).length!==1)fail('edit too long');
 return [request(p.kind,'message/'+encodeURIComponent(p.targetGuid)+'/'+p.kind,{partIndex:part(p.partIndex,4096),...(p.kind==='edit'?{editedMessage:p.text}:{})})];
}
export async function serializeRequest(r,reader,{scratch=process.env.NIMBUS_DATA,signal}={}){
 signal?.throwIfAborted();
 if(!r.files)return {...r,headers:{'content-type':'application/json'},body:JSON.stringify(r.body),cleanup:async()=>{}};
 if(!scratch)fail('private scratch required');
 const dir=await mkdtemp(path.join(scratch,'ob-stage-')),boundary='nimbus-'+randomBytes(24).toString('hex'),staged=[];
 const cleanup=()=>rm(dir,{recursive:true,force:true});
 try{
  for(const f of r.files){
   const dest=path.join(dir,String(staged.length)),h=await open(dest,'wx',0o600);let size=0,tail=Buffer.alloc(0);const hash=createHash('sha256');
   try{for await(const raw of reader(f.ref)){signal?.throwIfAborted();const b=Buffer.from(raw);size+=b.length;if(size>f.size||size>MAX_FILE)fail('blob overflow');const scan=Buffer.concat([tail,b]);if(scan.includes(boundary))fail('multipart collision');tail=scan.subarray(-boundary.length);hash.update(b);await h.write(b);}}
   finally{await h.close();}
   if(size!==f.size||hash.digest('hex')!==f.sha256)fail('blob integrity mismatch');
   staged.push({...f,dest});
  }
  // Reopen and verify all immutable staging files before exposing a body to the sink.
  for(const f of staged){const h=createHash('sha256');for await(const b of fs.createReadStream(f.dest))h.update(b);if(h.digest('hex')!==f.sha256)fail('staged blob changed');}
  async function* body(){
   try{
    for(const [k,v] of Object.entries(r.body))yield Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+k+'"\r\n\r\n'+v+'\r\n');
    for(const f of staged){
     signal?.throwIfAborted();yield Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="files"; filename="'+f.name+'"\r\nContent-Type: '+f.mime+'\r\n\r\n');
     for await(const b of fs.createReadStream(f.dest)){signal?.throwIfAborted();yield b;}yield Buffer.from('\r\n');
    }yield Buffer.from('--'+boundary+'--\r\n');
   }finally{await cleanup();}
  }
  return {path:r.path,method:r.method,headers:{'content-type':'multipart/form-data; boundary='+boundary},body:Readable.toWeb(Readable.from(body())),cleanup};
 }catch(e){await cleanup();throw e;}
}
export function normalizeResponse(kind,r){
 if(r?.status!==200||!r.data||typeof r.data!=='object')fail('missing acknowledgement');
 const nativeGuid=r.data.guid||r.data.event?.guid;
 if(['text','attachments'].includes(kind)&&(typeof nativeGuid!=='string'||!nativeGuid))fail('missing native GUID');
 const operation=['typing','read'].includes(kind)?r.data:r.data.operation;
 if(!['text','attachments'].includes(kind)&&(!operation||operation.submitted!==true||typeof operation.confirmed!=='boolean'))fail('missing operation acknowledgement');
 if(r.data.submitted===false)fail('ambiguous submission acknowledgement');
 return {state:['text','attachments'].includes(kind)?'submitted':'acknowledged',nativeGuid:nativeGuid||null};
}
export function normalizeEvent(raw,b,format='event'){
 if(!['event','dto'].includes(format))fail('unknown event format');
 const e=format==='event'?raw:{...raw,chat_guid:raw.chatGuid,is_from_me:raw.isFromMe,temp_guid:raw.tempGuid};
 if(e.chat_guid!==b.chat||typeof e.is_from_me!=='boolean'||(e.kind==='text'&&(e.is_from_me!==false||e.sender!==b.owner))||(!e.is_from_me&&e.sender!==b.owner)||!Array.isArray(e.participants)||e.participants.length!==1||e.participants[0]!==b.owner||!Number.isSafeInteger(e.sequence)||e.sequence<1)fail('unauthorized inbound');
 if(!['text','status','reaction','typing','delivered','read','accepted','apnsConfirmed','edit','unsend'].includes(e.kind))fail('unsupported event');
 if(e.kind==='text'&&(typeof e.guid!=='string'||!e.guid||(!e.text&&!e.attachments?.length)))fail('invalid request');
 return {sequence:e.sequence,guid:e.guid||null,target:e.target_guid||e.associatedMessageGuid||e.guid||null,kind:e.kind,text:e.text||'',attachments:(e.attachments||[]).map(a=>{const name=a.file_name||a.name,mime=a.mime_type||a.mime;return {id:a.attachment_id||a.id,name,mime,size:a.size,disposition:!name||!MIME.includes(mime)||!(a.size>0&&a.size<=MAX_FILE)?'unsupported':'metadata-only'};})};
}
