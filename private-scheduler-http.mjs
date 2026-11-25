// Opt-in host registration only. No production server import or activation.
export function registerPrivateSchedulerHttp(server,{api,authorize}={}) {
 if(!api||typeof api.create!=='function'||typeof api.tick!=='function')throw Error('scheduler API required');
 const handler=async(req,res)=>{
  const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  // Authorization precedes body parsing and every stateful operation. Only boolean true admits.
  try{if(typeof authorize!=='function'||await authorize(req)!==true)return send(403,{error:'denied'});}catch{return send(403,{error:'denied'});}
  if(req.method!=='POST')return send(405,{error:'method'});
  if(!['/private/scheduler/create','/private/scheduler/tick'].includes(req.url))return send(404,{error:'route'});
  const chunks=[];let bytes=0;
  try{for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)return send(413,{error:'body too large'});chunks.push(Buffer.from(chunk));}
   const input=JSON.parse(Buffer.concat(chunks,bytes).toString('utf8')||'{}');
   if(!input||Array.isArray(input)||typeof input!=='object')return send(400,{error:'invalid body'});
   const allowed=req.url.endsWith('/create')?['id','botId','prompt','due','interval']:[];
   if(Object.keys(input).some(k=>!allowed.includes(k)))return send(400,{error:'unexpected field'});
   // Current policy fences mutation and synchronous dispatch entry after upload.
   try{if(await authorize(req)!==true)return send(403,{error:'denied'});}catch{return send(403,{error:'denied'});}
   if(req.url.endsWith('/create')){api.create(input);return send(201,{created:true});}
   return send(200,{occurrence:await api.tick()});
  }catch{return send(400,{error:'invalid or held request'});}
 };
 // Dedicated server: caller owns listening address, transport and authorization policy.
 if(server.listenerCount('request'))throw Error('dedicated scheduler server required');
 server.on('request',handler);
 return ()=>server.off('request',handler);
}
