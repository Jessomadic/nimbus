import test from 'node:test';
import assert from 'node:assert/strict';
import {createWindowsConnectorStore as create} from '../runtime/connector-store-windows.js';
const python=[process.env.LOCALAPPDATA||'C:/Users/Example User/AppData/Local','Programs/Python/Python312/python.exe'].join('/').replaceAll('/',String.fromCharCode(92));
test('native store missing enrollment denies before helper launch',async()=>{
 const store=create({python});
 await assert.rejects(store.read({sourceId:'missing',revision:1,ownerSid:'S-1-5-21-123'}),/Protected connector/);
});
test('legacy incomplete foreign enrollment rejects at construction with generic outward error',()=>{
 const r={sourceId:'fixture',revision:1,ownerSid:'S-1-5-21-123',file:'F:/Nimbus/fixture-only-does-not-exist',sha256:'a'.repeat(64)};
 assert.throws(()=>create({python,records:[r]}),{message:'Protected connector credential unavailable'});
});
test('native enrollment rejects case collisions and malformed identity',()=>{
 const r={sourceId:'fixture',revision:1,ownerSid:'S-1-5-21-123',file:'fixture',sha256:'a'.repeat(64),approvalRevision:1,binding:'unapproved',bindingV1:{}};
 assert.throws(()=>create({python,records:[r,{...r,sourceId:'FIXTURE'}]}));
 assert.throws(()=>create({python,records:[{...r,ownerSid:'invalid'}]}));
});
