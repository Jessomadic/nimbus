import test from 'node:test';
import assert from 'node:assert/strict';
import {pinnedConnectorFetch} from '../runtime/mcp.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
test('pinned SDK POST, SSE GET and DELETE never follow redirects or forward credentials',async()=>{
 const previous=globalThis.fetch,calls=[];
 globalThis.fetch=async(u,i)=>{calls.push({url:String(u),method:i.method,redirect:i.redirect});return new Response(null,{status:307,headers:{location:'/other'}});};
 const fetch=pinnedConnectorFetch('https://synthetic.invalid/mcp');
 const t=new StreamableHTTPClientTransport(new URL('https://synthetic.invalid/mcp'),{fetch,requestInit:{headers:{Authorization:'Bearer synthetic'},redirect:'error'},sessionId:'synthetic'});
 t.onerror=()=>{};
 try{
 await assert.rejects(t.send({jsonrpc:'2.0',method:'synthetic',id:1}));
 await assert.rejects(t._startOrAuthSse({}),/MCP redirect denied/);
 await assert.rejects(t.terminateSession());
 assert.deepEqual(calls.map(c=>c.method),['POST','GET','DELETE']);
 assert.ok(calls.every(c=>c.url==='https://synthetic.invalid/mcp'&&c.redirect==='error'));
 for(const url of ['https://synthetic.invalid/other','https://else.invalid/mcp'])
 await assert.rejects(fetch(url,{method:'GET'}),/endpoint denied/);
 await assert.rejects(fetch('https://synthetic.invalid/mcp',{method:'PUT'}),/endpoint denied/);
 assert.equal(calls.length,3);
 }finally{await t.close();globalThis.fetch=previous;}
});
