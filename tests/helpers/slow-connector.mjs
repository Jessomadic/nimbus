import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
// One read tool that answers after DELAY_MS (default 1500 ms).
const s=new Server({name:'slow',version:'1'},{capabilities:{tools:{}}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'slow',inputSchema:{type:'object'}}]}));
s.setRequestHandler(CallToolRequestSchema,async()=>{await new Promise(r=>setTimeout(r,Number(process.env.DELAY_MS||1500)));return {content:[{type:'text',text:'answer 391'}]};});
await s.connect(new StdioServerTransport());
