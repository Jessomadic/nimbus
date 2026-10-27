import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const suite=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-content-tests-'));
process.env.NIMBUS_DATA=path.join(suite,'state');process.env.NIMBUS_CONFIG=path.join(suite,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({browser:{headless:true,enabled:true,maxGroups:5}}));
const {tools,execute,roleTools,parseDelimited}=await import('../runtime/toolsets/content.js');
let serial=0;
function fixture(t){const workspace=path.join(suite,'fixture-'+(++serial));fs.mkdirSync(workspace,{recursive:true});const write=(file,text)=>{const target=path.join(workspace,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);return target;};return {workspace,write,ctx:{workspace,dataDir:path.join(suite,'state'),root:path.resolve('.'),botId:9}};}
test('content role tool definitions are distinct, scoped and cover all five assigned specialties',()=>{
  assert.equal(tools.length,12);assert.equal(new Set(tools.map(t=>t.function.name)).size,12);
  for(const name of ['data-analyst','technical-writer','frontend-designer','browser-operator','office-assistant'])assert.ok(roleTools[name]?.length);
  assert.ok(tools.every(t=>t.function.parameters.additionalProperties===false));
});
test('CSV parser preserves commas, CRLF inside quoted fields and escaped quotes and rejects malformed rows',()=>{
  const rows=parseDelimited('id,note\r\n1,"first, line\r\nsecond ""quote"""\r\n2,last\r\n');
  assert.deepEqual(rows,[{id:'1',note:'first, line\r\nsecond "quote"'},{id:'2',note:'last'}]);
  assert.throws(()=>parseDelimited('a,a\n1,2'),/unique/);
  assert.throws(()=>parseDelimited('a,b\n1'),/expected 2/);
  assert.throws(()=>parseDelimited('a\n"unfinished'),/Unclosed/);
  assert.throws(()=>parseDelimited('a\n"closed"junk'),/closing CSV quote/);
});
test('dataset profile keeps string identity and exposes explicit numeric conversion failures and missingness',async t=>{
  const {ctx,write}=fixture(t);write('data.csv','id,amount,date\n001,10.5,2026-10-26\n002,,2026-02-30\n003,nope,2026-10-27\n003,nope,2026-10-27\n');
  const raw=await execute('dataset_profile',{path:'data.csv'},ctx);assert.equal(raw.rowCount,4);assert.equal(raw.duplicateRows,1);assert.equal(raw.profile.find(c=>c.column==='id').samples[0],'001');assert.equal(raw.profile.find(c=>c.column==='amount').numeric,undefined);
  const typed=await execute('dataset_profile',{path:'data.csv',types:{amount:'number',date:'date'}},ctx);assert.equal(typed.invalidConversionCount,3);assert.equal(typed.profile.find(c=>c.column==='amount').missing,1);
  write('empty.csv','id,amount\n');assert.deepEqual((await execute('dataset_profile',{path:'empty.csv'},ctx)).columns,['id','amount']);
});
test('structured dataset query computes independent filtered grouped totals without string coercion',async t=>{
  const {ctx,write}=fixture(t);write('data.csv','team,amount,active\nA,12,true\nA,8,true\nB,30,false\nB,3,true\n');
  const result=await execute('dataset_query',{path:'data.csv',types:{amount:'number',active:'boolean'},filters:[{column:'active',op:'eq',value:true}],groupBy:['team'],aggregates:[{name:'total',column:'amount',op:'sum'},{name:'n',op:'count'}],sort:[{column:'total',descending:true}]},ctx);
  assert.equal(result.matchedRows,3);assert.deepEqual(result.rows,[{team:'A',total:20,n:2},{team:'B',total:3,n:1}]);
  await assert.rejects(execute('dataset_query',{path:'data.csv',filters:[{column:'amount',op:'gt',value:10}]},ctx),/matching numeric or string types/);
  await assert.rejects(execute('dataset_query',{path:'data.csv',aggregates:[{name:'n',op:'count',column:'missing'}]},ctx),/missing or invalid/);
});
test('dataset validation counts missing fields, compound-key duplicates, type errors and bounds',async t=>{
  const {ctx,write}=fixture(t);write('data.json',JSON.stringify([{id:1,amount:10,state:'ok'},{id:1,amount:30,state:'bad'},{id:null,amount:'not numeric',state:'ok'}]));
  const result=await execute('dataset_validate',{path:'data.json',types:{amount:'number'},requiredColumns:['id','amount','missing'],notNull:['id'],uniqueBy:['id'],rules:[{column:'amount',minimum:0,maximum:20},{column:'state',allowed:['ok']}]},ctx);
  assert.equal(result.valid,false);assert.deepEqual(result.counts,{missing_column:1,invalid_type:1,duplicate_key:1,out_of_range:1,not_allowed:1,missing_value:1,not_numeric:1});
  assert.equal(result.failureCount,7);assert.equal(result.failures.find(f=>f.kind==='duplicate_key').firstRow,1);
});
test('dataset queries preserve sparse column identity, reject unsafe numbers and avoid silent mixed-type ordering',async t=>{
  const {ctx,write}=fixture(t);write('sparse.json','[{"id":1},{"id":2,"constructor":"own","amount":10}]');
  const selected=await execute('dataset_query',{path:'sparse.json',select:['id','constructor']},ctx);assert.deepEqual(selected.rows,[{id:1,constructor:null},{id:2,constructor:'own'}]);
  const validation=await execute('dataset_validate',{path:'sparse.json',notNull:['constructor']},ctx);assert.equal(validation.counts.missing_value,1);
  write('mixed.json','[{"x":1},{"x":"2"}]');await assert.rejects(execute('dataset_query',{path:'mixed.json',sort:[{column:'x'}]},ctx),/one scalar type/);
  write('unsafe.csv','id\n9007199254740993\n');assert.equal((await execute('dataset_profile',{path:'unsafe.csv',types:{id:'integer'}},ctx)).invalidConversionCount,1);
  write('overflow.json','[{"n":1e308},{"n":1e308}]');const profile=await execute('dataset_profile',{path:'overflow.json'},ctx);assert.equal(profile.profile[0].numeric.sumOverflow,true);assert.equal(profile.profile[0].numeric.mean,1e308);
  await assert.rejects(execute('dataset_query',{path:'overflow.json',aggregates:[{name:'total',op:'sum',column:'n'}]},ctx),/overflow/);
});
test('dataset comparison reports additions removals changes and rejects duplicate identity',async t=>{
  const {ctx,write}=fixture(t);write('before.csv','id,value\n1,A\n2,B\n3,C\n');write('after.csv','id,value,extra\n1,A,x\n2,Changed,y\n4,D,z\n');
  const result=await execute('dataset_compare',{path:'before.csv',otherPath:'after.csv',keys:['id']},ctx);assert.deepEqual(result.counts,{added:1,removed:1,changed:2,unchanged:0});assert.deepEqual(result.addedColumns,['extra']);assert.equal(result.samples.removed[0].row.id,'3');
  write('duplicate.csv','id,value\n1,A\n1,B\n');await assert.rejects(execute('dataset_compare',{path:'before.csv',otherPath:'duplicate.csv',keys:['id']},ctx),/Duplicate comparison key/);
});
test('table export escapes HTML and CSV quoting, neutralizes formula strings and preserves existing artifacts',async t=>{
  const {ctx,write,workspace}=fixture(t);const rows=[{name:'<script>alert(1)</script>',amount:-3,note:'first,second\nthird'},{name:'=SUM(A1:A9)',amount:2,note:'"quote"'}];
  const html=await execute('table_export',{output:'artifacts/table.html',format:'html',rows,title:'<unsafe>'},ctx),source=fs.readFileSync(html.path,'utf8');assert.ok(source.includes('&lt;script&gt;'));assert.ok(!source.includes('<script>'));assert.ok(source.includes('&lt;unsafe&gt;'));
  const csv=await execute('table_export',{output:'artifacts/table.csv',format:'csv',rows},ctx);assert.equal(csv.neutralizedCells,1);const parsed=parseDelimited(fs.readFileSync(csv.path,'utf8'));assert.equal(parsed[0].amount,'-3');assert.equal(parsed[0].note,'first,second\nthird');assert.equal(parsed[1].name,"'=SUM(A1:A9)");
  write('existing.txt','KEEP');await assert.rejects(execute('table_export',{output:'existing.txt',format:'json',rows},ctx),/already exists/);assert.equal(fs.readFileSync(path.join(workspace,'existing.txt'),'utf8'),'KEEP');
  await assert.rejects(execute('table_export',{output:'../escape.csv',format:'csv',rows},ctx),/inside your workspace/);
});
test('document inspection ignores code headings and reports structural and local link errors honestly',async t=>{
  const {ctx,write}=fixture(t);write('doc.md','# Title\n\n### Jump\n\n[missing](absent.md) and [bad](#does-not-exist) and [external](https://example.com)\n\n![](image.png)\n\n## Title\n\nTODO finish\n\n```js\n# not a heading\n');
  const structure=await execute('document_structure',{path:'doc.md'},ctx);assert.equal(structure.headings.length,3);assert.ok(!Object.hasOwn(structure,'sourceText'));assert.equal(structure.headings[2].anchor,'title-1');
  const check=await execute('document_check',{path:'doc.md'},ctx);for(const kind of ['skipped_heading_level','duplicate_heading_anchor_base','unclosed_code_fence','missing_relative_file','missing_heading_target','missing_image_alt','unfinished_marker'])assert.ok(check.issues.some(issue=>issue.kind===kind),kind);assert.equal(check.externalLinksVerified,false);
});
test('report composition produces a readable escaped artifact and refuses executable source URLs',async t=>{
  const {ctx}=fixture(t);const report=await execute('report_compose',{output:'report.html',format:'html',title:'Results <safe>',sections:[{heading:'Evidence',text:'<script>bad</script>',bullets:['A & B'],rows:[{x:'<img src=x onerror=alert(1)>'}]}],sources:[{title:'Primary evidence',url:'https://example.com/evidence',note:'Observed'}]},ctx);const html=fs.readFileSync(report.path,'utf8');assert.ok(html.includes('Results &lt;safe&gt;'));assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('https://example.com/evidence'));
  await assert.rejects(execute('report_compose',{output:'bad.html',format:'html',title:'x',sections:[],sources:[{title:'bad',url:'javascript:alert(1)'}]},ctx),/HTTP\(S\)/);
});
test('office checklist persists stable identity and accurate completion and overdue counts',async t=>{
  const {ctx}=fixture(t);const added=await execute('office_checklist',{action:'add',title:'Prepare meeting notes',priority:'high',dueDate:'2020-01-01'},ctx);assert.ok(added.item.id);
  let summary=await execute('office_checklist',{action:'summary'},ctx);assert.equal(summary.total,1);assert.equal(summary.overdue.length,1);
  await execute('office_checklist',{action:'update',id:added.item.id,status:'done'},ctx);summary=await execute('office_checklist',{action:'summary'},ctx);assert.equal(summary.byStatus.done,1);assert.equal(summary.overdue.length,0);
  await assert.rejects(execute('office_checklist',{action:'add',title:'Invalid',dueDate:'2026-02-30'},ctx),/real ISO/);
});
test('content tools reject pre-cancelled work and binary or oversized text inputs',async t=>{
  const {ctx,write}=fixture(t),abort=new AbortController();abort.abort(new Error('Cancelled fixture'));await assert.rejects(execute('dataset_profile',{path:'never.csv'},{...ctx,signal:abort.signal}),/Cancelled fixture/);
  write('binary.csv',Buffer.from([0,1,2]));await assert.rejects(execute('dataset_profile',{path:'binary.csv'},ctx),/Binary/);
  write('large.csv',Buffer.alloc(8*1024*1024+1,65));await assert.rejects(execute('dataset_profile',{path:'large.csv'},ctx),/8 MiB/);
});
test('owned browser audits inspect real DOM, avoid input values, extract spans and restore responsive viewport',async t=>{
  const {ctx,workspace}=fixture(t),{BrowserGroups}=await import('../runtime/browser.js');
  const manager=new BrowserGroups({dataDir:path.join(workspace,'browser-data'),protectState:async s=>s,unprotectState:async s=>s});
  const server=http.createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><title>Audit fixture</title><style>body{margin:0}.wide{width:1400px;height:40px}</style><h1>Observed heading</h1><a href="/destination">Actual link</a><label>Account<input name="account" value="DO_NOT_LEAK"></label><input type="password" value="PASSWORD_DO_NOT_LEAK"><button aria-label="Save changes">Save</button><img src="missing.png"><div class="wide"></div><table><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>First</td><td>2</td></tr><tr><td colspan="2">Merged</td></tr></tbody></table>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
  try{
    const opened=await manager.perform(ctx.botId,{action:'open',url});const ownCtx={...ctx,browsers:manager};
    const inspected=await execute('browser_inspect',{tabId:opened.tabId},ownCtx);assert.equal(inspected.title,'Audit fixture');assert.ok(inspected.headings.some(h=>h.text==='Observed heading'));assert.ok(inspected.links.some(l=>l.url===url+'/destination'));assert.ok(inspected.warnings.some(w=>w.kind==='missing_document_language'));assert.ok(!JSON.stringify(inspected).includes('DO_NOT_LEAK'));
    const table=await execute('browser_table',{tabId:opened.tabId},ownCtx);assert.deepEqual(table.columns,['Item','Count']);assert.deepEqual(table.rows,[['First','2'],['Merged']]);assert.equal(table.spans[0].colSpan,2);assert.equal(table.mergedCellsExpanded,false);
    await assert.rejects(execute('browser_inspect',{tabId:opened.tabId},{...ownCtx,botId:ctx.botId+1}),/does not belong/);
    const group=await manager.group(ctx.botId),page=group.tabs.get(opened.tabId),original=page.viewportSize();
    const audit=await execute('responsive_audit',{tabId:opened.tabId,widths:[320,1600],height:600},ownCtx);assert.deepEqual(audit.checks.map(c=>c.horizontalOverflow),[true,false]);assert.deepEqual(page.viewportSize(),original);assert.ok(audit.checks.every(c=>fs.existsSync(c.screenshot)));assert.equal(audit.image.mimeType,'image/png');assert.equal(audit.visualReviewClaimed,false);
  }finally{await manager.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
test.after(async()=>{try{const {db}=await import('../db.js');db.close();}finally{assert.equal(path.dirname(suite),path.resolve(os.tmpdir()));assert.match(path.basename(suite),/^nimbus-content-tests-/);fs.rmSync(suite,{recursive:true,force:true});}});
