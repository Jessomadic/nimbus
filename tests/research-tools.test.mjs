import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {execute,tools,roleTools} from '../runtime/toolsets/research.js';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-research-test-')),workspace=path.join(root,'worker'),dataDir=path.join(root,'data');fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(dataDir,{recursive:true});
  t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-research-test-/);fs.rmSync(root,{recursive:true,force:true});});
  return{root,workspace,dataDir,ctx:{workspace,dataDir,root,botId:41}};
}
async function server(t,handler){const instance=http.createServer(handler);await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));t.after(async()=>{instance.closeAllConnections();await new Promise(resolve=>instance.close(resolve));});return`http://127.0.0.1:${instance.address().port}`;}
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value);}

test('research tools provide distinct schemas and specialist role mappings',()=>{
  assert.equal(new Set(tools.map(tool=>tool.function.name)).size,9);
  for(const tool of tools)assert.equal(tool.function.parameters.additionalProperties,false);
  for(const name of roleTools.researcher)assert.ok(tools.some(tool=>tool.function.name===name));
  assert.ok(roleTools['knowledge-curator'].includes('knowledge_search'));
});
test('HTTP source capture follows bounded redirects, strips active HTML and saves hash-backed evidence',async t=>{
  const {ctx,workspace}=fixture(t),base=await server(t,(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/page'});return res.end();}
    res.writeHead(200,{'content-type':'text/html; charset=utf-8',etag:'fixture-v1'});res.end('<title>Known &amp; observed</title><script>DO_NOT_INCLUDE</script><h1>Exact source claim</h1><p>42 verified widgets.</p><a href="/reference">Reference</a>');
  });
  const result=await execute('research_fetch',{url:base+'/redirect',saveAs:'artifacts/capture.json'},ctx);
  assert.equal(result.status,200);assert.equal(result.redirects.length,1);assert.equal(result.url,base+'/page');assert.equal(result.title,'Known & observed');assert.match(result.content.text,/42 verified widgets/);assert.doesNotMatch(result.content.text,/DO_NOT_INCLUDE/);assert.equal(result.links[0].url,base+'/reference');assert.equal(result.sha256.length,64);assert.equal(result.complete,true);
  const saved=JSON.parse(fs.readFileSync(path.join(workspace,'artifacts/capture.json'),'utf8'));assert.equal(saved.sha256,result.sha256);
  await assert.rejects(execute('research_fetch',{url:base,saveAs:'artifacts/capture.json'},ctx),/EEXIST/);
  await assert.rejects(execute('research_fetch',{url:base,saveAs:'../escape.json'},ctx),/inside/);
});
test('HTTP capture reports binary/size limits and rejects redirect loops and unsafe URL credentials',async t=>{
  const {ctx}=fixture(t),base=await server(t,(req,res)=>{
    if(req.url==='/loop'){res.writeHead(302,{location:'/loop'});return res.end();}
    if(req.url==='/binary'){res.writeHead(200,{'content-type':'application/octet-stream'});return res.end(Buffer.from([0,1,2,3]));}
    res.writeHead(200,{'content-type':'text/plain'});res.end('x'.repeat(3000));
  });
  const bounded=await execute('research_fetch',{url:base,maxBytes:1024,maxChars:100},ctx);assert.equal(bounded.capturedBytes,1024);assert.equal(bounded.complete,false);assert.equal(bounded.content.text.length,100);
  const binary=await execute('research_fetch',{url:base+'/binary'},ctx);assert.equal(binary.supportedText,false);assert.equal(binary.content.text,'');
  await assert.rejects(execute('research_fetch',{url:base+'/loop'},ctx),/loop/);
  await assert.rejects(execute('research_fetch',{url:'https://user:password@example.invalid/'},ctx),/without embedded credentials/);
  await assert.rejects(execute('research_fetch',{url:'file:///private'},ctx),/HTTP/);
});
test('HTTP source cancellation and timeout stop awaiting the response',async t=>{
  const {ctx}=fixture(t),base=await server(t,(req,res)=>{setTimeout(()=>{if(!res.destroyed)res.end('late');},2000).unref();});
  const abort=new AbortController(),pending=execute('research_fetch',{url:base,timeoutMs:30000},{...ctx,signal:abort.signal});setTimeout(()=>abort.abort(new Error('Fixture cancelled')),25);
  await assert.rejects(pending,/Fixture cancelled/);
  await assert.rejects(execute('research_fetch',{url:base,timeoutMs:100},ctx),/timeout|timed out/i);
});
test('malformed remote HTML is scanned once and preserves bounded evidence without regex backtracking',{timeout:5000},async t=>{
  const {ctx}=fixture(t),malformed='<'.repeat(300000)+'<p>Visible final evidence</p>',base=await server(t,(req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(req.url==='/title'?'<title>'.repeat(40000):req.url==='/script'?'<script>'.repeat(40000):req.url==='/anchor'?'<a href="/x">'.repeat(30000)+'visible':malformed);});
  const result=await execute('research_fetch',{url:base,maxBytes:1048576,maxChars:100},ctx);assert.equal(result.complete,true);assert.equal(result.content.truncated,true);assert.equal(result.content.text,'<'.repeat(100));assert.equal(result.links.length,0);
  const title=await execute('research_fetch',{url:base+'/title',maxBytes:1048576,maxChars:100},ctx);assert.equal(title.complete,true);assert.equal(title.title,'');assert.equal(title.content.text,'');
  const script=await execute('research_fetch',{url:base+'/script',maxBytes:1048576,maxChars:100},ctx);assert.equal(script.content.text,'');
  const anchor=await execute('research_fetch',{url:base+'/anchor',maxBytes:1048576,maxChars:100},ctx);assert.equal(anchor.content.text,'visible');assert.equal(anchor.links.length,1);
});
test('web search integrates only an advertised read-only MCP schema and reports missing setup honestly',async t=>{
  const {ctx}=fixture(t);const missing=await execute('research_search',{query:'known query'},ctx);assert.equal(missing.available,false);assert.equal(missing.ok,false);
  let submitted;const name='mcp__brave-search__brave_web_search',binding={readOnly:true,tool:'brave_web_search',client:{callTool:async request=>{submitted=request;return{content:[{type:'text',text:'Known result https://example.test/'}]};}}};
  const result=await execute('research_search',{query:'known query',limit:3},{...ctx,bindings:new Map([[name,binding]]),availableTools:[{function:{name,parameters:{type:'object',properties:{query:{type:'string'},count:{type:'integer'}},required:['query']}}}]});
  assert.deepEqual(submitted,{name:'brave_web_search',arguments:{query:'known query',count:3}});assert.equal(result.discoveryOnly,true);assert.match(result.content,/Known result/);
  const noPermission=await execute('research_search',{query:'known query'},{...ctx,bindings:new Map([[name,{...binding,readOnly:false}]])});assert.equal(noPermission.available,false);
});
test('search schema requirements are not guessed or silently omitted',async t=>{
  const {ctx}=fixture(t),name='mcp__web-search__search';let called=false;
  const result=await execute('research_search',{query:'query'},{...ctx,bindings:new Map([[name,{readOnly:true,tool:'search',client:{callTool:async()=>{called=true;}}}]]),availableTools:[{function:{name,parameters:{properties:{query:{type:'string'},tenant:{type:'string'}},required:['query','tenant']}}}]});
  assert.equal(called,false);assert.deepEqual(result.missingRequired,['tenant']);
});
test('search wrapper does not bypass canonical connector approval rules',async t=>{
  const {ctx}=fixture(t),name='mcp__brave-search__brave_web_search';let called=false;
  const result=await execute('research_search',{query:'restricted evidence'},{...ctx,bot:{approval_rules:[name],allow_rules:[]},bindings:new Map([[name,{readOnly:true,tool:'brave_web_search',client:{callTool:async()=>{called=true;}}}]]),availableTools:[{function:{name,parameters:{properties:{query:{type:'string'}},required:['query']}}}]});
  assert.equal(called,false);assert.equal(result.requiresCanonicalApproval,true);assert.equal(result.tool,name);assert.deepEqual(result.arguments,{query:'restricted evidence'});
});
test('scholarly search encodes queries and preserves year-only publication precision without pretending full text was read',async t=>{
  const {ctx}=fixture(t),base=await server(t,(req,res)=>{assert.match(req.url,/query=optics%26physics/);res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({message:{'total-results':1,items:[{DOI:'10.5555/fixture',title:['Fixture &amp; physics'],author:[{given:'A',family:'Writer'}],published:{'date-parts':[[2024]]},type:'journal-article'}]}}));});
  const result=await execute('scholar_search',{query:'optics&physics',limit:1},{...ctx,fetchImpl:(url,options)=>fetch(base+new URL(url).search,options)});
  assert.equal(result.results[0].title,'Fixture & physics');assert.deepEqual(result.results[0].publicationDateParts,[2024]);assert.equal(result.results[0].url,'https://doi.org/10.5555/fixture');assert.equal(result.metadataOnly,true);assert.equal(result.fullTextRead,false);
});
test('source registers preserve review history and reject stale revisions and conflicting evidence',async t=>{
  const {ctx,workspace}=fixture(t),base=await server(t,(req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Supported exact quotation.');});
  await execute('research_fetch',{url:base,saveAs:'capture.json'},ctx);
  const first=await execute('source_register',{action:'add',expectedRevision:0,source:{id:'fixture',title:'Fixture source',location:base,evidencePath:'capture.json'}},ctx);assert.equal(first.revision,1);assert.equal(first.sources[0].evidence.sha256.length,64);
  await assert.rejects(execute('source_register',{action:'annotate',sourceId:'fixture',expectedRevision:0,note:'stale'},ctx),/revision conflict/);
  const reviewed=await execute('source_register',{action:'annotate',sourceId:'fixture',expectedRevision:1,note:'Read the retained fixture text.',reviewStatus:'reviewed'},ctx);assert.equal(reviewed.revision,2);
  const disputed=await execute('source_register',{action:'annotate',sourceId:'fixture',expectedRevision:2,note:'Applicability disputed.',reviewStatus:'disputed'},ctx);assert.equal(disputed.sources[0].annotations.length,2);assert.equal(disputed.sources[0].annotations[0].reviewStatus,'reviewed');
  assert.ok(fs.existsSync(path.join(workspace,'artifacts','sources.json')));
  await assert.rejects(execute('source_register',{action:'add',expectedRevision:3,source:{title:'Wrong association',location:base+'/different',evidencePath:'capture.json'}},ctx),/does not match/);
});
test('evidence audits verify exact quotes and detect changed captures, missing sources and explicit conflicts',async t=>{
  const {ctx,workspace}=fixture(t),base=await server(t,(req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('Forty-two supported widgets.');});
  await execute('research_fetch',{url:base,saveAs:'capture.json'},ctx);
  await execute('source_register',{action:'add',expectedRevision:0,source:{id:'fixture',title:'Observed source',location:base,evidencePath:'capture.json'}},ctx);
  await execute('source_register',{action:'annotate',sourceId:'fixture',expectedRevision:1,note:'Inspected fixture source.',reviewStatus:'reviewed'},ctx);
  const claims=[{id:'good',claim:'Widgets are mentioned.',citations:[{sourceId:'fixture',quote:'Forty-two supported widgets.'}]},{id:'bad',claim:'A fabricated quotation.',citations:[{sourceId:'fixture',quote:'Not in the source.'},{sourceId:'absent'}],conflictsWith:['good']}];
  const audit=await execute('evidence_audit',{claims,saveAs:'audit.json'},ctx);assert.equal(audit.summary.evidenceLinked,1);assert.equal(audit.claims[0].verdict,'evidence_linked');assert.ok(audit.claims[1].issues.includes('quote_not_found:fixture'));assert.ok(audit.claims[1].issues.includes('missing_source:absent'));
  fs.appendFileSync(path.join(workspace,'capture.json'),' ');const changed=await execute('evidence_audit',{claims:[claims[0]]},ctx);assert.equal(changed.claims[0].verdict,'needs_review');assert.ok(changed.claims[0].issues.includes('missing_or_changed_evidence:fixture'));
});
test('private/shared knowledge searches return real line context and enforce scope bounds',async t=>{
  const {ctx,workspace,dataDir}=fixture(t);write(path.join(workspace,'note.md'),'alpha\nblue widget verified\nomega');write(path.join(dataDir,'shared','note.md'),'shared blue widget\n');write(path.join(workspace,'large.txt'),'x'.repeat(524289));
  const own=await execute('knowledge_search',{query:'blue widget'},ctx);assert.equal(own.matches[0].line,2);assert.equal(own.matches[0].context[0].line,1);assert.ok(own.skipped.some(item=>item.reason.includes('512 KiB')));
  const shared=await execute('knowledge_search',{query:'shared',scope:'shared'},ctx);assert.equal(shared.matches.length,1);assert.match(shared.matches[0].path,/shared/);
  await assert.rejects(execute('knowledge_search',{query:'x',path:'../'},ctx),/inside/);
  const bounded=await execute('knowledge_search',{query:'absent',maxFiles:1},ctx);assert.equal(bounded.scannedFiles,1);assert.equal(bounded.truncated,true);
});
test('a stable quotation on an HTTP error page is not silently promoted to evidence-linked coverage',async t=>{
  const {ctx}=fixture(t),base=await server(t,(req,res)=>{res.writeHead(404,{'content-type':'text/plain'});res.end('Document not found.');});
  await execute('research_fetch',{url:base,saveAs:'missing.json'},ctx);
  await execute('source_register',{action:'add',expectedRevision:0,source:{id:'missing',title:'Missing source',location:base,evidencePath:'missing.json'}},ctx);
  await execute('source_register',{action:'annotate',sourceId:'missing',expectedRevision:1,note:'The error page was inspected.',reviewStatus:'reviewed'},ctx);
  const audit=await execute('evidence_audit',{claims:[{id:'one',claim:'Document content is established.',citations:[{sourceId:'missing',quote:'Document not found.'}]}]},ctx);
  assert.equal(audit.claims[0].verdict,'needs_review');assert.ok(audit.claims[0].issues.includes('unsuccessful_http_capture:missing'));
});
test('document comparison finds line changes and labels the bounded large-file method',async t=>{
  const {ctx,workspace}=fixture(t);write(path.join(workspace,'before.txt'),'alpha\nbeta\ngamma');write(path.join(workspace,'after.txt'),'alpha\nchanged\ngamma');
  const compared=await execute('document_compare',{before:'before.txt',after:'after.txt',saveAs:'comparison.json'},ctx);assert.equal(compared.method,'line_LCS');assert.equal(compared.summary.inserted,1);assert.equal(compared.summary.deleted,1);assert.equal(compared.summary.unchanged,2);assert.ok(compared.changes.some(item=>item.type==='added'&&item.line===2&&item.text==='changed'));
  write(path.join(workspace,'long-before.txt'),Array.from({length:650},(_,i)=>String(i)).join('\n'));write(path.join(workspace,'long-after.txt'),Array.from({length:650},(_,i)=>i===300?'changed':String(i)).join('\n'));
  const long=await execute('document_compare',{before:'long-before.txt',after:'long-after.txt'},ctx);assert.equal(long.method,'bounded_prefix_suffix_region');assert.equal(long.summary.deleted,1);
});
test('link checks retain errors and redirect evidence and fall back from HEAD without downloading unbounded bodies',async t=>{
  const {ctx}=fixture(t),base=await server(t,(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'/okay'});return res.end();}
    if(req.url==='/get-only'&&req.method==='HEAD'){res.writeHead(405);return res.end();}
    if(req.url==='/missing'){res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':'text/plain'});res.end('okay');
  });
  const result=await execute('check_links',{urls:[base+'/redirect',base+'/get-only',base+'/missing','javascript:alert(1)']},ctx);
  assert.equal(result.summary.available,2);assert.equal(result.results[0].redirects.length,1);assert.equal(result.results[1].method,'GET');assert.equal(result.results[2].status,404);assert.match(result.results[3].error,/HTTP/);
});
test('citation formatting uses only registered metadata and preserves existing exported references',async t=>{
  const {ctx,workspace}=fixture(t);write(path.join(workspace,'evidence.txt'),'Actual source.');
  await execute('source_register',{action:'add',expectedRevision:0,source:{id:'local_fixture',title:'Local fixture',location:'evidence.txt'}},ctx);
  const references=await execute('citation_format',{sourceIds:['local_fixture'],format:'markdown',saveAs:'references.md'},ctx);assert.match(references.content,/Local fixture/);assert.match(references.content,/unreviewed/);assert.doesNotMatch(references.content,/Retrieved|2026/);assert.equal(fs.readFileSync(path.join(workspace,'references.md'),'utf8'),references.content+'\n');
  await assert.rejects(execute('citation_format',{sourceIds:['local_fixture'],saveAs:'references.md'},ctx),/EEXIST/);
  await assert.rejects(execute('citation_format',{sourceIds:['missing']},ctx),/Unknown source/);
});
test('citation exports reject duplicate IDs, omit annotation payloads and cap total output',async t=>{
  const {ctx,workspace}=fixture(t);write(path.join(workspace,'evidence.txt'),'Actual source.');
  await execute('source_register',{action:'add',expectedRevision:0,source:{id:'fixture',title:'Fixture',location:'evidence.txt'}},ctx);
  await assert.rejects(execute('citation_format',{sourceIds:['fixture','fixture'],format:'json'},ctx),/unique/);
  const file=path.join(workspace,'artifacts','sources.json'),register=JSON.parse(fs.readFileSync(file,'utf8'));register.sources[0].annotations=[{reviewStatus:'reviewed',note:'private long review '.repeat(10000)}];fs.writeFileSync(file,JSON.stringify(register));
  const compact=await execute('citation_format',{sourceIds:['fixture'],format:'json'},ctx);assert.doesNotMatch(compact.content,/private long review/);assert.ok(compact.content.length<1000);
  register.sources=Array.from({length:40},(_,index)=>({id:'source_'+index,title:'A'.repeat(1000),author:'B'.repeat(8000),location:'https://example.test/'+index}));fs.writeFileSync(file,JSON.stringify(register));
  await assert.rejects(execute('citation_format',{sourceIds:register.sources.map(source=>source.id),format:'json'},ctx),/256 KiB/);
});
