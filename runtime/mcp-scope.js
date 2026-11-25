import {createHash} from 'node:crypto';
const unsafe=new Set(['__proto__','prototype','constructor']);
function object(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>unsafe.has(k)||keys&&!keys.includes(k)))throw new Error('Invalid MCP scope object');}
function identifier(v){return typeof v==='string'&&v.length>0&&v.length<=200&&!unsafe.has(v)&&!/[\x00-\x1f]/.test(v);}
function selector(s,groups,group=false){
  object(s,group?['workerIds','templates']:['workerIds','templates','groups']);
  for(const [k,v] of Object.entries(s)){
    if(!Array.isArray(v)||v.length>1000||new Set(v).size!==v.length||v.some(x=>k==='workerIds'?!Number.isSafeInteger(x)||x<1:!identifier(x)||/[\*?]/.test(x)||x.length>100))throw new Error('Invalid MCP scope selector');
    if(k==='groups'&&v.some(x=>!Object.hasOwn(groups,x)))throw new Error('Unknown MCP scope group');
  }
}
export function validateMcpScopes(c,{credentialResolver=false}={}){
  const groups=c.mcpScopeGroups===undefined?{}:c.mcpScopeGroups;object(groups);
  if(Object.keys(groups).length>1000)throw new Error('Too many MCP scope groups');
  for(const [name,s] of Object.entries(groups)){if(!/^[a-z][a-z0-9_-]{0,63}$/.test(name))throw new Error('Invalid MCP scope group');selector(s,groups,true);}
  object(c.mcpServers||{});
  for(const [name,def] of Object.entries(c.mcpServers||{})){
    if(!identifier(name))throw new Error('Invalid MCP server name');
    object(def);
    // Reference objects must never be coerced into transport credentials. Until
    // owner-bound enrollment exists, only legacy literal string maps are valid.
    for(const field of ['env','headers']){
      if(!Object.hasOwn(def,field))continue;
      object(def[field]);
      for(const [key,value] of Object.entries(def[field])){
        const validKey=field==='env'?/^[A-Za-z_][A-Za-z0-9_]*$/.test(key):/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key);
        if(!validKey||typeof value!=='string'||value.includes('\0')||(field==='headers'&&/[\r\n]/.test(value)))
          throw new Error('Invalid MCP credential transport map; unresolved references require authorized enrollment');
      }
      if(field==='env'){
        const names=Object.keys(def.env).map(k=>k.toUpperCase());
        if(new Set(names).size!==names.length)throw new Error('Ambiguous MCP environment names');
      }
    }
    if(Object.hasOwn(def,'initTimeoutMs')&&(!Number.isInteger(def.initTimeoutMs)||def.initTimeoutMs<100||def.initTimeoutMs>120000))throw new Error('Invalid MCP initialization deadline');
    if(Object.hasOwn(def,'enabled')&&typeof def.enabled!=='boolean')throw new Error('Invalid MCP enabled flag');
    if(Object.hasOwn(def,'reviewedTools')&&(!Array.isArray(def.reviewedTools)||def.reviewedTools.length>10000||new Set(def.reviewedTools).size!==def.reviewedTools.length||def.reviewedTools.some(t=>!identifier(t))))throw new Error('Invalid MCP reviewed tool allowlist');
    // Never silently treat an unresolved reference as a literal credential.
    if(Object.hasOwn(def,'credentialBinding')){
      if(!credentialResolver)throw new Error('MCP credential reference resolver unavailable; dedicated authorized enrollment required');
      if(!Object.hasOwn(def,'scope')||!Object.hasOwn(def,'reviewedTools'))throw new Error('Protected MCP requires explicit scope and reviewedTools');
      const b=def.credentialBinding;object(b,['sourceId','destination','envKey']);
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(b.sourceId||''))throw new Error('Invalid credential source');
      if(b.destination==='stdio-env'){
        if(def.url||!/^[A-Z_][A-Z0-9_]{0,99}$/.test(b.envKey||'')||Object.keys(def.env||{}).some(k=>k.toUpperCase()===b.envKey))throw new Error('Invalid credential destination');
      }else if(b.destination==='http-bearer'){
        const u=new URL(def.url);
        if(u.protocol!=='https:'||u.username||u.password||b.envKey!==undefined||Object.keys(def.headers||{}).some(k=>k.toLowerCase()==='authorization'))throw new Error('Invalid credential destination');
      }else throw new Error('Invalid credential destination');
    }
    if(Object.hasOwn(def,'reviewedEffects')){
      object(def.reviewedEffects);
      if(Object.keys(def.reviewedEffects).length>10000)throw new Error('Too many MCP effect rules');
      for(const [tool,rule] of Object.entries(def.reviewedEffects)){
        object(rule,['transportHash','effect']);
        if(!identifier(tool)||!def.reviewedTools?.includes(tool)||!['read','write','unknown'].includes(rule.effect)||!/^[a-f0-9]{64}$/.test(rule.transportHash))throw new Error('Invalid MCP reviewed effect');
      }
    }
    if(!Object.hasOwn(def,'scope'))continue;
    const s=def.scope;object(s,['allow','tools']);if(!Object.hasOwn(s,'allow'))throw new Error('MCP scope requires allow');
    selector(s.allow,groups);
    if(Object.hasOwn(s,'tools')){
      object(s.tools);if(Object.keys(s.tools).length>10000)throw new Error('Too many MCP tool rules');
      for(const [tool,rule] of Object.entries(s.tools)){
        if(!identifier(tool))throw new Error('Invalid MCP tool rule name');
        object(rule,['allow','deny']);if(!Object.keys(rule).length)throw new Error('Empty MCP tool rule');
        for(const x of Object.values(rule))selector(x,groups);
      }
    }
  }
  return c;
}
export function matches(s,p,groups={}){
  return !!p&&!!(s.workerIds?.includes(p.id)||s.templates?.includes(p.template)||s.groups?.some(g=>matches(groups[g]||{},p)));
}
export function permits(def,p,groups={},tool){
  if(!def||def.enabled===false)return false;
  if(Object.hasOwn(def,'credentialBinding')){
    try{validateMcpScopes({mcpServers:{protected:def},mcpScopeGroups:groups},{credentialResolver:true});}catch{return false;}
  }
  if(tool!==undefined&&Object.hasOwn(def,'reviewedTools')&&!def.reviewedTools.includes(tool))return false;
  if(!Object.hasOwn(def,'scope'))return true;
  const s=def.scope;if(!s||!s.allow||!matches(s.allow,p,groups))return false;
  const r=tool===undefined?undefined:s.tools?.[tool];
  return !r||((!Object.hasOwn(r,'allow')||matches(r.allow,p,groups))&&(!r.deny||!matches(r.deny,p,groups)));
}
function canonical(v){if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])]));return v;}
export function policyView(c){return {groups:c.mcpScopeGroups||{},servers:Object.fromEntries(Object.entries(c.mcpServers||{}).map(([k,v])=>[k,Object.hasOwn(v,'scope')?v.scope:null]))};}
export function policyHash(c){return createHash('sha256').update(JSON.stringify(canonical(policyView(c)))).digest('hex');}
// Host-reviewed raw-tool policy, bound to exact server and transport. Exclude
// the effect table itself to avoid a self-referential digest.
export function effectTransportHash(server,def){const {scope,reviewedEffects,...transport}=def;return createHash('sha256').update(JSON.stringify(canonical({server,transport}))).digest('hex');}
export function reviewedReadOnly(server,def,tool){const rule=def.reviewedEffects?.[tool];return !!(def.reviewedTools?.includes(tool)&&rule?.effect==='read'&&rule.transportHash===effectTransportHash(server,def));}
export function transportHash(def){const {scope,...transport}=def;return createHash('sha256').update(JSON.stringify(canonical(transport))).digest('hex');}
