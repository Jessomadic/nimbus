import {createPrivateRouter} from './routing.mjs';
// Host supplies authentication and policy. This module never infers identity from body data.
export function createMemoryRequestHandler({authenticate,authorize,ownerId,pins}){
 if(typeof authenticate!=='function'||typeof authorize!=='function'||typeof ownerId!=='string'||!ownerId)throw Error('INVALID_CONFIGURATION');
 const sessions=new WeakMap();
 const policy=(p,scope)=>p?.ownerId===ownerId&&authorize(p,scope)===true;
 const router=createPrivateRouter({pins,resolvePrincipal:req=>sessions.get(req),authorize:policy});
 return async function handle(req,res){
  const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  try{
   const principal=await authenticate(req);
   if(!principal||!policy(principal,'memory:read'))return reply(403,{error:'FORBIDDEN'});
   sessions.set(req,principal);
   const match=/^\/memory\/(get|search|recall)$/.exec(req.url);
   if(req.method!=='POST'||!match)return reply(404,{error:'NOT_FOUND'});
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||''))return reply(415,{error:'JSON_REQUIRED'});
   const chunks=[];let size=0;
   for await(const chunk of req){size+=chunk.length;if(size>8192)return reply(413,{error:'BODY_TOO_LARGE'});chunks.push(chunk);}
   const body=Buffer.concat(chunks,size).toString('utf8');
   let args;try{args=JSON.parse(body);}catch{return reply(400,{error:'INVALID_ARGUMENTS'});}
   // Recheck policy after body awaits; revocation applies to every dispatch and page.
   return reply(200,router(req,match[1],args));
  }catch(e){const code=e.message;return reply(code==='FORBIDDEN'?403:code==='STORE_UNAVAILABLE'?503:400,{error:['FORBIDDEN','STORE_UNAVAILABLE','INVALID_ARGUMENTS','OPERATION_DISABLED'].includes(code)?code:'INVALID_ARGUMENTS'});}
  finally{sessions.delete(req);}
 };
}
