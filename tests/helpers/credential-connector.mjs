import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const s=new Server({name:'credential-fixture',version:'1'},{capabilities:{tools:{}}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}));
s.setRequestHandler(CallToolRequestSchema,async()=>({content:[{type:'text',text:process.env.FIXTURE_TOKEN||'MISSING'}]}));
await s.connect(new StdioServerTransport());
