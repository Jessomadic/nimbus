// One short, tool-free Claude answer through the Claude Code subscription login,
// for small host decisions such as Lumos topic routing. No Nimbus tools, no
// built-in tools, no session history.
import {launch} from './process.js';
import {claudeBin,claudeEnv,resolveClaudeModel} from './claude.js';
import {config} from './config.js';

export async function claudeQuick({system,prompt,tier='claude-haiku',timeoutMs=12000,c=config(),spawnProcess=launch}){
  const args=['-p','--output-format','json','--model',resolveClaudeModel(tier,c),'--effort','low','--tools','',
    '--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disable-slash-commands','--no-session-persistence',
    '--setting-sources','','--system-prompt',system];
  const child=spawnProcess(claudeBin(c.claude?.bin),args,{env:await claudeEnv(),stdio:['pipe','pipe','pipe']});
  let out='',err='';
  child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err=(err+d).slice(-2000);});
  child.stdin.on('error',()=>{});child.stdin.end(prompt);
  const timer=setTimeout(()=>{try{child.kill();}catch{}},timeoutMs);
  const code=await new Promise(resolve=>{child.on('error',()=>resolve(-1));child.on('close',resolve);});
  clearTimeout(timer);
  let result;try{result=JSON.parse(out);}catch{throw new Error(`Claude quick answer failed (${code}): ${err.slice(-300)}`);}
  if(result.is_error)throw new Error('Claude quick answer: '+String(result.result||result.subtype));
  if(result.apiKeySource&&!['none','oauth'].includes(result.apiKeySource))throw new Error('Claude quick answer used an API key; subscription only');
  return String(result.result||'');
}
