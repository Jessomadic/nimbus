import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const s=new Server({name:'sentinel',version:'1'},{capabilities:{tools:{}}});
s.setRequestHandler(ListToolsRequestSchema,async()=>({tools:['read','write','ok','result'].map(name=>({name,inputSchema:{type:'object'}}))}));
s.setRequestHandler(CallToolRequestSchema,async r=>{
 const text='safe diagnostic '+process.env.FIXTURE_SECRET;
 if(r.params.name==='ok')return {content:[{type:'text',text:'safe diagnostic'}],_meta:{safe:42}};
 if(r.params.name==='result')return {content:[{type:'text',text}],structuredContent:{text},_meta:{safe:42},isError:true};
 throw new Error(text);
});
await s.connect(new StdioServerTransport());
