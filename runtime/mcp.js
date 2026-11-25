import path from 'node:path';
import fs from 'node:fs';
import {createHmac,randomBytes} from 'node:crypto';

// Sanitize before serialization: JSON escaping must not hide a credential.
export function sanitizeConnectorValue(value,secret){
  const variants=[secret,JSON.stringify(secret).slice(1,-1)].filter(Boolean);
  const clean=s=>variants.reduce((v,x)=>v.replaceAll(x,'[REDACTED]'),s);
  const visit=v=>typeof v==='string'?clean(v):Array.isArray(v)?v.map(visit):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([k,x])=>[clean(k),visit(x)])):v;
  return visit(value);
}
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {redact} from '../redact.js';
import {permits,validateMcpScopes,transportHash,reviewedReadOnly} from './mcp-scope.js';
import {UncertainAction} from './action-error.js';
const registry=new WeakMap();
export function connectorAllowed(binding,owner){
  const b=registry.get(binding);if(!b||b.owner!==owner||!b.live())return false;
  try{const c=b.current();validateMcpScopes(c,{credentialResolver:true});return c.principal?.id===owner&&transportHash(c.mcpServers[b.server]||{})===b.transport&&permits(c.mcpServers[b.server],c.principal,c.mcpScopeGroups,b.tool);}catch{return false;}
}
export async function invokeConnector(binding,owner,args,{signal,timeout=120000}={}){
  signal?.throwIfAborted();if(!connectorAllowed(binding,owner))throw new Error('MCP connector authorization denied');
  const b=registry.get(binding),provenance={owner,server:b.server,tool:b.tool,canonicalName:b.canonical};
  // No await between authorization and submission. Cached connections are not permissions.
  let result;
  try{result=await b.client.callTool({name:b.tool,arguments:args},undefined,{signal,timeout});}
  catch(e){const message=cleanConnectorError(e.message,b.definition);if(!b.readOnly)throw new UncertainAction('Connector outcome uncertain; inspect effects before retrying.',{provenance,error:message});throw new Error(message);}
  result=sanitizeConfiguredValue(result,b.definition);
  if(result.isError&&!b.readOnly)throw new UncertainAction('Connector reported an error after submission; inspect effects before retrying.',{provenance,result});
  return {...result,nimbusConnector:{provenance,...(result.isError?{error:'Connector reported an error'}:{})}};
}

