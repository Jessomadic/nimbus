import {correctedReadArgs} from './read-guidance.js';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const high=n=>n>=0xd800&&n<=0xdbff,low=n=>n>=0xdc00&&n<=0xdfff;
export function readWorkerFile(file,args={}){
 const paged=Object.hasOwn(args,'offset')||Object.hasOwn(args,'limit');
 const offset=args.offset===undefined?0:args.offset,limit=args.limit===undefined?4000:args.limit;
 if(paged&&(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<2||limit>4000))return {path:file,error:'Paging needs a nonnegative integer offset and a limit from 2 to 4000 UTF-16 characters.',code:'invalid_page',readGuidance:invalidPageGuidance(args)};
 if(args.expectedSha256!==undefined&&(typeof args.expectedSha256!=='string'||!/^[a-f0-9]{64}$/i.test(args.expectedSha256)))return {path:file,error:'expectedSha256 must be a full SHA-256.',code:'invalid_hash'};
 const stat=fs.statSync(file),maximum=paged?16000000:256000;
 if(!stat.isFile())return {path:file,error:'A regular file is required.',code:'not_a_file'};
 if(stat.size>maximum)return {path:file,size:stat.size,error:paged?'File exceeds the 16 MB paged text-read limit. Use an assigned specialized reader.':'File exceeds the 256 KB full text-read limit. Use read_file with offset:0 and limit:4000 for a bounded page.',code:'file_too_large'};
 // Bound actual bytes as well as the initial stat, even if the file grows.
 const fd=fs.openSync(file,'r');let bytes;
 try{
  const before=fs.fstatSync(fd);
  if(!before.isFile())return {path:file,error:'A regular file is required.',code:'not_a_file'};
  const chunks=[];let total=0;
  while(true){
   const chunk=Buffer.allocUnsafe(Math.min(65536,maximum-total+1)),size=fs.readSync(fd,chunk,0,chunk.length,null);
   if(!size)break;total+=size;
   if(total>maximum)return {path:file,size:total,error:'File grew beyond this read limit.',code:'file_too_large'};
   chunks.push(chunk.subarray(0,size));
  }
  const after=fs.fstatSync(fd);
  if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)return {path:file,error:'File changed during the read. Reconcile its version before combining pages.',code:'file_changed'};
  bytes=Buffer.concat(chunks,total);
 }finally{fs.closeSync(fd);}
 const sha256=createHash('sha256').update(bytes).digest('hex');
 if(args.expectedSha256!==undefined&&args.expectedSha256.toLowerCase()!==sha256)return {path:file,bytes:bytes.length,sha256,error:'File changed since the expected hash. Reconcile the new version before combining pages.',code:'file_changed'};
 const content=bytes.toString('utf8'),metadata={path:file,bytes:bytes.length,sha256};
 if(!paged)return {...metadata,content};
 if(offset>content.length||offset>0&&low(content.charCodeAt(offset))&&high(content.charCodeAt(offset-1)))return {...metadata,totalCharacters:content.length,error:'Offset is outside the text or splits a Unicode character. Use the returned nextOffset.',code:'invalid_offset'};
 const response=end=>({...metadata,content:content.slice(offset,end),offset,nextOffset:end<content.length?end:null,hasMore:end<content.length,totalCharacters:content.length,readGuidance:{advisory:true,complete:end>=content.length,message:end>=content.length?'File pagination complete; not task completion.':'Read the supplied path at the returned cursor with this hash.',...(end<content.length&&typeof args.path==='string'&&args.path.trim()?{nextCall:{tool:'read_file',args:{path:args.path,offset:end,limit,expectedSha256:sha256}}}:{})}});
 let end=Math.min(content.length,offset+limit);
 // JSON escapes can expand control characters; keep the entire page below the
 // ordinary model-preview budget instead of returning another truncated page.
 if(JSON.stringify(response(end)).length>10000){
  let lo=offset,hi=end;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(JSON.stringify(response(mid)).length<=10000)lo=mid;else hi=mid-1;}
  end=lo;
 }
 if(end<content.length&&high(content.charCodeAt(end-1))&&low(content.charCodeAt(end)))end--;
 if(end===offset&&offset<content.length||JSON.stringify(response(end)).length>10000)return {...metadata,error:'Path metadata leaves no room for a bounded page.',code:'page_metadata_too_large'};
 return response(end);
}

function invalidPageGuidance(args){
 const nextCall=correctedReadArgs('read_file',args,{path:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:2,maximum:4000},expectedSha256:{type:'string',pattern:'^[a-fA-F0-9]{64}$'}});
 return {advisory:true,validRange:{offset:{minimum:0},limit:{minimum:2,maximum:4000}},...(nextCall?{nextCall}:{})};
}
