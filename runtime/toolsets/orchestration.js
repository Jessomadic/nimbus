// Read-only coordination metadata. Task prompts, results, memories, connector
// secrets and approval contents are deliberately outside this inventory.
const active=['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool'];
export const tools=[{type:'function',function:{name:'team_status',description:'Inspect the live Nimbus roster, enabled tool names, organizational/display relationships and bounded task-status metadata before assigning work. No tasks are dispatched or changed; private prompts, results and credentials are omitted.',parameters:{type:'object',properties:{query:{type:'string',maxLength:500},limit:{type:'integer',minimum:1,maximum:100},runLimit:{type:'integer',minimum:1,maximum:100},includeRecent:{type:'boolean'}},required:[],additionalProperties:false}}}];
export const roleTools={orchestrator:['team_status']};
function bound(value,fallback){if(value===undefined)return fallback;if(!Number.isInteger(value)||value<1||value>100)throw new Error('Team inventory limits must be integers from 1 to 100');return value;}
export function execute(name,args={},ctx={}){
  ctx.signal?.throwIfAborted();if(name!=='team_status')throw new Error('Unknown orchestration tool: '+name);
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(key=>!['query','limit','runLimit','includeRecent'].includes(key)))throw new Error('Unsupported team status arguments');
  if(args.query!==undefined&&(typeof args.query!=='string'||args.query.length>500))throw new Error('Team query must be a string of at most 500 characters');
  if(args.includeRecent!==undefined&&typeof args.includeRecent!=='boolean')throw new Error('includeRecent must be boolean');
  if(typeof ctx.query!=='function')throw new Error('Live team inventory is unavailable');
  const limit=bound(args.limit,50),runLimit=bound(args.runLimit,30),query=(args.query||'').trim().toLowerCase();
  const found=ctx.query("SELECT id,substr(name,1,160) AS name,substr(role,1,500) AS role,substr(template,1,100) AS template,parent_bot_id,substr(display_group,1,64) AS display_group,tools FROM bots WHERE instr(lower(coalesce(name,'')||' '||coalesce(role,'')||' '||coalesce(template,'')),?)>0 ORDER BY id LIMIT ?").all(query,limit+1),rows=found.slice(0,limit);
  if(!rows.length)return{observedAt:new Date().toISOString(),workers:[],runs:[],truncated:false,readOnly:true};
  const ids=rows.map(row=>row.id),slots=ids.map(()=>'?').join(','),totals=ctx.query(`SELECT bot_id,status,count(*) AS count FROM runs WHERE bot_id IN (${slots}) GROUP BY bot_id,status`).all(...ids);
  const workers=rows.map(row=>{let enabled=[];try{const value=JSON.parse(row.tools||'[]');if(Array.isArray(value))enabled=value.filter(tool=>typeof tool==='string').slice(0,100).map(tool=>tool.slice(0,128));}catch{}
    const counts=Object.fromEntries(totals.filter(item=>item.bot_id===row.id).map(item=>[item.status,item.count]));
    return{id:row.id,name:row.name,role:row.role,template:row.template,parentId:row.parent_bot_id,displayGroup:row.display_group,enabledTools:enabled,taskCounts:counts,activeTasks:active.reduce((count,state)=>count+(counts[state]||0),0)};
  });
  const filter=args.includeRecent?'':` AND status IN (${active.map(()=>'?').join(',')})`,params=args.includeRecent?ids:[...ids,...active];
  const runs=ctx.query(`SELECT id,bot_id,status,parent_run,substr(source,1,80) AS source,started_at,ended_at FROM runs WHERE bot_id IN (${slots})${filter} ORDER BY id DESC LIMIT ?`).all(...params,runLimit+1);
  return{observedAt:new Date().toISOString(),workers,runs:runs.slice(0,runLimit),truncated:found.length>limit||runs.length>runLimit,readOnly:true,note:'Use ask_worker to delegate and worker_result to collect the actual delegated outcome. Task metadata is not completion evidence.'};
}
