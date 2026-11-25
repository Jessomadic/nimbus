import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {designRender,annotationHtml,closeDesignBrowser} from '../runtime/design.js';
import {coreTools} from '../runtime/tools.js';

test('design_render is a declared tool with markup schema',()=>{
  const t=coreTools.find(x=>x.function.name==='design_render');
  assert.ok(t);assert.deepEqual(t.function.parameters.properties.marks.items.properties.type.enum,['circle','box','arrow','label']);
});

test('annotation markup escapes label text and rejects unknown marks',()=>{
  const html=annotationHtml('file:///x.png',100,80,[{type:'label',x:1,y:2,text:'<script>'}]);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  assert.throws(()=>annotationHtml('file:///x.png',100,80,[{type:'blob',x:1,y:1}]),/Unknown mark type/);
});

test('renders HTML offline, marks up a photo, and writes a PDF',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-design-'));
  t.after(async()=>{await closeDesignBrowser();fs.rmSync(dir,{recursive:true,force:true});});
  const ctx={resolve:p=>path.resolve(dir,p),outDir:dir};
  let first;
  try{first=await designRender({name:'card',width:400,height:300,html:'<body style="margin:0;background:#fff"><h1>Hi</h1><img src="https://example.com/a.png"></body>'},ctx);}
  catch(e){if(/could not start Chromium/.test(e.message))return t.skip('Chromium not installed');throw e;}
  assert.equal(first.image.mimeType,'image/png');
  assert.ok(first.blockedRequests.some(u=>u.startsWith('https://example.com')),'network requests are blocked');
  const marked=await designRender({baseImage:first.path,marks:[{type:'circle',x:100,y:100,r:30},{type:'arrow',x:10,y:10,x2:90,y2:90}]},ctx);
  assert.equal(marked.width,800);assert.equal(marked.height,600); // the photo's own pixels (400x300 at scale 2)
  assert.equal(fs.readFileSync(marked.path).subarray(1,4).toString(),'PNG');
  const pdf=await designRender({format:'pdf',pageSize:'Letter',html:'<h1>Page</h1>'},ctx);
  assert.equal(fs.readFileSync(pdf.path).subarray(0,4).toString(),'%PDF');
  assert.equal(pdf.image.mimeType,'image/png');
  fs.writeFileSync(path.join(dir,'page.html'),'<body><h1>x</h1><script>undefinedFn()</script></body>');
  const checked=await designRender({file:'page.html',javascript:true,width:300,height:200},ctx);
  assert.ok(checked.consoleErrors.some(e=>/undefinedFn/.test(e)),'console errors are reported');
  assert.equal(checked.source,path.join(dir,'page.html'));
  await assert.rejects(designRender({file:'missing.html'},ctx),/existing/);
  await assert.rejects(designRender({},ctx),/Give html, svg, or baseImage/);
});
