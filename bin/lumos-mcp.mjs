#!/usr/bin/env node
// Gives the Lumos worker the same MCP servers Hermes runs for Lumos.
// Reads HermesPilot/home/config.yaml (through the HermesPilot Python venv, which
// has PyYAML), starts each stdio server once to list its tools, and writes
// `lumos-<name>` entries scoped to the `lumos` group in nimbus.config.json.
//   node bin/lumos-mcp.mjs [--apply] [--bot <id>]
// The servers read their own credentials (DPAPI files, home/.env) exactly as
// under Hermes; no secret is copied into the Nimbus config.
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {config,saveConfig} from '../runtime/config.js';
import {effectTransportHash} from '../runtime/mcp-scope.js';

const argv=process.argv.slice(2),apply=argv.includes('--apply'),botArg=argv.indexOf('--bot');
const botId=botArg>=0?Number(argv[botArg+1]):config().lumos.botId;
const PY='F:/Projects/Lumos/HermesPilot/integrations/.venv/Scripts/python.exe',CONFIG='F:/Projects/Lumos/HermesPilot/home/config.yaml';
// Not migrated in the first cutover: Notion needs an OAuth sign-in Nimbus cannot
// refresh yet; Google personal never completed its sign-in under Hermes.
const SKIP={notion:'remote OAuth server; needs a Nimbus OAuth sign-in (MCP team)','google-personal':'sign-in never completed under Hermes'};
const READ=/^(get|list|search|find|read|inspect|query|lookup|status|stats|describe|show|forecast|current|fetch|check|archive_stats|calendar_events|events|view|count|preview|history|summar|explain|lookup)/i;

const hermes=JSON.parse(execFileSync(PY,['-c','import yaml,json,sys;c=yaml.safe_load(open(sys.argv[1],encoding="utf-8"));print(json.dumps(c.get("mcp_servers") or {}))',CONFIG],{encoding:'utf8'}));
const entries={},report=[];
// Lumos's own memory (integration/lumos-memory) over the Nimbus-owned copy.
if(Number.isSafeInteger(botId)&&botId>0)hermes.memory={command:PY,args:['-B','F:/Nimbus/integration/lumos-memory/server.py','--home','F:/Nimbus/data/lumos/home','--render',`F:/Nimbus/data/bots/${botId}/MEMORY.md`],cwd:'F:/Nimbus/integration/lumos-memory'};
// Desktop control, as Hermes's computer_use toolset: the same cua-driver binary
// over MCP stdio, with its anonymous telemetry turned off.
hermes.computer={command:'F:/Projects/Lumos/HermesPilot/home/tools/cua-driver-0.21.0-win32-x64/cua-driver.exe',args:['mcp'],env:{CUA_DRIVER_RS_TELEMETRY_ENABLED:'0'},timeout:60};
// Only these driver tools are offered (Hermes exposed a similar curated set).
const ALLOW={'lumos-computer':['list_apps','list_windows','get_window_state','get_desktop_state','get_screen_size','get_cursor_position','get_accessibility_tree','zoom','verify_state','click','double_click','right_click','drag','type_text','press_key','hotkey','set_value','scroll','move_cursor','bring_to_front','launch_app']};
const EFFECTS={'lumos-memory':{memory:'write',fact_store:'write',fact_feedback:'write',session_search:'read'}};
for(const [name,d] of Object.entries(hermes)){
  if(SKIP[name]||d.url){report.push({name,skipped:SKIP[name]||'remote server'});continue;}
  const def={enabled:true,command:d.command,args:(d.args||[]).map(String),...(d.cwd?{cwd:String(d.cwd)}:{}),initTimeoutMs:Math.min(120000,Math.max(30000,(d.timeout||30)*1000)),
    env:{PYTHONDONTWRITEBYTECODE:'1',...Object.fromEntries(Object.entries(d.env||{}).map(([k,v])=>[k,String(v)]))},
    // The memory validator may use lumos-memory and nothing else.
    scope:name==='memory'&&config().lumos.validatorBotId?{allow:{groups:['lumos'],workerIds:[config().lumos.validatorBotId]}}:{allow:{groups:['lumos']}}};
  let tools=[];
  const client=new Client({name:'nimbus-lumos-mcp-review',version:'1'});
  try{
    await Promise.race([
      client.connect(new StdioClientTransport({command:def.command,args:def.args,cwd:def.cwd,env:{...process.env,...def.env},stderr:'ignore'})),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('start timeout')),def.initTimeoutMs))]);
    tools=(await client.listTools()).tools;
  }catch(error){report.push({name,error:error.message});continue;}
  finally{try{await client.close();}catch{}}
  const server='lumos-'+name;
  if(ALLOW[server])tools=tools.filter(t=>ALLOW[server].includes(t.name));
  def.reviewedTools=tools.map(t=>t.name);
  const hash=effectTransportHash(server,def);
  // Read-only only when the server says so or the name is plainly a read;
  // everything else is "unknown", which makes an interrupted call wait for review.
  def.reviewedEffects=Object.fromEntries(tools.map(t=>[t.name,{effect:EFFECTS[server]?.[t.name]||(t.annotations?.readOnlyHint===true||READ.test(t.name)&&t.annotations?.destructiveHint!==true?'read':'unknown'),transportHash:hash}]));
  entries[server]=def;
  report.push({name:server,tools:tools.length,read:Object.values(def.reviewedEffects).filter(e=>e.effect==='read').length});
}
console.log(JSON.stringify({botId,apply,servers:report},null,2));
if(apply){
  if(!Number.isSafeInteger(botId)||botId<1)throw new Error('Set up the Lumos worker first (lumos.botId)');
  const c=config();
  saveConfig({mcpScopeGroups:{...(c.mcpScopeGroups||{}),lumos:{workerIds:[botId]}},mcpServers:entries});
  console.log('Wrote',Object.keys(entries).length,'lumos-* MCP servers scoped to worker',botId);
}
