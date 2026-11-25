import {WorkerConnectors} from '../../runtime/mcp.js';
// Use real discovery/registration and scoped authorization; only transport is synthetic.
export async function registeredConnector(owner,name,binding,schema){
  const server=name.split('__')[1];
  const tool=binding.tool||name.split('__')[2];
  const client={listTools:async()=>({tools:[{name:tool,inputSchema:schema,annotations:{readOnlyHint:binding.readOnly===true}}]}),callTool:binding.client?.callTool||(async()=>({content:[]}))};
  class Synthetic extends WorkerConnectors{
    async connect(owner,name,cfg){this.clients.set(this.cacheKey(owner,name,cfg),Promise.resolve(client));return client;}
  }
  const manager=new Synthetic(),state={principal:{id:owner},mcpServers:{[server]:{command:'synthetic',scope:{allow:{workerIds:[owner]}}}},mcpScopeGroups:{}};
  if(binding.readOnly===true){
    const {effectTransportHash}=await import('../../runtime/mcp-scope.js');
    const def=state.mcpServers[server];def.reviewedTools=[tool];
    def.reviewedEffects={[tool]:{effect:'read',transportHash:effectTransportHash(server,def)}};
  }
  const discovered=await manager.tools(owner,state.mcpServers,()=>state);
  return {bindings:discovered.bindings,availableTools:discovered.available,state,manager};
}
