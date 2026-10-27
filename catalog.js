// Nimbus-owned tools and independently configured MCP connectors.
export {ROLE_PROFILES as TEMPLATES} from './runtime/roles.js';
const httpConnector=(id,name,icon,color,desc)=>({id,name,category:'Productivity',kind:'mcp',icon,color,desc,
  fields:[{key:'MCP_URL',label:'MCP server URL',help:'The streamable HTTP endpoint of your independently configured server.'},
    {key:'MCP_TOKEN',label:'Bearer token',help:'A credential for this Nimbus connector. Configure the server and its permissions independently.'}],
  server:s=>({url:s.MCP_URL,headers:{Authorization:`Bearer ${s.MCP_TOKEN}`}})});
export const PLUGINS=[
  {id:'browser',name:'Browser groups',category:'Featured',kind:'builtin',icon:'◎',color:'#2d9cdb',desc:'Each worker controls its own tabs, cookies and sign-ins through Nimbus.'},
  {id:'github',name:'GitHub',category:'Featured',kind:'mcp',icon:'GH',color:'#24292f',desc:'Search code, inspect issues and work with pull requests.',
    fields:[{key:'GITHUB_TOKEN',label:'Personal access token',help:'github.com/settings/tokens'}],
    server:s=>({url:'https://api.githubcopilot.com/mcp/',headers:{Authorization:`Bearer ${s.GITHUB_TOKEN}`}})},
  httpConnector('gmail','Gmail','M','#ea4335','Connect your own Gmail MCP service and credentials.'),
  httpConnector('google-calendar','Google Calendar','31','#4285f4','Connect your own Calendar MCP service and credentials.'),
  httpConnector('google-drive','Google Drive','D','#0f9d58','Connect your own Drive MCP service and credentials.'),
  {id:'notion',name:'Notion',category:'Productivity',kind:'mcp',icon:'N',color:'#666666',desc:'Read and update pages and databases through your integration.',
    fields:[{key:'NOTION_TOKEN',label:'Integration token',help:'notion.so/profile/integrations'}],
    server:s=>({command:'npx',args:['-y','@notionhq/notion-mcp-server'],env:{NOTION_TOKEN:s.NOTION_TOKEN}})},
  {id:'brave-search',name:'Brave Search',category:'Research',kind:'mcp',icon:'B',color:'#fb542b',desc:'Search the web with a separately configured search credential.',
    fields:[{key:'BRAVE_API_KEY',label:'API key',help:'brave.com/search/api'}],
    server:s=>({command:'npx',args:['-y','@brave/brave-search-mcp-server'],env:{BRAVE_API_KEY:s.BRAVE_API_KEY}})},
  {id:'context7',name:'Context7',category:'Research',kind:'mcp',icon:'C7',color:'#10b981',desc:'Current library and framework documentation.',fields:[],server:()=>({url:'https://mcp.context7.com/mcp'})},
  httpConnector('custom-mcp','Custom MCP','+','#7c5cf5','Connect an additional streamable HTTP tool server.')
];
export const publicPlugin=({server,...p})=>({...p,fields:(p.fields||[]).map(({key,label,help})=>({key,label,help}))});