function configuredSecrets(definition){
  const values=[...Object.values(definition.headers||{}),...Object.values(definition.env||{})];
  if(definition.url)try{const u=new URL(definition.url);values.push(decodeURIComponent(u.username),decodeURIComponent(u.password));for(const [k,v] of u.searchParams)if(/token|secret|password|key|signature/i.test(k))values.push(v);}catch{}
  return values.filter(v=>typeof v==='string'&&v.length>0).flatMap(v=>[v,v.replace(/^(?:Bearer|Basic)\s+/i,'')]).filter(Boolean).sort((a,b)=>b.length-a.length);
}
function sanitizeConfiguredValue(value,definition){
  for(const secret of configuredSecrets(definition))value=sanitizeConnectorValue(value,secret);
  return value;
}
export function cleanConnectorError(value,definition={}) {
  let result=sanitizeConfiguredValue(String(value||'Connector unavailable'),definition);
  for(const secret of [...Object.values(definition.headers||{}),...Object.values(definition.env||{})]){
    if(typeof secret!=='string'||secret.length<4)continue;
    result=result.replaceAll(secret,'[REDACTED]');const bearer=secret.replace(/^(?:Bearer|Basic)\s+/i,'');if(bearer.length>=4)result=result.replaceAll(bearer,'[REDACTED]');
  }
  result=result.replace(/((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)[^\s"'\\,;]+/gi,'$1[REDACTED]')
    .replace(/((?:set-cookie|cookie)["']?\s*[:=]\s*["']?)[^\r\n]+/gi,'$1[REDACTED]')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi,raw=>{try{const url=new URL(raw);url.username='';url.password='';for(const key of url.searchParams.keys())if(/token|secret|password|key|signature/i.test(key))url.searchParams.set(key,'[REDACTED]');return url.href;}catch{return '[invalid endpoint]';}});
  return redact(result).slice(0,2000);
}

export function pinnedConnectorFetch(endpoint) {
  const pinned=new URL(endpoint).href;
  return async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:String(input)).href;
    const method=String(init.method||(input instanceof Request?input.method:'GET')).toUpperCase();
    if(url!==pinned||!['POST','GET','DELETE'].includes(method))throw new Error('MCP endpoint denied');
    const response=await globalThis.fetch(input,{...init,redirect:'error'});
    if(response.status>=300&&response.status<400){await response.body?.cancel();throw new Error('MCP redirect denied');}
    return response;
  };
}
export class WorkerConnectors {
  #resolver; #context; #lifetime=new AbortController();
  #cacheSalt=randomBytes(32);
  #activeSessions=new Set();
  cacheKey(owner,name,definition){return createHmac('sha256',this.#cacheSalt).update(JSON.stringify([owner,name,definition])).digest('hex');}
  constructor({credentialResolver,credentialContext}={}) { this.clients = new Map(); this.#resolver=credentialResolver; this.#context=credentialContext; }
  async protectedSession(owner,name,definition,tool,operation,{signal,mcpScopeGroups={}}={}){
    if(!this.#resolver||typeof this.#context!=='function')throw new Error('MCP credential reference resolver unavailable');
    const b=definition.credentialBinding,context=this.#context();
    if(!context || typeof context!=='object')throw new Error('Protected connector credential unavailable');
    signal=AbortSignal.any([this.#lifetime.signal,...(signal?[signal]:[])]);
    signal.throwIfAborted();
    let result;
    await this.#resolver.use({sourceId:b.sourceId,destination:b.destination},{
      ownerId:context.ownerId,profileId:context.profileId,workerId:owner,server:name,
      purpose:'mcp',transportId:transportHash(definition),tool,
      ...(b.destination==='stdio-env'?{envKey:b.envKey}:{origin:new URL(definition.url).origin})
    },async(bytes,{signal:leaseSignal})=>{
      const privateDefinition=structuredClone(definition);delete privateDefinition.credentialBinding;
      if(b.destination==='stdio-env')privateDefinition.env={...privateDefinition.env,[b.envKey]:bytes.toString('ascii')};
      else privateDefinition.headers={...privateDefinition.headers,Authorization:'Bearer '+bytes.toString('ascii')};
      const isolated=new WorkerConnectors();
      const close=isolated.close.bind(isolated);let closing;
      isolated.close=()=>closing??=close();
      this.#activeSessions.add(isolated);
      const abort=()=>{void isolated.close();};
      leaseSignal.addEventListener('abort',abort,{once:true});
      try{
        const client=await isolated.connect(owner,name,privateDefinition,{signal:leaseSignal,mcpScopeGroups});
        leaseSignal.throwIfAborted();
        result=await operation(client,leaseSignal);
        const secret=bytes.toString('ascii');
        result=sanitizeConnectorValue(result,secret);
      }catch{throw new Error('Protected connector transport unavailable');}
      finally{leaseSignal.removeEventListener('abort',abort);try{await isolated.close();}finally{this.#activeSessions.delete(isolated);}}
    },{signal});
    return result;
  }
  async connect(owner, name, definition, {signal,mcpScopeGroups={}}={}) {
    signal=AbortSignal.any([this.#lifetime.signal,...(signal?[signal]:[])]);
    signal.throwIfAborted();
    validateMcpScopes({mcpServers:{[name]:definition},mcpScopeGroups},{credentialResolver:!!this.#resolver});
    if(definition.enabled===false)throw new Error('MCP connector disabled');
    const key = this.cacheKey(owner,name,definition);
    if (this.clients.has(key)) return this.clients.get(key);
    if(definition.credentialBinding){
      const generationSignal=signal;
      const scoped=options=>({...options,mcpScopeGroups,signal:AbortSignal.any([generationSignal,...(options?.signal?[options.signal]:[])])});
      const facade={
        listTools:(params,options)=>this.protectedSession(owner,name,definition,'discover',(c,s)=>c.listTools(params,{...options,signal:s}),scoped(options)),
        callTool:(params,schema,options)=>this.protectedSession(owner,name,definition,params.name,(c,s)=>c.callTool(params,schema,{...options,signal:s}),scoped(options)),
        close:async()=>{}
      };
      const pending=Promise.resolve(facade);this.clients.set(key,pending);return pending;
    }
    const pending = (async () => {
      const client = new Client({ name: 'nimbus', version: '0.2.0' });
      let transport;
      if (definition.url) {
        transport = new StreamableHTTPClientTransport(new URL(definition.url), { fetch:pinnedConnectorFetch(definition.url), requestInit: { headers: definition.headers || {}, redirect:'error' } });
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
      // SDK clears its process pointer before awaiting exit. All cleanup callers
      // must share its documented 2s EOF + 2s SIGTERM escalation promise.
      const transportClose=transport.close.bind(transport);let transportClosing;
      transport.close=()=>transportClosing??=transportClose();
      // Failed initialization is closed/evicted, never automatically replayed.
      let timer,abort;
      let cleaning;
      const cleanup=()=>cleaning??=(async()=>{try{await client.close();}catch{}try{await transport.close();}catch{}})();
      let abandoned=false;
      const initializing=client.connect(transport);
      void initializing.then(()=>{if(abandoned)void cleanup();},()=>{});
      try {
        await Promise.race([
          initializing,
          new Promise((_,reject)=>{abort=()=>{abandoned=true;void cleanup();reject(new Error('MCP initialization cancelled'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('MCP initialization deadline exceeded')),definition.initTimeoutMs||30000);})
        ]);
        signal.throwIfAborted();
      } catch(e) {
        abandoned=true;
        await cleanup();
        throw e;
      } finally { clearTimeout(timer);signal.removeEventListener('abort',abort); }
      client.onclose=()=>{if(this.clients.get(key)===pending)this.clients.delete(key);};
      return client;
    })().catch(e => { if(this.clients.get(key)===pending)this.clients.delete(key); throw e; });
    this.clients.set(key, pending); return pending;
  }
  async tools(owner, servers, current=()=>({principal:{id:owner},mcpServers:servers,mcpScopeGroups:{}})) {
    servers=structuredClone(servers);
    const available=[],bindings=new Map(),errors=[],staged=[],seen=new Set(),collisions=new Set();
    validateMcpScopes(current(),{credentialResolver:true});
    const namespaces=new Map(),ambiguous=new Set();
    for(const name of Object.keys(servers)){
      const normalized=name.replace(/[^a-zA-Z0-9_-]/g,'_');
      if(normalized.includes('__'))ambiguous.add(name);
      if(namespaces.has(normalized)){ambiguous.add(name);ambiguous.add(namespaces.get(normalized));}
      namespaces.set(normalized,name);
    }
    for(const [name,cfg] of Object.entries(servers)){
      const initial=current();validateMcpScopes(initial,{credentialResolver:true});
      if(ambiguous.has(name)||initial.principal?.id!==owner||transportHash(initial.mcpServers[name]||{})!==transportHash(cfg)||!permits(initial.mcpServers[name],initial.principal,initial.mcpScopeGroups))continue;
      try{
        const client=await this.connect(owner,name,cfg,{mcpScopeGroups:initial.mcpScopeGroups}),generation=this.clients.get(this.cacheKey(owner,name,cfg)),local=[],cursors=new Set();
        let cursor,pages=0;
        do{
          if(++pages>100)throw new Error('MCP discovery page limit');
          const fresh=current();validateMcpScopes(fresh,{credentialResolver:true});
          if(fresh.principal?.id!==owner||transportHash(fresh.mcpServers[name]||{})!==transportHash(cfg)||!permits(fresh.mcpServers[name],fresh.principal,fresh.mcpScopeGroups))throw new Error('MCP discovery authorization revoked');
          const page=await client.listTools(cursor?{cursor}:{}, {timeout:30000});
          for(const tool of page.tools){
            const id=`mcp__${name}__${tool.name}`.replace(/[^a-zA-Z0-9_-]/g,'_');
            if(seen.has(id))collisions.add(id);seen.add(id);
            if(id.length>64)throw new Error('MCP tool name too long');
            local.push({id,tool});
            if(local.length>10000)throw new Error('MCP discovery tool limit');
          }
          cursor=page.nextCursor;
          if(cursor&&cursors.has(cursor))throw new Error('Repeated MCP discovery cursor');
          cursors.add(cursor);
        }while(cursor);
        for(const {id,tool} of local)staged.push({id,tool,client,name,cfg,generation});
      }catch(e){errors.push({server:name,error:cleanConnectorError(e.message,cfg)});}
    }
    for(const {id,tool,client,name,cfg,generation} of staged){
      if(collisions.has(id))continue;
      const binding=Object.freeze({tool:tool.name,readOnly:reviewedReadOnly(name,cfg,tool.name),descriptor:structuredClone(tool),provenance:{owner,server:name,tool:tool.name,canonicalName:id}});
      registry.set(binding,{owner,server:name,tool:tool.name,canonical:id,readOnly:binding.readOnly,definition:cfg,client,current,transport:transportHash(cfg),live:()=>generation!==undefined&&this.clients.get(this.cacheKey(owner,name,cfg))===generation});
      if(!connectorAllowed(binding,owner))continue;
      available.push({type:'function',function:{name:id,description:tool.description||tool.name,parameters:tool.inputSchema}});
      bindings.set(id,binding);
    }
    const visibleErrors=errors.filter(e=>{try{const c=current();validateMcpScopes(c,{credentialResolver:true});return c.principal?.id===owner&&permits(c.mcpServers[e.server],c.principal,c.mcpScopeGroups);}catch{return false;}});
    return {available,bindings,errors:visibleErrors};
  }
  async close() {
    // Revoke old bindings before awaiting cleanup; later generations survive.
    const lifetime=this.#lifetime;this.#lifetime=new AbortController();
    const pending=[...this.clients.values()],sessions=[...this.#activeSessions];
    this.clients.clear();
    lifetime.abort();
    await Promise.all([...pending.map(async p=>{try{await (await p).close();}catch{}}),...sessions.map(s=>s.close())]);
  }
}
