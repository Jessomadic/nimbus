import {historyReadValidation} from '../read-guidance.js';
import * as engineering from './engineering.js';
import * as research from './research.js';
import * as content from './content.js';
import * as operations from './operations.js';
import * as textStatistics from './generated/text_statistics.js';
import * as orchestration from './orchestration.js';

import * as mcpScope from './generated/mcp_connector_scope.js';
import * as projectSuccessorHandoff from './generated/project_successor_handoff.js';
import * as taskLifecycleReconcile from './generated/task_lifecycle_reconcile.js';
const packs=[engineering,research,content,operations,textStatistics,orchestration,mcpScope,projectSuccessorHandoff,taskLifecycleReconcile];
const handlers=new Map();
export const specialistTools=[];
for(const pack of packs)for(const tool of pack.tools){
  const name=tool.function.name;
  if(!/^[a-z][a-z0-9_]{1,63}$/.test(name)||handlers.has(name))throw new Error(`Invalid or duplicate specialist tool: ${name}`);
  handlers.set(name,pack.execute);specialistTools.push(tool);
}
export function specialistToolNames(profileId){
  return [...new Set(['tool_catalog',...packs.flatMap(pack=>pack.roleTools[profileId]||[])])];
}
export function hasSpecialistTool(name){return handlers.has(name);}
export async function executeSpecialist(name,args,context){
  const handler=handlers.get(name);if(!handler)throw new Error(`Unknown specialist tool: ${name}`);
  if(name==='task_history')historyReadValidation(args,operations.tools.find(t=>t.function.name===name).function.parameters.properties);
  return handler(name,args,context);
}
export function roleToolCoverage(profiles){
  return profiles.map(profile=>({id:profile.id,name:profile.name,tools:specialistToolNames(profile.id),specialistTools:specialistToolNames(profile.id).filter(name=>name!=='tool_catalog')}));
}
