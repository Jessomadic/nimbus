import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'scope-test',version:'1'},{capabilities:{tools:{}}});
const schema={type:'object',properties:{value:{type:'integer'}},additionalProperties:false};
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'read',inputSchema:schema,annotations:{readOnlyHint:true,idempotentHint:true,openWorldHint:false},_meta:{fixture:true}},{name:'write',inputSchema:schema,annotations:{readOnlyHint:false,idempotentHint:true}}]}));
server.setRequestHandler(CallToolRequestSchema,async request=>({content:[{type:'text',text:'synthetic'}],structuredContent:{value:request.params.arguments?.value??0},_meta:{fixture:true},...(request.params.name==='write'?{isError:true}:{})}));
await server.connect(new StdioServerTransport());
