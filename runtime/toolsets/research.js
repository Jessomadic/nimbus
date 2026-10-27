import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {requiresApproval} from '../policy.js';

const text={type:'string'};
const integer=(minimum,maximum)=>({type:'integer',minimum,maximum});
const spec=(name,description,properties,required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
const scope={type:'string',enum:['private','shared']};
export const tools=[
  spec('research_fetch','Fetch an HTTP(S) source without cookies or credentials. Returns bounded source text, exact response/redirect provenance, captured-byte hash and links. HTML extraction removes scripts/styles and is not browser rendering. Optional saveAs preserves an evidence JSON file inside your workspace without overwriting.',
    {url:text,maxBytes:integer(1024,2097152),maxChars:integer(100,80000),timeoutMs:integer(100,30000),saveAs:text},['url']),
  spec('research_search','Search through an actually advertised read-only web-search MCP connector. Discovers its query/limit schema and returns provider results marked discovery-only. If no suitable connector is available, reports the exact setup gap; never invents results. Use scholar_search for public scholarly metadata.',
    {query:text,limit:integer(1,20),connector:text},['query']),
  spec('scholar_search','Search Crossref public scholarly metadata by query, DOI or bibliographic terms. Returns titles, DOIs, authors and publication date precision. Metadata is discovery evidence, not full-text reading or proof of a claim. No API key required; outages/rate limits are reported.',
    {query:text,limit:integer(1,20),timeoutMs:integer(100,30000)},['query']),
  spec('source_register','Maintain a versioned evidence/source register. read returns its revision; add records a new URL/file plus optional research_fetch evidence JSON; annotate appends review/dispute notes without deleting history. Existing registers require expectedRevision for mutations. Paths stay in the selected private/shared knowledge area.',
    {action:{type:'string',enum:['read','add','annotate']},path:text,scope,expectedRevision:integer(0,1000000),source:{type:'object',properties:{id:text,title:text,location:text,author:text,publishedAt:text,evidencePath:text,notes:text},required:['title','location'],additionalProperties:false},sourceId:text,note:text,reviewStatus:{type:'string',enum:['unreviewed','reviewed','disputed','superseded']}},['action']),
  spec('knowledge_search','Search actual private/shared knowledge text with literal terms and line-numbered context. Traversal skips symlinks and Git/dependency directories, bounds files/bytes, and reports skipped/truncated evidence. It does not infer knowledge from filenames.',
    {query:text,scope,path:text,mode:{type:'string',enum:['all','any','phrase']},limit:integer(1,100),maxFiles:integer(1,2000),contextLines:integer(0,5)},['query']),
  spec('evidence_audit','Audit claim-to-source links against a source register and retained evidence hashes. Detect missing citations, unread/disputed sources, changed capture files, unsupported exact quotations and explicit claim conflicts. An evidence-linked result is provenance coverage, not an automatic semantic fact check.',
    {registerPath:text,scope,claims:{type:'array',minItems:1,maxItems:100,items:{type:'object',properties:{id:text,claim:text,citations:{type:'array',maxItems:20,items:{type:'object',properties:{sourceId:text,quote:text},required:['sourceId'],additionalProperties:false}},conflictsWith:{type:'array',maxItems:20,items:text}},required:['id','claim','citations'],additionalProperties:false}},saveAs:text},['claims']),
  spec('document_compare','Compare two real UTF-8 text documents with hashes, line numbers and bounded change hunks. Uses line alignment for small files and an explicitly labelled changed-region comparison for large ones. No files are modified; optional saveAs retains a new comparison receipt.',
    {before:text,after:text,ignoreWhitespace:{type:'boolean'},maxChanges:integer(1,200),saveAs:text},['before','after']),
  spec('check_links','Check up to 25 HTTP(S) links with response codes, redirect trails and error evidence. HEAD is attempted first, with a bounded GET fallback for servers that reject HEAD. Availability does not verify a quotation, fragment target, or factual claim.',
    {urls:{type:'array',minItems:1,maxItems:25,items:text},timeoutMs:integer(100,30000)},['urls']),
  spec('citation_format','Format registered source metadata into Markdown references, JSON or BibTeX without inventing authors/dates. Includes only supplied/observed metadata and review status. Optional saveAs writes a new artifact; existing artifacts are preserved.',
    {registerPath:text,scope,sourceIds:{type:'array',minItems:1,maxItems:100,items:text},format:{type:'string',enum:['markdown','json','bibtex']},saveAs:text},['sourceIds'])
];
export const roleTools={
  researcher:['research_search','scholar_search','research_fetch','source_register','evidence_audit','check_links','citation_format','document_compare'],
  'knowledge-curator':['knowledge_search','source_register','evidence_audit','document_compare','citation_format','research_fetch','check_links'],
  'technical-writer':['research_fetch','source_register','citation_format','check_links','document_compare'],
};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const now=()=>new Date().toISOString();
const cap=(value,min,max,fallback)=>Math.min(max,Math.max(min,Number.isFinite(Number(value))?Number(value):fallback));
const cleanError=error=>String(error?.message||error).slice(0,1200);
function requireText(value,label,max=4000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${label} must be nonempty text of at most ${max} characters`);return value.trim();}
function httpURL(value){const url=new URL(requireText(value,'url',8000));if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Use an HTTP(S) URL without embedded credentials');url.hash='';return url;}
function localPath(ctx,value){return path.resolve(ctx.workspace,requireText(value,'path',16000));}
function areaRoot(ctx,which='private'){if(!['private','shared'].includes(which))throw new Error('Choose private or shared scope');const root=path.resolve(which==='shared'?path.join(ctx.dataDir,'shared'):ctx.workspace);fs.mkdirSync(root,{recursive:true});return root;}
function contained(root,value){
  const target=path.resolve(root,requireText(value,'path',16000)),relative=path.relative(root,target);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('Path must stay inside the selected knowledge area');
  for(let current=target;current!==root;current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw new Error('Knowledge paths may not cross symlinks or junctions');
  return target;
}
function saveArtifact(ctx,value,object){
  const file=contained(areaRoot(ctx),value),bytes=Buffer.from((typeof object==='string'?object:JSON.stringify(object,null,2))+'\n');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});
  return {path:file,bytes:bytes.length,sha256:sha(bytes)};
}
function decodeEntities(value){return String(value).replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi,entity=>{
  const known={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '};if(known[entity.toLowerCase()])return known[entity.toLowerCase()];
  const code=entity[2].toLowerCase()==='x'?parseInt(entity.slice(3,-1),16):parseInt(entity.slice(2,-1),10);return code>0&&code<=0x10ffff?String.fromCodePoint(code):entity;
});}
function normalizeHTMLText(value){return decodeEntities(value).replace(/[ \t]+/g,' ').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
// One forward scan, including malformed input. Global <[^>]*> / paired-tag
// regexes repeatedly rescan suffixes when a remote page omits delimiters.
function parseHTML(value,base){
  const source=String(value),lower=source.toLowerCase(),parts=[],titleParts=[],links=[],seen=new Set();let index=0,inTitle=false,suppressed=null,anchor=null;
  const append=text=>{parts.push(text);if(inTitle)titleParts.push(text);if(anchor)anchor.parts.push(text);};
  const closeAnchor=()=>{if(anchor&&links.length<100&&base){try{const url=httpURL(new URL(decodeEntities(anchor.href),base).href).href;if(!seen.has(url)){seen.add(url);links.push({url,text:normalizeHTMLText(anchor.parts.join('')).slice(0,300)});}}catch{}}anchor=null;};
  while(index<source.length){
    if(suppressed){
      const marker='</'+suppressed,at=lower.indexOf(marker,index);if(at<0)break;
      const next=lower[at+marker.length];if(next&&!/[\s/>]/.test(next)){index=at+marker.length;continue;}
      index=at;suppressed=null;
    }
    const at=source.indexOf('<',index);if(at<0){append(source.slice(index));break;}if(at>index)append(source.slice(index,at));
    if(source.startsWith('<!--',at)){const end=source.indexOf('-->',at+4);if(end<0)break;index=end+3;continue;}
    let end=at+1,quote=null,nested=false;
    for(;end<source.length;end++){
      const char=source[end];if(quote){if(char===quote)quote=null;continue;}
      if(char==='"'||char==="'"){quote=char;continue;}if(char==='>')break;if(char==='<'){nested=true;break;}
    }
    if(end>=source.length){append(source.slice(at));break;}
    if(nested){append(source.slice(at,end));index=end;continue;}
    const token=source.slice(at+1,end);index=end+1;let cursor=0;while(/\s/.test(token[cursor]||'')&&cursor<token.length)cursor++;
    const closing=token[cursor]==='/';if(closing)cursor++;const start=cursor;while(/[A-Za-z0-9:-]/.test(token[cursor]||'')&&cursor<token.length)cursor++;
    const name=token.slice(start,cursor).toLowerCase();if(!name){append(' ');continue;}
    if(closing){if(name==='title')inTitle=false;if(name==='a')closeAnchor();if(/^(?:p|div|h[1-6]|li|tr|section|article)$/.test(name))append('\n');else append(' ');continue;}
    if(['script','style','noscript'].includes(name)){suppressed=name;continue;}
    if(name==='title')inTitle=true;
    if(name==='a'){
      closeAnchor();let href;
      while(cursor<token.length){
        while(cursor<token.length&&/[\s/]/.test(token[cursor]))cursor++;const attributeStart=cursor;
        while(cursor<token.length&&!/[\s=/>]/.test(token[cursor]))cursor++;const attribute=token.slice(attributeStart,cursor).toLowerCase();
        if(cursor===attributeStart){cursor++;continue;}while(cursor<token.length&&/\s/.test(token[cursor]))cursor++;
        if(token[cursor]!=='=')continue;cursor++;while(cursor<token.length&&/\s/.test(token[cursor]))cursor++;
        const delimiter=token[cursor]==='"'||token[cursor]==="'"?token[cursor++]:null,valueStart=cursor;
        if(delimiter){while(cursor<token.length&&token[cursor]!==delimiter)cursor++;}else while(cursor<token.length&&!/[\s>]/.test(token[cursor]))cursor++;
        const attributeValue=token.slice(valueStart,cursor);if(delimiter&&token[cursor]===delimiter)cursor++;if(attribute==='href')href=attributeValue;
      }
      if(href!==undefined)anchor={href,parts:[]};
    }
    append(name==='br'?'\n':' ');
  }
  closeAnchor();return{text:normalizeHTMLText(parts.join('')),title:normalizeHTMLText(titleParts.join('')).slice(0,500),links};
}
function htmlText(value){return parseHTML(value).text;}
async function request(url,{ctx={},method='GET',maxBytes=262144,timeoutMs=15000}={}){
  const timeout=AbortSignal.timeout(cap(timeoutMs,100,30000,15000)),signal=ctx.signal?AbortSignal.any([ctx.signal,timeout]):timeout;
  const redirects=[],visited=new Set();let current=httpURL(url);
  for(let count=0;count<=5;count++){
    signal.throwIfAborted();if(visited.has(current.href))throw new Error('Redirect loop detected');visited.add(current.href);
    const response=await(ctx.fetchImpl||fetch)(current,{method,redirect:'manual',signal,headers:{accept:'text/html,application/json,text/plain,application/xml;q=0.8,*/*;q=0.2','user-agent':'NimbusResearch/0.2'}});
    if([301,302,303,307,308].includes(response.status)&&response.headers.get('location')){
      const next=httpURL(new URL(response.headers.get('location'),current).href);redirects.push({from:current.href,status:response.status,to:next.href});await response.body?.cancel();if(count===5)throw new Error('Source exceeded five redirects');current=next;continue;
    }
    let truncated=false,total=0;const chunks=[];
    if(method!=='HEAD'&&response.body){const reader=response.body.getReader();try{for(;;){const {value,done}=await reader.read();if(done)break;const available=maxBytes-total;if(value.length>available){if(available>0)chunks.push(Buffer.from(value.subarray(0,available)));total+=Math.max(0,available);truncated=true;await reader.cancel();break;}chunks.push(Buffer.from(value));total+=value.length;}}finally{reader.releaseLock();}}
    else await response.body?.cancel();
    const bytes=Buffer.concat(chunks);return {requestUrl:httpURL(url).href,url:current.href,status:response.status,ok:response.ok,contentType:response.headers.get('content-type')||'',redirects,bytes,truncated,retrievedAt:now(),headers:{etag:response.headers.get('etag'),lastModified:response.headers.get('last-modified'),retryAfter:response.headers.get('retry-after')}};
  }
  throw new Error('Redirect limit reached');
}
async function fetchEvidence(args,ctx){
  const source=await request(args.url,{ctx,maxBytes:cap(args.maxBytes,1024,2097152,262144),timeoutMs:args.timeoutMs});
  const {bytes,...meta}=source,maxChars=cap(args.maxChars,100,80000,16000),binary=bytes.includes(0)||!/^text\/|(?:json|xml|javascript|x-www-form-urlencoded)/i.test(source.contentType)&&source.contentType!=='';
  let decoded='';if(!binary){const charset=source.contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1]||'utf-8';try{decoded=new TextDecoder(charset).decode(bytes);}catch{decoded=bytes.toString('utf8');}}
  const html=/html/i.test(source.contentType)||/^\s*<!doctype html|^\s*<html/i.test(decoded),parsed=html?parseHTML(decoded,source.url):null,extracted=parsed?parsed.text:decoded;
  const result={...meta,capturedBytes:bytes.length,sha256:sha(bytes),hashScope:'captured_response_bytes',complete:!source.truncated,supportedText:!binary,title:parsed?.title||'',content:{text:extracted.slice(0,maxChars),truncated:source.truncated||extracted.length>maxChars,extraction:html?'basic_html_text_not_browser_rendering':'response_text'},links:parsed?.links||[]};
  if(binary)result.note='Binary content was not interpreted as text. Use a format-specific extractor or browser.';
  if(args.saveAs)result.saved=saveArtifact(ctx,args.saveAs,result);
  return result;
}

async function searchConnectors(args,ctx){
  const query=requireText(args.query,'query',2000),limit=cap(args.limit,1,20,5),bindings=ctx.bindings||new Map();
  const candidates=[...bindings].filter(([name,binding])=>binding.readOnly&&(/(?:brave|tavily|exa|searx|web.?search|search.?web)/i.test(name)||args.connector===name)&&/search/i.test(binding.tool||name));
  const choice=args.connector?candidates.find(([name])=>name===args.connector):candidates[0];
  if(!choice)return{ok:false,available:false,query,configuredSearchTools:candidates.map(([name])=>name),error:args.connector?'Requested read-only web-search connector is not advertised':'No read-only web-search MCP connector is configured for this worker',setup:'Configure Brave Search, Tavily, Exa, Searx or another read-only search MCP connector in Nimbus. scholar_search remains available for scholarly metadata.'};
  const [name,binding]=choice;
  let advertised=(ctx.availableTools||[]).find(tool=>(tool.function?.name||tool.name)===name),schema=advertised?.function?.parameters||advertised?.inputSchema;
  if(!schema){const listed=await binding.client.listTools();schema=listed.tools?.find(tool=>tool.name===binding.tool)?.inputSchema;}
  const properties=schema?.properties||{},queryKey=['query','q','search_query','searchTerm'].find(key=>properties[key]),limitKey=['count','limit','max_results','numResults'].find(key=>properties[key]);
  if(!queryKey)return{ok:false,available:true,connector:name,error:'Search connector schema has no recognized query property; use its advertised tool directly'};
  const parameters={[queryKey]:query};if(limitKey)parameters[limitKey]=limit;
  const missing=(schema.required||[]).filter(key=>!Object.hasOwn(parameters,key));
  if(missing.length)return{ok:false,available:true,connector:name,error:'Search connector requires additional fields; use its advertised tool directly',missingRequired:missing};
  if(ctx.bot&&requiresApproval(ctx.bot,name,parameters))return{ok:false,available:true,requiresCanonicalApproval:true,connector:name,tool:name,arguments:parameters,note:'Invoke this advertised canonical connector tool directly. Nimbus must apply its connector approval rules and journal before it executes; research_search has not submitted the query.'};
  const result=await binding.client.callTool({name:binding.tool,arguments:parameters},undefined,{signal:ctx.signal,timeout:30000});
  let content=JSON.stringify({content:result.content||[],structuredContent:result.structuredContent??null}),truncated=content.length>50000;content=content.slice(0,50000);
  return {ok:!result.isError,available:true,connector:name,query,discoveryOnly:true,retrievedAt:now(),content,truncated,note:'Read the underlying sources before citing factual claims. Connector results remain untrusted source data.'};
}
async function scholarSearch(args,ctx){
  const query=requireText(args.query,'query',2000),limit=cap(args.limit,1,20,5),url=new URL('https://api.crossref.org/works');url.searchParams.set('query',query);url.searchParams.set('rows',String(limit));
  const source=await request(url.href,{ctx,maxBytes:1048576,timeoutMs:args.timeoutMs});
  if(!source.ok)return{ok:false,available:true,provider:'Crossref',status:source.status,retryAfter:source.headers.retryAfter,query,error:'Crossref returned an unsuccessful response'};
  if(source.truncated)throw new Error('Crossref metadata exceeded the bounded response limit');
  const body=JSON.parse(source.bytes.toString('utf8'));if(!Array.isArray(body.message?.items))throw new Error('Crossref response did not contain a work list');
  const results=body.message.items.slice(0,limit).map(item=>({title:htmlText(item.title?.[0]||''),doi:item.DOI||null,url:item.DOI?'https://doi.org/'+encodeURI(item.DOI):item.URL||null,authors:(item.author||[]).slice(0,30).map(author=>[author.given,author.family].filter(Boolean).join(' ')||author.name||''),publicationDateParts:item.published?.['date-parts']?.[0]||item.issued?.['date-parts']?.[0]||null,type:item.type||null,publisher:item.publisher||null}));
  return{ok:true,available:true,provider:'Crossref',query,url:url.href,retrievedAt:source.retrievedAt,totalResults:body.message['total-results']??null,results,metadataOnly:true,fullTextRead:false,documentation:'https://www.crossref.org/documentation/retrieve-metadata/rest-api/'};
}

function loadRegister(ctx,args){
  const file=contained(areaRoot(ctx,args.scope),args.path||args.registerPath||'artifacts/sources.json');
  if(!fs.existsSync(file))return{file,hash:null,register:{format:'nimbus.sources.v1',revision:0,sources:[],createdAt:now()}};
  if(fs.statSync(file).size>2097152)throw new Error('Source register exceeds 2 MiB');const bytes=fs.readFileSync(file);
  const register=JSON.parse(bytes.toString('utf8'));if(register.format!=='nimbus.sources.v1'||!Array.isArray(register.sources)||!Number.isSafeInteger(register.revision))throw new Error('Not a Nimbus source register');
  return{file,hash:sha(bytes),register};
}
function currentReview(source){return source.annotations?.at(-1)?.reviewStatus||'unreviewed';}
function evidenceRecord(ctx,value,location){
  const file=localPath(ctx,value);if(fs.statSync(file).size>2097152)throw new Error('Evidence capture exceeds 2 MiB');const bytes=fs.readFileSync(file);
  const evidence=JSON.parse(bytes.toString('utf8'));
  if(typeof evidence.content?.text!=='string'||!evidence.requestUrl||!evidence.url||!evidence.sha256)throw new Error('evidencePath must be a research_fetch capture');
  const canonical=httpURL(location).href;if(![evidence.requestUrl,evidence.url].includes(canonical))throw new Error('Capture URL does not match the source location');
  return{path:file,sha256:sha(bytes),capturedContentHash:evidence.sha256,requestUrl:evidence.requestUrl,url:evidence.url,status:evidence.status,retrievedAt:evidence.retrievedAt,complete:evidence.complete&&!evidence.content.truncated};
}
function updateRegister(args,ctx){
  const loaded=loadRegister(ctx,args),{file,hash,register}=loaded;
  if(args.action==='read')return{path:file,exists:hash!==null,sha256:hash,...register};
  if(!['add','annotate'].includes(args.action))throw new Error('Choose read, add or annotate');
  if(args.expectedRevision!==register.revision)throw new Error(`Register revision conflict: read the register and pass expectedRevision ${register.revision}`);
  const timestamp=now(),actor=String(ctx.botId??ctx.bot?.id??'worker');
  if(args.action==='add'){
    const source=args.source;if(!source||typeof source!=='object')throw new Error('add requires source metadata');
    const title=requireText(source.title,'source.title',1000),rawLocation=requireText(source.location,'source.location',16000);
    let location;try{location=httpURL(rawLocation).href;}catch(error){if(/^[a-z][a-z0-9+.-]*:\/\//i.test(rawLocation))throw error;location=localPath(ctx,rawLocation);}
    const id=source.id?requireText(source.id,'source.id',100):'src_'+sha(Buffer.from(location)).slice(0,16);if(!/^[a-zA-Z0-9_.-]+$/.test(id))throw new Error('Source ID must use letters, digits, dot, dash or underscore');
    if(register.sources.some(item=>item.id===id||item.location===location))throw new Error('Source already registered; annotate it instead of overwriting its history');
    const item={id,title,location,registeredAt:timestamp,registeredBy:actor,annotations:[]};
    for(const key of ['author','publishedAt','notes'])if(source[key]!==undefined)item[key]=requireText(source[key],'source.'+key,8000);
    if(source.evidencePath)item.evidence=evidenceRecord(ctx,source.evidencePath,location);
    if(!/^https?:\/\//i.test(location)){const exists=fs.existsSync(location);item.file={exists};if(exists){if(fs.statSync(location).size>20971520)throw new Error('Registered local source exceeds 20 MiB');const bytes=fs.readFileSync(location);item.file={exists:true,sha256:sha(bytes),bytes:bytes.length,observedAt:timestamp};}}
    register.sources.push(item);
  }else{
    const item=register.sources.find(source=>source.id===args.sourceId);if(!item)throw new Error('Unknown sourceId');
    const note=requireText(args.note,'note',8000),reviewStatus=args.reviewStatus||currentReview(item);if(!['unreviewed','reviewed','disputed','superseded'].includes(reviewStatus))throw new Error('Invalid review status');
    item.annotations.push({note,reviewStatus,at:timestamp,by:actor});
  }
  register.revision++;register.updatedAt=timestamp;
  const current=fs.existsSync(file)?sha(fs.readFileSync(file)):null;if(current!==hash)throw new Error('Source register changed during this operation; read its current revision');
  fs.mkdirSync(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.part',bytes=Buffer.from(JSON.stringify(register,null,2)+'\n');if(bytes.length>2097152)throw new Error('Register update would exceed the 2 MiB limit; create a separate focused register');fs.writeFileSync(temporary,bytes,{flag:'wx'});
  try{fs.renameSync(temporary,file);}catch(error){fs.unlinkSync(temporary);throw error;}
  return{path:file,sha256:sha(bytes),bytes:bytes.length,...register};
}
function searchKnowledge(args,ctx){
  const query=requireText(args.query,'query',1000),base=areaRoot(ctx,args.scope),root=args.path?contained(base,args.path):base;
  const limit=cap(args.limit,1,100,30),maxFiles=cap(args.maxFiles,1,2000,500),context=cap(args.contextLines,0,5,1),mode=args.mode||'all';
  if(!['all','any','phrase'].includes(mode))throw new Error('Choose all, any or phrase matching');
  const terms=(mode==='phrase'?[query]:query.split(/\s+/)).map(term=>term.toLocaleLowerCase()),matches=[],skipped=[];let examined=0,scanned=0,visited=0,truncated=false;
  const walk=directory=>{
    for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      ctx.signal?.throwIfAborted();if(matches.length>=limit||scanned>=maxFiles||++visited>maxFiles*10){truncated=true;return;}
      const file=path.join(directory,entry.name);
      if(entry.isSymbolicLink()){skipped.push({path:file,reason:'symlink'});continue;}
      if(entry.isDirectory()){if(!['.git','node_modules','.gradle','backups'].includes(entry.name))walk(file);continue;}
      if(!entry.isFile())continue;scanned++;if(!/(?:\.md|\.txt|\.json|\.csv|\.tsv|\.log|\.html?|\.xml)$/i.test(entry.name))continue;
      examined++;if(fs.statSync(file).size>524288){skipped.push({path:file,reason:'file exceeds 512 KiB'});continue;}
      const value=fs.readFileSync(file,'utf8');if(value.includes('\0')){skipped.push({path:file,reason:'binary'});continue;}
      const lines=value.split(/\r?\n/);
      for(let index=0;index<lines.length;index++){
        const line=lines[index].toLocaleLowerCase(),hits=terms.map(term=>line.includes(term));
        if(mode==='any'?hits.some(Boolean):hits.every(Boolean)){matches.push({path:file,line:index+1,text:lines[index].slice(0,2000),context:lines.slice(Math.max(0,index-context),index+context+1).map((text,offset)=>({line:Math.max(0,index-context)+offset+1,text:text.slice(0,2000)}))});if(matches.length>=limit){truncated=true;return;}}
      }
    }
  };
  if(!fs.statSync(root).isDirectory())throw new Error('Knowledge search path must be a directory');walk(root);
  return{root,query,mode,examinedFiles:examined,scannedFiles:scanned,visitedEntries:visited,matches,skipped:skipped.slice(0,100),truncated,note:'Literal text evidence only; search coverage is bounded by the reported limits.'};
}
function auditEvidence(args,ctx){
  if(!Array.isArray(args.claims)||!args.claims.length||args.claims.length>100)throw new Error('Provide 1 to 100 claims');
  const loaded=loadRegister(ctx,{...args,path:args.registerPath}),sources=new Map(loaded.register.sources.map(source=>[source.id,source])),ids=new Set();
  for(const claim of args.claims){requireText(claim.id,'claim.id',100);requireText(claim.claim,'claim.claim',8000);if(ids.has(claim.id))throw new Error('Claim IDs must be unique');ids.add(claim.id);if(!Array.isArray(claim.citations)||claim.citations.length>20)throw new Error('Each claim needs a bounded citations array');}
  const claims=args.claims.map(claim=>{
    const issues=[],citations=claim.citations.map(citation=>{
      const source=sources.get(citation.sourceId);if(!source){issues.push('missing_source:'+citation.sourceId);return{sourceId:citation.sourceId,exists:false};}
      const entry={sourceId:source.id,exists:true,reviewStatus:currentReview(source),evidenceStable:false};
      if(entry.reviewStatus!=='reviewed')issues.push(entry.reviewStatus+'_source:'+source.id);
      let evidenceText;
      try{
        if(source.evidence){if(fs.statSync(source.evidence.path).size>2097152)throw new Error('Evidence capture exceeds 2 MiB');const bytes=fs.readFileSync(source.evidence.path);entry.evidenceStable=sha(bytes)===source.evidence.sha256;if(entry.evidenceStable)evidenceText=JSON.parse(bytes.toString('utf8')).content?.text;entry.captureComplete=source.evidence.complete;entry.captureStatus=source.evidence.status;if(!(entry.captureStatus>=200&&entry.captureStatus<300))issues.push('unsuccessful_http_capture:'+source.id);}
        else if(source.file?.exists){if(fs.statSync(source.location).size>20971520)throw new Error('Local source now exceeds 20 MiB');const bytes=fs.readFileSync(source.location);entry.evidenceStable=sha(bytes)===source.file.sha256;evidenceText=entry.evidenceStable?bytes.toString('utf8'):undefined;}
      }catch(error){entry.evidenceError=cleanError(error);}
      if(!entry.evidenceStable)issues.push('missing_or_changed_evidence:'+source.id);
      if(citation.quote!==undefined){const quote=requireText(citation.quote,'quote',8000);entry.exactQuoteFound=typeof evidenceText==='string'&&evidenceText.includes(quote);if(!entry.exactQuoteFound)issues.push('quote_not_found:'+source.id);}
      return entry;
    });
    if(!citations.length)issues.push('uncited_claim');
    const conflicts=(claim.conflictsWith||[]).map(id=>({claimId:id,exists:ids.has(id)}));if(conflicts.length)issues.push('explicit_conflict_requires_reconciliation');
    return{id:claim.id,claim:claim.claim,citations,conflicts,issues,verdict:issues.length?'needs_review':'evidence_linked'};
  });
  const result={registerPath:loaded.file,registerRevision:loaded.register.revision,registerHash:loaded.hash,auditedAt:now(),claims,summary:{claims:claims.length,evidenceLinked:claims.filter(claim=>claim.verdict==='evidence_linked').length,needsReview:claims.filter(claim=>claim.verdict==='needs_review').length},note:'This checks provenance and exact quotation coverage. It does not establish semantic truth, causality, currency or applicability.'};
  if(args.saveAs)result.saved=saveArtifact(ctx,args.saveAs,result);return result;
}
function compareDocuments(args,ctx){
  const files=[localPath(ctx,args.before),localPath(ctx,args.after)],contents=files.map(file=>{const stat=fs.statSync(file);if(!stat.isFile()||stat.size>2097152)throw new Error('Compare regular text files no larger than 2 MiB');const bytes=fs.readFileSync(file);if(bytes.includes(0))throw new Error('Binary files require a format-specific comparison');return{bytes,lines:bytes.toString('utf8').split(/\r?\n/)};});
  const [before,after]=contents,normalized=contents.map(content=>content.lines.map(line=>args.ignoreWhitespace?line.trim().replace(/\s+/g,' '):line)),a=normalized[0],b=normalized[1],limit=cap(args.maxChanges,1,200,60),changes=[];let inserted=0,deleted=0,unchanged=0,method;
  if(a.length<=600&&b.length<=600){
    method='line_LCS';const table=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
    for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i][j]=a[i]===b[j]?table[i+1][j+1]+1:Math.max(table[i+1][j],table[i][j+1]);
    let i=0,j=0;while(i<a.length||j<b.length){if(i<a.length&&j<b.length&&a[i]===b[j]){unchanged++;i++;j++;}else if(j<b.length&&(i===a.length||table[i][j+1]>=table[i+1][j])){inserted++;if(changes.length<limit)changes.push({type:'added',line:j+1,text:after.lines[j].slice(0,2000)});j++;}else{deleted++;if(changes.length<limit)changes.push({type:'removed',line:i+1,text:before.lines[i].slice(0,2000)});i++;}}
  }else{
    method='bounded_prefix_suffix_region';let prefix=0,suffix=0;while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
    unchanged=prefix+suffix;deleted=a.length-unchanged;inserted=b.length-unchanged;
    for(let i=prefix;i<a.length-suffix&&changes.length<limit;i++)changes.push({type:'removed_region',line:i+1,text:before.lines[i].slice(0,2000)});
    for(let j=prefix;j<b.length-suffix&&changes.length<limit;j++)changes.push({type:'added_region',line:j+1,text:after.lines[j].slice(0,2000)});
  }
  const result={before:{path:files[0],sha256:sha(before.bytes),lines:a.length},after:{path:files[1],sha256:sha(after.bytes),lines:b.length},byteIdentical:before.bytes.equals(after.bytes),normalizedIdentical:a.length===b.length&&a.every((line,index)=>line===b[index]),method,ignoreWhitespace:!!args.ignoreWhitespace,summary:{inserted,deleted,unchanged},changes,truncated:inserted+deleted>changes.length,note:method==='line_LCS'?'Line-aligned textual comparison; no semantic interpretation.':'Large files report one bounded changed region; inserted/deleted region counts are not a minimal edit script.'};
  if(args.saveAs)result.saved=saveArtifact(ctx,args.saveAs,result);return result;
}
async function checkLinks(args,ctx){
  if(!Array.isArray(args.urls)||!args.urls.length||args.urls.length>25)throw new Error('Provide 1 to 25 URLs');
  const results=[];for(let offset=0;offset<args.urls.length;offset+=4){ctx.signal?.throwIfAborted();results.push(...await Promise.all(args.urls.slice(offset,offset+4).map(async url=>{
    try{let source=await request(url,{ctx,method:'HEAD',maxBytes:1024,timeoutMs:args.timeoutMs}),method='HEAD';if([405,501].includes(source.status)){source=await request(url,{ctx,method:'GET',maxBytes:1024,timeoutMs:args.timeoutMs});method='GET';}return{inputUrl:url,url:source.url,status:source.status,ok:source.ok,method,redirects:source.redirects,checkedAt:source.retrievedAt};}
    catch(error){ctx.signal?.throwIfAborted();return{inputUrl:url,ok:false,error:cleanError(error),checkedAt:now()};}
  })));}
  return{results,summary:{total:results.length,available:results.filter(result=>result.ok).length,failed:results.filter(result=>!result.ok).length},note:'HTTP availability only. Fragments, claim support, full page rendering and future access are not verified.'};
}
function citationFormat(args,ctx){
  if(!Array.isArray(args.sourceIds)||!args.sourceIds.length||args.sourceIds.length>100)throw new Error('Provide 1 to 100 source IDs');
  if(new Set(args.sourceIds).size!==args.sourceIds.length)throw new Error('Source IDs must be unique; duplicate citation export is not allowed');
  const loaded=loadRegister(ctx,{...args,path:args.registerPath}),sources=args.sourceIds.map(id=>{const source=loaded.register.sources.find(source=>source.id===id);if(!source)throw new Error('Unknown source ID: '+id);return source;});
  const format=args.format||'markdown';let content;
  if(format==='json')content=JSON.stringify(sources.map(source=>({id:source.id,title:source.title,location:source.location,...(source.author?{author:source.author}:{}),...(source.publishedAt?{publishedAt:source.publishedAt}:{}),...(source.evidence?.retrievedAt?{retrievedAt:source.evidence.retrievedAt}:{}),reviewStatus:currentReview(source)})),null,2);
  else if(format==='markdown')content=sources.map(source=>{const label=source.title.replace(/[\[\]\\]/g,'\\$&'),reference=/^https?:\/\//i.test(source.location)?`[${label}](${source.location.replace(/[()\s]/g,char=>encodeURIComponent(char))})`:`${label} — ${source.location}`;return`- ${reference}${source.author?' — '+source.author:''}${source.publishedAt?' ('+source.publishedAt+')':''}. ${source.evidence?.retrievedAt?'Retrieved '+source.evidence.retrievedAt+'. ':''}Source ID: ${source.id}; review: ${currentReview(source)}.`;}).join('\n');
  else if(format==='bibtex'){const escape=value=>String(value).replace(/[\\{}%&#_$~^]/g,char=>({'\\':'\\textbackslash{}','~':'\\textasciitilde{}','^':'\\textasciicircum{}'}[char]||'\\'+char));content=sources.map(source=>`@misc{${source.id},\n  title = {${escape(source.title)}},\n  ${source.author?'author = {'+escape(source.author)+'},\n  ':''}${/^https?:\/\//i.test(source.location)?'url':'howpublished'} = {${escape(source.location)}},\n  note = {${escape('Review status: '+currentReview(source)+(source.publishedAt?'; supplied publication date: '+source.publishedAt:''))}}\n}`).join('\n\n');}
  else throw new Error('Choose markdown, json or bibtex');
  if(Buffer.byteLength(content)>262144)throw new Error('Citation export exceeds 256 KiB; select fewer sources or a more compact format');
  const result={format,content,sourceIds:sources.map(source=>source.id),registerPath:loaded.file,registerRevision:loaded.register.revision,note:'Missing authors, dates and publication types are not invented.'};if(args.saveAs)result.saved=saveArtifact(ctx,args.saveAs,content);return result;
}

export async function execute(name,args={},ctx={}){
  ctx.signal?.throwIfAborted();
  if(name==='research_fetch')return fetchEvidence(args,ctx);
  if(name==='research_search')return searchConnectors(args,ctx);
  if(name==='scholar_search')return scholarSearch(args,ctx);
  if(name==='source_register')return updateRegister(args,ctx);
  if(name==='knowledge_search')return searchKnowledge(args,ctx);
  if(name==='evidence_audit')return auditEvidence(args,ctx);
  if(name==='document_compare')return compareDocuments(args,ctx);
  if(name==='check_links')return checkLinks(args,ctx);
  if(name==='citation_format')return citationFormat(args,ctx);
  throw new Error('Unknown research tool: '+name);
}
