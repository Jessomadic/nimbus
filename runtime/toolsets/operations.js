import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {capture} from '../process.js';
import {resources} from '../resources.js';
import {isValidCron,nextRun} from '../cron.js';
import {cleanConnectorError} from '../mcp.js';

const text={type:'string'},integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const spec=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const tools=[
  spec('tool_catalog','Search tools actually enabled for this worker, including connected MCP tools. Return descriptions and optionally full input schemas. Tool presence does not prove account entitlement or a successful operation.',{query:text,details:{type:'boolean'},limit:integer(1,100)}),
  spec('connector_inventory','Inspect this worker\'s discovered MCP servers/tools, read-only annotations and discovery errors. Does not return credentials, environment variables or transport headers.',{}),
  spec('host_snapshot','Read host OS, Node, uptime, CPU and live RAM/GPU resource measurements. This does not start/stop software or change model configuration.',{}),
  spec('process_inspect','Read a bounded process inventory with PID/name/CPU/memory. Optional literal name filter or PID. Command lines and environment secrets are omitted.',{name:text,pid:integer(1,2147483647),limit:integer(1,200)}),
  spec('service_inspect','Read Windows service status/start type without changing services. Optional literal name filter. Reports unsupported platforms honestly.',{name:text,limit:integer(1,200)}),
  spec('health_probe','Perform a bounded HTTP GET health check. Reports status, redirects, timing and a limited textual body. Network failures and probe timeouts return completed observations with ok:false; task cancellation still stops execution. A failed probe alone does not establish application health. No credentials/headers can be supplied; redirects cannot introduce credentials.',{url:text,timeoutMs:integer(100,15000),maxBytes:integer(100,64000)},['url']),
  spec('log_read','Read the tail of a local text log without loading the whole file. Optional literal contains filter. Reports byte offsets, truncation and line numbers relative to the tail.',{path:text,lines:integer(1,500),maxBytes:integer(1024,1048576),contains:text},['path']),
  spec('file_manifest','Inventory regular files with sizes, timestamps and optional SHA-256, bounded recursion/visited entries and explicit skipped-file reasons. Does not follow symlinks or alter files. Useful for migration/integrity evidence.',{path:text,recursive:{type:'boolean'},hash:{type:'boolean'},maxFiles:integer(1,1000),maxHashBytes:integer(1,67108864),maxEntries:integer(1,20000)},['path']),
  spec('artifact_inventory','Find this worker\'s saved artifacts, including paths, sizes and SHA-256 hashes. Keeps inspection within the worker workspace. No files are created or deleted.',{path:text,maxFiles:integer(1,500)}),
  spec('task_history','Inspect this worker\'s own recent tasks, status/usage, and optional bounded event evidence for one owned run. Does not resume, stop or replay actions.',{runId:integer(1,2147483647),limit:integer(1,50)}),
  spec('automation_schedule','Preview, list, create, enable or disable this worker\'s own Nimbus cron routines. workerId, if provided, must equal your ID. Five-field cron uses the reported host timezone. Creation stays DISABLED; enabling requires explicit action/host approval. Duplicate definitions are retained once. No deletion or automatic run.',{action:{type:'string',enum:['list','preview','create','enable','disable']},workerId:integer(1,2147483647),scheduleId:integer(1,2147483647),cron:text,task:text,quiet:{type:'boolean'}},['action']),
];
export const roleTools={
  orchestrator:['connector_inventory','task_history'],
  'windows-operator':['host_snapshot','process_inspect','service_inspect','health_probe','log_read','file_manifest'],
  'automation-engineer':['automation_schedule','health_probe','log_read','task_history','connector_inventory'],
  'office-assistant':['automation_schedule','artifact_inventory','task_history'],
  'knowledge-curator':['file_manifest','artifact_inventory'],
  'qa-engineer':['health_probe','log_read'],
  'security-reviewer':['connector_inventory','file_manifest'],
  'github-coordinator':['connector_inventory','task_history'],
};
function bounded(value,fallback,min,max){const number=value===undefined?fallback:Number(value);if(!Number.isInteger(number)||number<min||number>max)throw new Error(`Expected an integer from ${min} to ${max}`);return number;}
function local(ctx,file='.'){return path.resolve(ctx.workspace,file);}
async function readLimited(response,maxBytes,onProgress){
  if(!response.body)return{bytes:Buffer.alloc(0),truncated:false};
  const reader=response.body.getReader(),chunks=[];let size=0,truncated=false;
  try{for(;;){const {done,value}=await reader.read();if(done)break;const remaining=maxBytes-size;if(value.length>remaining){chunks.push(value.subarray(0,remaining));size+=remaining;onProgress?.(size);truncated=true;await reader.cancel();break;}chunks.push(value);size+=value.length;onProgress?.(size);}}
  finally{reader.releaseLock();}
  return{bytes:Buffer.concat(chunks,size),truncated};
}
function checkedURL(value){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use an HTTP(S) URL without embedded credentials');return url;}
const probeCodes=new Map([
  ['ECONNREFUSED','connection_refused'],['ENOTFOUND','dns_error'],['EAI_AGAIN','dns_error'],
  ['ETIMEDOUT','timeout'],['UND_ERR_CONNECT_TIMEOUT','timeout'],['UND_ERR_HEADERS_TIMEOUT','timeout'],['UND_ERR_BODY_TIMEOUT','timeout'],
  ['ECONNRESET','transport_error'],['EPIPE','transport_error'],['ENETUNREACH','transport_error'],['EHOSTUNREACH','transport_error'],['UND_ERR_SOCKET','transport_error'],
  ['DEPTH_ZERO_SELF_SIGNED_CERT','tls_error'],['SELF_SIGNED_CERT_IN_CHAIN','tls_error'],['UNABLE_TO_VERIFY_LEAF_SIGNATURE','tls_error'],['UNABLE_TO_GET_ISSUER_CERT_LOCALLY','tls_error'],['CERT_HAS_EXPIRED','tls_error'],['ERR_TLS_CERT_ALTNAME_INVALID','tls_error'],
]);
function probeFailure(error,timeout){
  // Fetch wraps platform errors in cause/AggregateError. Inspect only a bounded
  // chain and return known codes/static explanations, never raw transport data.
  const pending=[error],seen=new Set(),codes=[];
  for(let visited=0;pending.length&&visited<16;visited++){
    const current=pending.shift();if(!current||typeof current!=='object'||seen.has(current))continue;seen.add(current);
    if(probeCodes.has(current.code))codes.push(current.code);
    if(current.cause)pending.push(current.cause);
    if(Array.isArray(current.errors))pending.push(...current.errors.slice(0,8));
  }
  const code=codes[0],kind=timeout.aborted||error?.name==='TimeoutError'?'timeout':probeCodes.get(code);
  if(kind){
    const messages={connection_refused:'The connection was refused.',dns_error:'The endpoint hostname could not be resolved.',timeout:'The health probe exceeded its time limit.',tls_error:'The endpoint TLS connection could not be verified.',transport_error:'The HTTP connection failed or ended before the response completed.'};
    return{kind,code:timeout.aborted?'PROBE_TIMEOUT':code||'PROBE_TIMEOUT',message:messages[kind]};
  }
  if(error instanceof TypeError&&['fetch failed','terminated'].includes(error.message))return{kind:'transport_error',code:error.message==='terminated'?'RESPONSE_TERMINATED':'FETCH_FAILED',message:'The HTTP connection failed or ended before the response completed.'};
  return null;
}
function manifest(target,{recursive=true,hash=true,maxFiles=250,maxHashBytes=16777216,maxEntries=10000,signal}={}){
  const root=path.resolve(target),files=[],skipped=[];let limited=false,totalBytes=0,hashedBytes=0,visitedEntries=0,visitedDirectories=0;
  const visit=(file,depth)=>{
    signal?.throwIfAborted();if(files.length>=maxFiles||visitedEntries>=maxEntries){limited=true;return;}visitedEntries++;
    const stat=fs.lstatSync(file),relative=path.relative(root,file)||path.basename(file);
    if(stat.isSymbolicLink()){if(skipped.length<100)skipped.push({path:file,reason:'symbolic link'});return;}
    if(stat.isDirectory()){
      if(++visitedDirectories>2000){limited=true;return;}
      if(depth>12){if(skipped.length<100)skipped.push({path:file,reason:'depth limit'});return;}
      const dir=fs.opendirSync(file);try{for(let entry;!limited&&(entry=dir.readSync());){
        signal?.throwIfAborted();if(visitedEntries>=maxEntries){limited=true;break;}
        if(['.git','node_modules'].includes(entry.name)||entry.isDirectory()&&!recursive){visitedEntries++;continue;}
        visit(path.join(file,entry.name),depth+1);
      }}finally{dir.closeSync();}return;
    }
    if(!stat.isFile())return;
    const row={path:file,relative,size:stat.size,modifiedAt:stat.mtime.toISOString()};totalBytes+=stat.size;
    if(hash){
      if(stat.size<=maxHashBytes&&hashedBytes+stat.size<=268435456){row.sha256=createHash('sha256').update(fs.readFileSync(file)).digest('hex');hashedBytes+=stat.size;}
      else row.hashSkipped='Per-file or total hashing byte limit';
    }
    files.push(row);
  };
  visit(root,0);files.sort((a,b)=>a.relative.localeCompare(b.relative));return{root,files,skipped,limited,totalBytes,hashedBytes,visitedEntries,visitedDirectories,entryLimit:maxEntries};
}
export async function execute(name,args={},ctx={}){
  ctx.signal?.throwIfAborted();
  if(name==='tool_catalog'){
    const query=String(args.query||'').toLowerCase(),limit=bounded(args.limit,40,1,100);
    const matching=(ctx.availableTools||[]).filter(tool=>(tool.function.name+' '+tool.function.description).toLowerCase().includes(query));
    return{enabledToolCount:(ctx.availableTools||[]).length,matching:matching.length,tools:matching.slice(0,limit).map(tool=>({name:tool.function.name,description:tool.function.description,...(args.details?{parameters:tool.function.parameters}:{})})),truncated:matching.length>limit};
  }
  if(name==='connector_inventory'){
    const connectors=(ctx.availableTools||[]).filter(tool=>tool.function.name.startsWith('mcp__')).map(tool=>({name:tool.function.name,description:tool.function.description,readOnly:ctx.bindings?.get(tool.function.name)?.readOnly===true}));
    return{tools:connectors,discoveryErrors:(ctx.connectorErrors||[]).map(error=>({server:error.server,error:cleanConnectorError(error.error)})),connectedTools:connectors.length,note:connectors.length?'Transport discovery is not proof of account authorization for every operation.':'No connector tools were discovered for this worker.'};
  }
  if(name==='host_snapshot')return{platform:process.platform,os:os.type(),release:os.release(),architecture:os.arch(),hostname:os.hostname(),node:process.version,uptimeSeconds:os.uptime(),cpuCount:os.cpus().length,workspace:ctx.workspace,resources:await resources({fresh:true})};
  if(name==='process_inspect'||name==='service_inspect'){
    if(process.platform!=='win32')return{available:false,platform:process.platform,reason:'This inspection adapter currently supports Windows only'};
    const limit=bounded(args.limit,50,1,200),search=String(args.name||'').toLowerCase();
    const command=name==='process_inspect'?'@(Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Responding) | ConvertTo-Json -Depth 3 -Compress':'@(Get-Service | Select-Object Name,DisplayName,@{n="Status";e={$_.Status.ToString()}},@{n="StartType";e={$_.StartType.ToString()}}) | ConvertTo-Json -Depth 3 -Compress';
    const raw=JSON.parse(await capture('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{signal:ctx.signal,timeout:15000}));
    const rows=(Array.isArray(raw)?raw:[raw]).filter(row=>!search||String(row.ProcessName||row.Name||'').toLowerCase().includes(search)||String(row.DisplayName||'').toLowerCase().includes(search)).filter(row=>args.pid===undefined||row.Id===args.pid);
    return{available:true,observedAt:new Date().toISOString(),total:rows.length,items:rows.slice(0,limit),truncated:rows.length>limit};
  }
  if(name==='health_probe'){
    const begin=Date.now(),maxBytes=bounded(args.maxBytes,12000,100,64000),timeout=AbortSignal.timeout(bounded(args.timeoutMs,10000,100,15000)),signal=ctx.signal?AbortSignal.any([ctx.signal,timeout]):timeout;
    let url=checkedURL(args.url),response=null,bytesRead=0;const redirects=[],requestUrl=url.href;
    const observation=()=>({requestUrl,url:url.href,elapsedMs:Date.now()-begin,redirects,readOnly:true,completed:true,uncertain:false,responseReceived:response!==null,status:response?.status??null,contentType:response?.headers.get('content-type')||'',bytesRead});
    try{
      for(let hop=0;hop<=3;hop++){
        ctx.signal?.throwIfAborted();response=null;bytesRead=0;
        response=await fetch(url,{redirect:'manual',signal});
        if([301,302,303,307,308].includes(response.status)&&response.headers.get('location')){
          const next=checkedURL(new URL(response.headers.get('location'),url));redirects.push({from:url.href,to:next.href,status:response.status});await response.body?.cancel();if(hop===3)throw new Error('Health probe redirect limit reached');url=next;continue;
        }
        const type=response.headers.get('content-type')||'',body=await readLimited(response,maxBytes,size=>{bytesRead=size;});
        ctx.signal?.throwIfAborted();
        const textual=/json|text|xml|javascript/.test(type),result={...observation(),ok:response.ok,outcome:response.ok?'http_ok':'http_error',bodyComplete:!body.truncated,truncated:body.truncated};
        if(!response.ok)result.failure={kind:'http_error',code:'HTTP_'+response.status,message:'The endpoint returned HTTP status '+response.status+'.'};
        if(textual){result.text=body.bytes.toString('utf8');if(/json/.test(type)&&!body.truncated){try{result.json=JSON.parse(result.text);}catch{result.invalidJson=true;}}}
        return result;
      }
    }catch(error){
      // Caller/task aborts retain the existing stop/review boundary. Only this
      // read-only probe's own expected transport failures become observations.
      ctx.signal?.throwIfAborted();const failure=probeFailure(error,timeout);if(!failure)throw error;
      return{...observation(),ok:false,outcome:'probe_failed',bodyComplete:false,truncated:bytesRead>0,failure,note:'This completed read-only probe did not obtain a complete HTTP response. A failed probe alone does not establish whether the application is healthy.'};
    }
  }
  if(name==='log_read'){
    const file=local(ctx,args.path),stat=fs.statSync(file);if(!stat.isFile())throw new Error('Log path must be a regular file');
    const size=bounded(args.maxBytes,262144,1024,1048576),start=Math.max(0,stat.size-size),bytes=Buffer.alloc(stat.size-start),fd=fs.openSync(file,'r');try{fs.readSync(fd,bytes,0,bytes.length,start);}finally{fs.closeSync(fd);}
    let text=bytes.toString('utf8');if(start>0)text=text.slice(text.indexOf('\n')+1);
    const contains=String(args.contains||''),lines=text.split(/\r?\n/).map((text,index)=>({tailLine:index+1,text})).filter(line=>!contains||line.text.includes(contains)),limit=bounded(args.lines,100,1,500);
    return{path:file,size:stat.size,readOffset:start,byteTruncated:start>0,lineNumbersAreRelativeToTail:true,matchingLines:lines.length,lines:lines.slice(-limit),lineTruncated:lines.length>limit};
  }
  if(name==='file_manifest')return manifest(local(ctx,args.path),{recursive:args.recursive!==false,hash:args.hash!==false,maxFiles:bounded(args.maxFiles,250,1,1000),maxHashBytes:bounded(args.maxHashBytes,16777216,1,67108864),maxEntries:bounded(args.maxEntries,10000,1,20000),signal:ctx.signal});
  if(name==='artifact_inventory'){
    const target=local(ctx,args.path||'artifacts'),relative=path.relative(path.resolve(ctx.workspace),target);
    if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Artifact inventory stays in this worker workspace');
    if(!fs.existsSync(target))return{root:target,files:[],note:'This worker has not saved artifacts in that directory'};
    const real=fs.realpathSync(target),realRoot=fs.realpathSync(ctx.workspace),realRelative=path.relative(realRoot,real);if(realRelative.startsWith('..')||path.isAbsolute(realRelative))throw new Error('Artifact directory resolves outside this worker workspace');
    return manifest(target,{maxFiles:bounded(args.maxFiles,200,1,500),signal:ctx.signal});
  }
  if(name==='task_history'){
    if(!ctx.query)throw new Error('Task database is unavailable');
    if(args.runId!==undefined){
      const run=ctx.query('SELECT id,bot_id,status,source,requested_model,actual_model,last_error,input_tokens,output_tokens,started_at,ended_at FROM runs WHERE id=? AND bot_id=?').get(args.runId,ctx.botId);if(!run)throw new Error('Task is not owned by this worker');
      const events=ctx.query('SELECT id,type,body,created_at FROM task_events WHERE run_id=? ORDER BY id DESC LIMIT 50').all(args.runId).reverse().map(row=>({...row,data:row.body.length>4000?{preview:row.body.slice(0,4000),truncated:true}:JSON.parse(row.body),body:undefined}));return{run,events};
    }
    return{runs:ctx.query('SELECT id,status,source,actual_model,last_error,input_tokens,output_tokens,started_at,ended_at FROM runs WHERE bot_id=? ORDER BY id DESC LIMIT ?').all(ctx.botId,bounded(args.limit,20,1,50))};
  }
  if(name==='automation_schedule'){
    if(!ctx.query)throw new Error('Schedule database is unavailable');
    const workerId=args.workerId===undefined?ctx.botId:bounded(args.workerId,ctx.botId,1,2147483647);if(Number(workerId)!==Number(ctx.botId))throw new Error('Schedules must belong to this worker; manage other workers through their own tools or the dashboard');
    const worker=ctx.query('SELECT id,name FROM bots WHERE id=?').get(workerId);if(!worker)throw new Error('Unknown worker');
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    if(args.action==='list')return{worker,timeZone:zone,routines:ctx.query('SELECT id,bot_id,cron,prompt,enabled,quiet,last_run FROM routines WHERE bot_id=? ORDER BY id').all(workerId)};
    if(args.action==='preview'||args.action==='create'){
      if(!isValidCron(args.cron))throw new Error('A valid five-field cron is required');
      const next=[];let from=new Date();for(let i=0;i<5;i++){const when=nextRun(args.cron,from);if(!when)break;next.push({utc:when.toISOString(),local:when.toLocaleString('en-US',{timeZone:zone})});from=when;}
      const preview={worker,cron:args.cron.trim(),timeZone:zone,next,nextSearchHorizonDays:8};
      if(args.action==='preview')return preview;
      if(typeof args.task!=='string'||!args.task.trim()||args.task.length>16000)throw new Error('Creation requires a task of 1 to 16000 characters');
      const existing=ctx.query('SELECT id,enabled FROM routines WHERE bot_id=? AND cron=? AND prompt=? LIMIT 1').get(workerId,args.cron.trim(),args.task);
      if(existing)return{...preview,id:existing.id,enabled:Boolean(existing.enabled),replayed:true,note:'Identical routine already exists; it was not changed or duplicated'};
      const id=Number(ctx.query('INSERT INTO routines (bot_id,cron,prompt,enabled,quiet) VALUES (?,?,?,?,?)').run(workerId,args.cron.trim(),args.task,0,args.quiet===false?0:1).lastInsertRowid);ctx.broadcast?.('state_changed',{});
      return{...preview,id,enabled:false,quiet:args.quiet!==false,note:'Saved disabled. Explicitly enable only with user authorization.'};
    }
    if(args.action==='enable'||args.action==='disable'){
      const id=bounded(args.scheduleId,undefined,1,2147483647),routine=ctx.query('SELECT * FROM routines WHERE id=? AND bot_id=?').get(id,workerId);if(!routine)throw new Error('Schedule does not belong to the selected worker');
      const enabled=args.action==='enable'?1:0;ctx.query('UPDATE routines SET enabled=? WHERE id=?').run(enabled,id);ctx.broadcast?.('state_changed',{});return{id,worker,enabled:Boolean(enabled),timeZone:zone};
    }
    throw new Error('Unknown schedule action');
  }
  throw new Error(`Unknown operations tool: ${name}`);
}
