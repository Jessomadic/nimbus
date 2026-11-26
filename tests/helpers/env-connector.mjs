import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
// One read tool that reports which environment variable names the server received.
const s=new Server({name:'env',version:'1'},{capabilities:{tools:{}}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'env',inputSchema:{type:'object'}}]}));
s.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:JSON.stringify(Object.keys(process.env).map(k=>k.toUpperCase()).sort())}]}));
await s.connect(new StdioServerTransport());
