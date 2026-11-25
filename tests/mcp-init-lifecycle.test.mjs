import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkerConnectors} from '../runtime/mcp.js';
import {validateMcpScopes} from '../runtime/mcp-scope.js';
test('deadline closes hung stdio and evicts failed generation without replay',async()=>{
 const w=new WorkerConnectors();
 const d={command:process.execPath,args:['-e','setInterval(()=>{},1000)'],initTimeoutMs:150};
 const start=Date.now();
 await assert.rejects(w.connect(22,'synthetic-hung',d),/initialization deadline/);
 assert.equal(w.clients.size,0);
 assert.ok(Date.now()-start<10000);
 await w.close();
});
test('shutdown revokes synchronously and preserves a later connection generation',async()=>{
 const w=new WorkerConnectors();
 let release;let closed=0;
 const waiting=new Promise(resolve=>{release=resolve;});
 w.clients.set('old',waiting);
 const shutdown=w.close();
 assert.equal(w.clients.size,0,'old authorizations must disappear before cleanup awaits');
 const newer=Promise.resolve({close:async()=>{closed+=100;}});
 w.clients.set('new',newer);
 release({close:async()=>{closed++;}});
 await shutdown;
 assert.equal(closed,1,'shutdown must only close its captured generation');
 assert.equal(w.clients.get('new'),newer,'new generation survives old shutdown');
 await w.close();assert.equal(closed,101);
});
test('initialization bounds fail closed before launch',()=>{
 for(const initTimeoutMs of [0,-1,99,120001,NaN,'1000',null])assert.throws(()=>validateMcpScopes({mcpServers:{s:{initTimeoutMs}}}));
 for(const initTimeoutMs of [100,30000,120000])validateMcpScopes({mcpServers:{s:{initTimeoutMs}}});
});
