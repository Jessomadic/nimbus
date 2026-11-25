// Host-internal composition only; never accept these capabilities from tool/config input.
// Native provenance verification belongs to the trusted boot boundary, before load.
// No bridge is loaded and no legacy Python backend is selected by this module.
import {WorkerConnectors} from './mcp.js';
import {createConnectorCredentialResolver} from './connector-credentials.js';
const fail=()=>new Error('Protected connector credential unavailable');
// Observe asynchronous failures without ever treating resolution as authority.
function synchronous(callback,...args) {
  try {
    const value=callback(...args);
    if(value!==null&&(typeof value==='object'||typeof value==='function')&&typeof value.then==='function'){
      Promise.resolve(value).catch(()=>{});
      return undefined;
    }
    return value;
  } catch {return undefined;}
}
export function createConnectorHost({enrollment,backend,identity,authorize}={}) {
  let closed=false, closing;
  // Absent trusted enrollment is a normal disabled state, preserving legacy MCP.
  const enabled=enrollment !== undefined;
  if(enabled && (!Array.isArray(enrollment)||typeof backend?.read!=='function'||
      typeof identity!=='function'||typeof authorize!=='function'))throw fail();
  const resolver=createConnectorCredentialResolver({
    backend:enabled?backend:undefined,
    identity:()=>enabled&&!closed?synchronous(identity):undefined,
    authorize:request=>enabled&&!closed&&synchronous(authorize,request)===true
  });
  resolver.replace(enabled?enrollment:[]);
  const connectors=new WorkerConnectors({
    credentialResolver:resolver,
    credentialContext:()=>enabled&&!closed?synchronous(identity):{}
  });
  const closeSessions=connectors.close.bind(connectors);
  // Preserve awaitable MCP cleanup; resolver cannot outlive transport shutdown.
  connectors.close=()=>closing??=(async()=>{
    closed=true;resolver.replace([]);
    try {await closeSessions();}finally{
      resolver.close();
      if(enabled&&typeof backend.close==='function')await backend.close();
    }
  })();
  return Object.freeze({
    connectors,
    async revoke(){
      if(closed)throw fail();
      resolver.replace([]);
      // Existing facades are invalidated immediately by empty enrollment.
      // New enrollment requires a newly constructed host, never automatic refresh.
    },
    close:()=>connectors.close()
  });
}
