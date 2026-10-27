import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { config, ROOT } from './config.js';
import { capture } from './process.js';
import { localToken } from './credentials.js';
import { checkResources } from './resources.js';
import { Slots } from './slots.js';

export async function startLocalService() {
  const c=config();if(!c.local.enabled||!c.local.managed.enabled)return null;
  const managed=c.local.managed,url=new URL(c.local.baseUrl);
  if(url.hostname!=='127.0.0.1')throw new Error('The managed local service must bind to loopback');
  const slots=new Slots(1);
  async function loaded(){return JSON.parse(await capture(managed.lmsBin,['ps','--json'],{timeout:15000}));}
  function modelList(models){
    const items=models.filter(m=>m.type==='llm').map(m=>({key:m.identifier,max_context_length:m.contextLength,tool_capable:m.trainedForToolUse,
      loaded_instances:[{id:m.identifier,config:{context_length:m.contextLength}}]}));
    if(!items.some(m=>m.key===c.local.model))items.push({key:c.local.model,max_context_length:c.local.contextTokens,tool_capable:true,loaded_instances:[]});
    return{models:items};
  }
  const json=(res,code,body)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.url==='/health')return json(res,200,{ok:true,managed:true,localConcurrency:1});
      const token=await localToken(c.local),expected=Buffer.from('Bearer '+token),supplied=Buffer.from(req.headers.authorization||'');
      if(!token||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return json(res,401,{error:'Unauthorized'});
      if(req.method==='GET'&&req.url==='/api/v1/models')return json(res,200,modelList(await loaded()));
      if(req.method==='GET'&&req.url==='/v1/models')return json(res,200,{data:modelList(await loaded()).models.map(m=>({id:m.key,object:'model'}))});
      if(req.method!=='POST'||req.url!=='/v1/chat/completions')return json(res,404,{error:'Not found'});
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>8*1024*1024)return json(res,413,{error:'Request too large'});}
      const body=JSON.parse(raw);
      const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort(new Error('Nimbus client disconnected'));});
      await slots.use(abort.signal,async()=>{
        await checkResources(c.local.resourceCeiling);
        let models=await loaded();
        if(!models.some(m=>m.identifier===body.model)){
          if(body.model!==c.local.model)throw new Error('Requested model is not loaded in the shared pool');
          // No worker owns a model load. The one configured pool model is loaded
          // once only when the pool is empty; existing user loads are preserved.
          await capture('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(ROOT,'scripts','Ensure-LocalModel.ps1'),
            '-ModelKey',managed.modelKey,'-Identifier',c.local.model,'-LmsBin',managed.lmsBin,'-ContextLength',String(c.local.contextTokens),'-GpuRatio',String(managed.gpuRatio),
            '-ForecastGpuMB',String(managed.forecastGpuMB),'-ForecastRamMB',String(managed.forecastRamMB),'-ResourceCeiling',String(c.local.resourceCeiling)],{timeout:180000,signal:abort.signal});
          models=await loaded();if(!models.some(m=>m.identifier===body.model))throw new Error('Managed load did not become available');
        }
        const upstreamBase=managed.upstreamUrl.replace(/\/$/,'');
        try{await fetch(upstreamBase+'/models',{headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(3000)});}
        catch(e){
          if(new URL(upstreamBase).hostname!=='127.0.0.1')throw e;
          const upstreamUrl=new URL(upstreamBase);
          await capture(managed.lmsBin,['server','start','--port',upstreamUrl.port||'1234','--bind','127.0.0.1'],{timeout:30000,signal:abort.signal});
        }
        const target=upstreamBase+'/chat/completions';
        const upstream=await fetch(target,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body),
          signal:AbortSignal.any([abort.signal,AbortSignal.timeout(c.local.timeoutSeconds*1000)])});
        res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store'});
        await pipeline(Readable.fromWeb(upstream.body),res);
      });
    }catch(e){if(!res.headersSent)json(res,503,{error:e.message});else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(url.port||80),'127.0.0.1',resolve);});
  return server;
}
