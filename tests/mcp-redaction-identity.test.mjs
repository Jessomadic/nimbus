import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeConnectorValue,WorkerConnectors} from '../runtime/mcp.js';
test('structural string and key redaction includes escaped JSON and descriptors',()=>{
 const secret='synthetic-"quote\\slash';
 const input={description:secret,content:[{text:JSON.stringify({[secret]:secret})}],structuredContent:{[secret]:{nested:secret}},error:secret};
 const out=sanitizeConnectorValue(input,secret);
 assert.equal(out.description,'[REDACTED]');assert.equal(out.error,'[REDACTED]');
 assert.deepEqual(Object.keys(out.structuredContent),['[REDACTED]']);
 assert.equal(out.structuredContent['[REDACTED]'].nested,'[REDACTED]');
 assert.ok(!out.content[0].text.includes(JSON.stringify(secret).slice(1,-1)));
 assert.equal(input.description,secret);
});
test('cache identities are opaque, stable only within manager and change with definition',()=>{
 const a=new WorkerConnectors(),b=new WorkerConnectors(),d={env:{TOKEN:'synthetic-private-value'}};
 const key=a.cacheKey(2,'fixture',d);
 assert.match(key,/^[a-f0-9]{64}$/);assert.equal(key,a.cacheKey(2,'fixture',d));
 assert.notEqual(key,b.cacheKey(2,'fixture',d));assert.notEqual(key,a.cacheKey(3,'fixture',d));
 assert.notEqual(key,a.cacheKey(2,'fixture',{env:{TOKEN:'different'}}));
});
