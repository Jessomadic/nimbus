import {createHash} from 'node:crypto';

// Provider-facing tool names shared by the Codex and Claude backends. MCP connector
// tools get a short, stable alias; aliases map back to the original Nimbus name.
export function dynamicToolNames(tools){
  const aliases=new Map(),registered=new Set();
  const definitions=tools.map(t=>{
    const original=t.function.name;
    const name=original.startsWith('mcp__')?'connector_'+createHash('sha256').update(original).digest('hex').slice(0,12)+'_'+original.split('__').at(-1).slice(0,35):original;
    if(registered.has(name))throw new Error('Duplicate dynamic tool alias');registered.add(name);aliases.set(name,original);
    return{type:'function',name,description:(name===original?'':original+': ')+(t.function.description||''),inputSchema:t.function.parameters};
  });return{aliases,definitions};
}
