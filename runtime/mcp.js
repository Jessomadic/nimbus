import path from 'node:path';
import fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {redact} from '../redact.js';

export function cleanConnectorError(value,definition={}) {
  let result=String(value||'Connector unavailable');
  for(const secret of [...Object.values(definition.headers||{}),...Object.values(definition.env||{})]){
    if(typeof secret!=='string'||secret.length<4)continue;
    result=result.replaceAll(secret,'[REDACTED]');const bearer=secret.replace(/^(?:Bearer|Basic)\s+/i,'');if(bearer.length>=4)result=result.replaceAll(bearer,'[REDACTED]');
  }
  result=result.replace(/((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"'\\,;]+/gi,'$1[REDACTED]')
    .replace(/((?:set-cookie|cookie)["']?\s*[:=]\s*["']?)[^\r\n]+/gi,'$1[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi,raw=>{try{const url=new URL(raw);url.username='';url.password='';for(const key of url.searchParams.keys())if(/token|secret|password|key|signature/i.test(key))url.searchParams.set(key,'[REDACTED]');return url.href;}catch{return '[invalid endpoint]';}});
  return redact(result).slice(0,2000);
}

export class WorkerConnectors {
  constructor() { this.clients = new Map(); }
  async connect(owner, name, definition) {
    const key = JSON.stringify([owner, name, definition]);
    if (this.clients.has(key)) return this.clients.get(key);
    const pending = (async () => {
      const client = new Client({ name: 'nimbus', version: '0.2.0' });
      let transport;
      if (definition.url) {
        transport = new StreamableHTTPClientTransport(new URL(definition.url), { requestInit: { headers: definition.headers || {} } });
      } else {
        let { command, args = [] } = definition;
        if (process.platform === 'win32' && command === 'npx') {
          const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
          if (!fs.existsSync(cli)) throw new Error('Nimbus cannot locate npx-cli.js; configure an executable MCP command.');
          command = process.execPath; args = [cli, ...args];
        }
        const env = {};
        for (const key of ['PATH','Path','HOME','USERPROFILE','SYSTEMROOT','SystemRoot','TEMP','TMP','COMSPEC','APPDATA','LOCALAPPDATA','PROGRAMFILES']) if (process.env[key]) env[key] = process.env[key];
        transport = new StdioClientTransport({ command, args, cwd: definition.cwd, env: { ...env, ...definition.env }, stderr: 'pipe' });
      }
      await client.connect(transport);
      return client;
    })().catch(e => { this.clients.delete(key); throw e; });
    this.clients.set(key, pending); return pending;
  }
  async tools(owner, servers) {
    const available = [], bindings = new Map(), errors = [];
    for (const [name, cfg] of Object.entries(servers)) {
      try {
        const client = await this.connect(owner, name, cfg);
        let cursor;
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const tool of page.tools) {
            const id = `mcp__${name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_');
            if (id.length > 64 || bindings.has(id)) throw new Error('MCP tool name is too long or duplicated');
            available.push({ type: 'function', function: { name: id, description: tool.description || tool.name, parameters: tool.inputSchema } });
            bindings.set(id, { client, tool: tool.name, readOnly: tool.annotations?.readOnlyHint === true });
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (e) { errors.push({ server: name, error: cleanConnectorError(e.message,cfg) }); }
    }
    return { available, bindings, errors };
  }
  async close() { for (const p of this.clients.values()) try { await (await p).close(); } catch {} this.clients.clear(); }
}
