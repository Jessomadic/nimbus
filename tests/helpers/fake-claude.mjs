// Stand-in for the Claude Code CLI in tests: reads the --mcp-config Nimbus passes,
// starts the real Nimbus bridge through an MCP client, lists and calls one tool,
// and prints Claude Code's stream-json events.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const args = process.argv.slice(2), flag = name => args[args.indexOf(name) + 1];
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const mode = process.env.FAKE_CLAUDE_MODE || 'tool';
const server = JSON.parse(flag('--mcp-config')).mcpServers.nimbus;
out({ type: 'system', subtype: 'init', session_id: 'fake-session', model: flag('--model'), apiKeySource: mode === 'apikey' ? 'ANTHROPIC_API_KEY' : 'none',
  tools: [], mcp_servers: [{ name: 'nimbus', status: 'pending' }], argv: { tools: flag('--tools'), permission: flag('--permission-mode'), allowed: flag('--allowedTools'), env: Object.keys(process.env).filter(k => /^(ANTHROPIC|CLAUDE)/.test(k)) } });
if (mode === 'nomodel') { out({ type: 'result', is_error: true, result: "You're out of usage credits. Switch to another model, or manage usage credits to continue." }); process.exit(1); }
if (mode === 'limit') { out({ type: 'result', is_error: true, result: 'Claude usage limit reached. Resets at 5pm.' }); process.exit(1); }
const client = new Client({ name: 'fake-claude', version: '1' });
await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...server.env } }));
const { tools } = await client.listTools();
const call = await client.callTool({ name: tools[0].name, arguments: { text: 'ping' } });
await client.close();
const text = call.content.find(c => c.type === 'text').text;
out({ type: 'assistant', message: { model: flag('--model'), content: [{ type: 'tool_use', name: 'mcp__nimbus__' + tools[0].name, input: { text: 'ping' } }] } });
out({ type: 'assistant', message: { model: flag('--model'), content: [{ type: 'text', text: 'echoed ' + text }] } });
out({ type: 'result', is_error: false, result: 'echoed ' + text + ' tools=' + tools.map(t => t.name).join(',') + ' promptHasTask=' + prompt.includes('Say hello'),
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 }, modelUsage: { [flag('--model')]: { outputTokens: 5 } } });
