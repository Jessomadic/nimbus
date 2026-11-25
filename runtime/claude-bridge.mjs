// Stdio MCP server launched by Claude Code for one Nimbus turn. It owns no tools:
// every list and call is forwarded to the Nimbus host over a per-turn loopback
// endpoint guarded by a random bearer token, so Nimbus keeps tool policy,
// approvals and the journal exactly as it does for Codex dynamic tools.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const url = process.env.NIMBUS_BRIDGE_URL, token = process.env.NIMBUS_BRIDGE_TOKEN;
if (!url || !token || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
  process.stderr.write('Nimbus bridge requires a loopback NIMBUS_BRIDGE_URL and NIMBUS_BRIDGE_TOKEN\n');
  process.exit(2);
}
async function host(path, body) {
  const response = await fetch(url + path, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Nimbus host returned ${response.status}`);
  return data;
}
const server = new Server({ name: 'nimbus', version: '0.2.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await host('/list')).tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  try {
    const result = await host('/call', { name: request.params.name, arguments: request.params.arguments || {} });
    return { content: result.content, isError: result.isError === true };
  } catch (error) {
    return { content: [{ type: 'text', text: 'Nimbus host error: ' + error.message }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
