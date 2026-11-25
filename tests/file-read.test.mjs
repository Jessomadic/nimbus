import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {readWorkerFile} from '../runtime/file-read.js';
import {toolResultText} from '../runtime/inference-context.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-file-pages-')),hash=b=>createHash('sha256').update(b).digest('hex');
function file(name,content){const p=path.join(root,name);fs.writeFileSync(p,content);return p;}
test('ordinary reads retain exact full content, bytes and hash',()=>{
 const p=file('small.txt','Retained é\r\n😀'),r=readWorkerFile(p);
 assert.equal(r.content,'Retained é\r\n😀');assert.equal(r.bytes,fs.statSync(p).size);assert.equal(r.sha256,hash(fs.readFileSync(p)));assert.equal(Object.hasOwn(r,'offset'),false);
});
test('large documents can be reconstructed through version-pinned bounded pages',()=>{
 const text='Long retained evidence é 😀\r\n'.repeat(11000),p=file('large.txt',text);assert.equal(readWorkerFile(p).code,'file_too_large');
 let offset=0,joined='',expected;let pages=0;
 do{const r=readWorkerFile(p,{offset,limit:4000,...(expected?{expectedSha256:expected}:{})});assert.equal(r.error,undefined);assert.equal(r.sha256,expected||hash(fs.readFileSync(p)));expected=r.sha256;assert.equal(r.bytes,Buffer.byteLength(text));assert.equal(r.totalCharacters,text.length);assert.equal(toolResultText(r),JSON.stringify(r));joined+=r.content;pages++;if(!r.hasMore){assert.equal(r.nextOffset,null);break;}assert.ok(r.nextOffset>offset);offset=r.nextOffset;}while(pages<1000);
 assert.equal(joined,text);assert.ok(pages>10&&pages<1000);
});
test('JSON escapes fit the actual model preview without a second truncation',()=>{
 const p=file('escaped.txt','\u0000'.repeat(6000)+'😀end');let offset=0,joined='',pages=0;
 while(true){const r=readWorkerFile(p,{offset,limit:4000});assert.equal(r.error,undefined);assert.ok(JSON.stringify(r).length<=10000);assert.equal(toolResultText(r),JSON.stringify(r));joined+=r.content;pages++;if(!r.hasMore)break;assert.ok(r.nextOffset>offset);offset=r.nextOffset;}
 assert.equal(joined,fs.readFileSync(p,'utf8'));assert.ok(pages>1);
});
test('Unicode boundaries, empty tail and invalid paging inputs are explicit',()=>{
 const p=file('unicode.txt','a😀b');
 const first=readWorkerFile(p,{offset:0,limit:2});assert.equal(first.content,'a');assert.equal(first.nextOffset,1);
 const second=readWorkerFile(p,{offset:first.nextOffset,limit:2,expectedSha256:first.sha256});assert.equal(second.content,'😀');assert.equal(second.nextOffset,3);
 assert.equal(readWorkerFile(p,{offset:2,limit:2}).code,'invalid_offset');assert.equal(readWorkerFile(p,{offset:5,limit:2}).code,'invalid_offset');
 const tail=readWorkerFile(p,{offset:4,limit:2});assert.equal(tail.content,'');assert.equal(tail.hasMore,false);assert.equal(tail.nextOffset,null);
 for(const args of [{offset:-1},{offset:0.2},{offset:null},{limit:1},{limit:4001},{limit:null}])assert.equal(readWorkerFile(p,args).code,'invalid_page');
 assert.equal(readWorkerFile(p,{expectedSha256:'invalid'}).code,'invalid_hash');
});
test('a changed document cannot silently supply the next page under an old pin',()=>{
 const p=file('change.txt','first version retained'),first=readWorkerFile(p,{offset:0,limit:5});fs.writeFileSync(p,'second version retained');
 const next=readWorkerFile(p,{offset:first.nextOffset,limit:5,expectedSha256:first.sha256});assert.equal(next.code,'file_changed');assert.equal(Object.hasOwn(next,'content'),false);assert.equal(next.sha256,hash(fs.readFileSync(p)));
});
test('actual reads stay bounded when a file grows after its initial stat',()=>{
 const p=file('grow.txt','initial'),read=fs.readSync;let injected=false,observed=0;
 fs.readSync=function(fd,buffer,...args){if(!injected){injected=true;fs.appendFileSync(p,'x'.repeat(300000));}const size=read.call(fs,fd,buffer,...args);observed+=size;return size;};
 try{const r=readWorkerFile(p);assert.equal(r.code,'file_too_large');assert.equal(Object.hasOwn(r,'content'),false);assert.ok(observed<=256001);}finally{fs.readSync=read;}
});
test.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^nimbus-file-pages-/);fs.rmSync(root,{recursive:true,force:true});});
