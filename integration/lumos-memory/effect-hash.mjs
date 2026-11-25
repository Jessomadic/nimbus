// Print the reviewedEffects transportHash for an MCP server entry, computed with Nimbus'
// own effectTransportHash (runtime/mcp-scope.js). Read-only: never writes the config.
//   node integration/lumos-memory/effect-hash.mjs [config path] [server name]
// Defaults: F:/Nimbus/nimbus.config.json, lumos-memory. Re-run after ANY change to the
// entry other than `scope` / `reviewedEffects` (command, args, cwd, env, reviewedTools...).
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nimbus = resolve(here, '..', '..');
const {effectTransportHash} = await import(pathToFileURL(resolve(nimbus, 'runtime', 'mcp-scope.js')).href);
const [cfgPath = resolve(nimbus, 'nimbus.config.json'), name = 'lumos-memory'] = process.argv.slice(2);
const def = JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers?.[name];
if (!def) { console.error(`no mcpServers.${name} in ${cfgPath}`); process.exit(1); }
console.log(effectTransportHash(name, def));
