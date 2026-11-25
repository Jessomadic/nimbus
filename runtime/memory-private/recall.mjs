import fs from 'node:fs';
import {createHash} from 'node:crypto';
export const identity=Object.freeze({
 id:'copied-attachment:4cc8ad92-b91c-45af-96b5-4506d0673d24',
 path:'F:/Nimbus/data/bots/1/artifacts/leader2053-copied-pdf-consumer/copied-one-4cc8ad92-b91c-45af-96b5-4506d0673d24.private.txt',
 sha256:'4eba35992ba5d1cbd691d769b49ad063eaaa8196a430f99fc3d42bad520b0f15',
 bytes:3764, sourceSha256:'e50b5d311c068654085374b108e0ba23e21d7e86f170b8dda628b529d554a933'
});
function integer(n,min,max){if(!Number.isInteger(n)||n<min||n>max)throw Error('INVALID_BOUND');return n;}
function load(){
 const fd=fs.openSync(identity.path,'r');
 try{
  if(!fs.fstatSync(fd).isFile()||fs.fstatSync(fd).size!==identity.bytes)throw Error('COPY_IDENTITY_MISMATCH');
  const b=Buffer.alloc(identity.bytes+1);let n=0,k;
  while(n<b.length&&(k=fs.readSync(fd,b,n,b.length-n,null))>0)n+=k;
  if(n!==identity.bytes||createHash('sha256').update(b.subarray(0,n)).digest('hex')!==identity.sha256)throw Error('COPY_IDENTITY_MISMATCH');
  return b.subarray(0,n).toString('utf8');
 }finally{fs.closeSync(fd);}
}
// Trusted host supplies both principal and authorization on EVERY dispatch.
// Do not expose authorization or principal as worker-controlled tool arguments.
export function createRecallBinding(authorize){
 if(typeof authorize!=='function')throw Error('AUTHORIZER_REQUIRED');
 return function dispatch(principal,operation,args={}){
  if(authorize(principal,'copied-attachment:read')!==true)throw Error('FORBIDDEN');
  if(!args||typeof args!=='object'||Array.isArray(args))throw Error('INVALID_ARGUMENTS');
  if(operation!=='search'&&operation!=='get')throw Error('UNSUPPORTED_OPERATION');
  const allowed=operation==='search'?['query','offset','textOffset','limit']:['id','offset','textOffset','limit'];
  if(Object.keys(args).some(k=>!allowed.includes(k)))throw Error('INVALID_ARGUMENTS');
  if(args.offset!==undefined&&args.textOffset!==undefined)throw Error('INVALID_ARGUMENTS');
  const offset=integer(args.offset??0,0,100000);
  const continuation=args.textOffset===undefined?null:integer(args.textOffset,0,100000);
  const limit=integer(args.limit??512,1,2048);
  if(operation==='get'&&args.id!==identity.id)throw Error('UNKNOWN_ID');
  if(operation==='search'&&(typeof args.query!=='string'||!args.query.trim()||args.query.length>256))throw Error('INVALID_QUERY');
  const text=load();let start=continuation??offset;
  if(start>text.length)throw Error('INVALID_OFFSET');
  if(operation==='search'){
   const first=text.toLowerCase().indexOf(args.query.toLowerCase());
   if(first<0)return {items:[],nextOffset:null,nextTextOffset:null};
   start=continuation===null?text.toLowerCase().indexOf(args.query.toLowerCase(),offset):continuation;
   if(continuation!==null&&continuation<first)throw Error('INVALID_OFFSET');
   if(start<0)return {items:[],nextOffset:null};
  }
  if(start>text.length)throw Error('INVALID_OFFSET');
  const end=Math.min(text.length,start+limit);
  const item={id:identity.id,citation:{id:identity.id,sha256:identity.sha256,sourceSha256:identity.sourceSha256},text:text.slice(start,end),offset:start,end,truncated:end<text.length};
  return {items:[item],nextOffset:end<text.length?end:null,nextTextOffset:end<text.length?end:null};
 };
}
