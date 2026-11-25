import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ToolDevelopment} from '../runtime/tool-development.js';
const h='a'.repeat(64);
for(const phase of ['testing','reviewing'])for(const kind of ['valid','missing','nested','malformed','drift','unavailable']){
test(phase+' '+kind,t=>{
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'receipt-contract-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
const receipt={requestId:'fixture',phase,approved:true,summary:'Independent fixture check',verification:{args:{},assertions:[{path:'ok',equals:true}]}};
if(kind!=='missing'&&kind!=='nested')receipt.sourceHash=kind==='malformed'?'xyz':h;
if(kind==='nested')receipt.evidence={sourceHash:h};
const file=path.join(dir,'receipt.json');fs.writeFileSync(file,JSON.stringify(receipt));const original=fs.readFileSync(file);
const writes=[];
const service=Object.create(ToolDevelopment.prototype);
service.maintenance={status:()=>({sourceHash:kind==='drift'?'b'.repeat(64):kind==='unavailable'?undefined:h})};
service.query=()=>({get:()=>({receipt_json:JSON.stringify({sourceHash:h})}),run:(...args)=>writes.push(args)});
const action=()=>service._receipt({id:'fixture',snapshot_id:'snapshot'},{phase,artifact_path:file});
if(kind==='valid')assert.equal(action().sourceHash,h);else assert.throws(action,/64-hex|drifted/);
assert.deepEqual(fs.readFileSync(file),original,'never backfill receipts');
});
}
test('QA and reviewer generation requires before/after hash and readback',()=>{
const service=Object.create(ToolDevelopment.prototype);
service._run=()=>null;service.query=()=>({get:()=>null,all:()=>[]});
for(const phase of ['testing','reviewing']){
const prompt=service._prompt({id:'fixture',title:'test',acceptance_json:'[]'},phase,'receipt.json');
for(const text of ['BEFORE checks/review','AFTER all checks/review','TOP-LEVEL sourceHash','read back','No normalizer or host may backfill'])assert.ok(prompt.includes(text),text);
}
});
