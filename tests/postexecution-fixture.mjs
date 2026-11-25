import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const root=process.env.SERIALIZATION_FIXTURE_ROOT;assert.ok(root);process.env.NIMBUS_DATA=root+'/fresh-'+Date.now();process.env.NIMBUS_CONFIG=root+'/independent-config.json';process.env.DISPATCH_LOG=process.env.NIMBUS_DATA+'-dispatch.jsonl';
assert.ok(!fs.existsSync(process.env.NIMBUS_DATA));fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({local:{enabled:false,managed:{enabled:false}},cloud:{enabled:true,models:{sol:'gpt-6.1-sol'}},mcpServers:{},workers:{permissionMode:'rules'}}));
const {db,q}=await import('../db.js'),runner=await import('../runner.js'),{checkpoint,journalTool}=await import('../runtime/journal.js');
const count=()=>fs.existsSync(process.env.DISPATCH_LOG)?fs.readFileSync(process.env.DISPATCH_LOG,'utf8').trim().split('\n').filter(Boolean).length:0;
const bot=Number(q("INSERT INTO bots(name,role,template,model,default_model,effort) VALUES('independent','fixture','orchestrator','sol','sol','medium')").run().lastInsertRowid);
function add(parent,state,status){const id=Number(q("INSERT INTO runs(bot_id,thread,prompt,status,source,parent_run,actual_model,backend) VALUES(?,?,?,?,?,?,?,?)").run(bot,'bot:'+bot,'independent harmless',status,'api',parent,'gpt-6.1-sol','codex').lastInsertRowid);checkpoint(id,state);return id;}
async function exercise(route,guard){
const s={messages:[{role:'user',content:'Independent synthetic fixture'}],instructions:'No external actions',steps:0,route:{tier:'sol',effort:'medium'}};
if(route==='silence')s.providerRecovery={code:'provider_inference_silence',model:'gpt-6.1-sol',backend:'codex',provider:'openai',selection:{model:'sol',defaultModel:'sol',effort:'medium'}};
if(route==='limit')s.projectLimit=true;
if(guard.startsWith('route-')){const k=guard.slice(6);if(k==='selection')s.providerRecovery.selection.effort='high';else if(k==='missing')delete s.providerRecovery.selection;else s.providerRecovery[k]='different';}
const leader=add(null,s,route==='interrupted'?'interrupted':'paused');runner.projectContinuation.arm(leader,{project:'independent',checkpointRef:'owned/checkpoint',mode:'until_complete'});
const cs={messages:[]};if(['refusal','noProgress','explicitStop','hostDenied'].includes(guard))cs[guard]=true;
if(guard==='nestedCheckpoint')cs.retained={envelope:{uncertain:true}};
const child=add(leader,cs,'done');
if(guard==='denial')await journalTool({id:'deny-'+child,runId:child,name:'fixture',args:{},execute:async()=>{throw Object.assign(Error('Synthetic host denial'),{hostDenied:true});}});
if(guard==='malformedJson')q("INSERT INTO tool_calls(id,run_id,name,args,state,result) VALUES(?,?,'fixture','{}','done','{')").run('malformed-'+child,child);
if(guard.startsWith('typed-'))await journalTool({id:'typed-'+child,runId:child,name:'fixture',args:{},execute:async()=>({outer:[{uncertain:guard==='typed-null'?null:guard==='typed-number'?1:'true'}]})});
if(guard==='nestedDenied')await journalTool({id:'denied-'+child,runId:child,name:'fixture',args:{},execute:async()=>({outer:[{denied:true}]})});
if(guard==='safeJournal')await journalTool({id:'safe-'+child,runId:child,name:'fixture',args:{},execute:async()=>({outer:[{uncertain:false,denied:false}],text:'uncertain:true'})});
if(guard==='deep')await journalTool({id:'deep-'+child,runId:child,name:'fixture',args:{},execute:async()=>({a:[{b:{c:[{uncertain:true}]}}]})});
if(guard==='unknown')q("INSERT INTO tool_calls(id,run_id,name,args,state,result) VALUES(?,?,'fixture','{}','mystery','{}')").run('unknown-'+child,child);
if(guard==='nestedJournal')await journalTool({id:'unknown-'+child,runId:child,name:'fixture',args:{},execute:async()=>({envelope:{uncertain:true}})});
if(guard.startsWith('raw:'))q("INSERT INTO tool_calls(id,run_id,name,args,state,result) VALUES(?,?,'fixture','{}','done',?)").run('raw-'+child,child,globalThis.rawResult);

if(guard.startsWith('broken-')){
 const kind=guard.slice(7),sentinel='PRIVATE_SENTINEL_NOT_FOR_JOURNAL';
 let value={uncertain:true,secret:sentinel};
 if(kind.startsWith('cycle'))value.self=value;
 if(kind==='bigint')value.payload=1n;
 if(kind==='getter')Object.defineProperty(value,'payload',{enumerable:true,get(){throw Error(sentinel);}});
 if(kind==='event-getter'){let reads=0;Object.defineProperty(value,'payload',{enumerable:true,get(){if(++reads>1)throw Error(sentinel);return 1;}});}
 if(kind==='cycle-refusal'||kind==='cycle-stop'||kind==='cycle-denial'){
  const flag=kind==='cycle-refusal'?'refusal':kind==='cycle-stop'?'explicitStop':'hostDenied';
  checkpoint(child,{messages:[],[flag]:true});value[flag]=true;
 }
 let executions=0;
 const execute=async()=>{executions++;if(kind==='error-cycle'){const e=Error('fixture');e.evidence=value;value.self=value;throw e;}
 if(kind==='error-bigint')throw Object.assign(Error('fixture'),{evidence:1n,hostDenied:true});
 if(kind==='error-getter')throw Object.defineProperty({},'message',{get(){throw Error(sentinel);}});
 if(kind==='throw-null')throw null;
 return value;};
 await assert.rejects(journalTool({id:'broken-'+child,runId:child,name:'fixture',args:{},execute}),{name:'UncertainAction'});
 const row=q('SELECT state,result FROM tool_calls WHERE run_id=?').get(child);
 assert.equal(row.state,'uncertain');assert.equal(JSON.parse(row.result).uncertain,true);
 assert.ok(!JSON.stringify(q('SELECT body FROM task_events WHERE run_id=?').all(child)).includes(sentinel));
 assert.ok(!row.result.includes(sentinel));assert.equal(executions,1);
 // Probe the cache gate, never execute the uncertain action again.
 await assert.rejects(journalTool({id:'broken-'+child,runId:child,name:'fixture',args:{},execute}),{name:'UncertainAction'});
 assert.equal(executions,1);
 fs.appendFileSync(root+'/observations.jsonl',JSON.stringify({route,kind,executions,row})+'\n');
}

const before=q('SELECT * FROM runs WHERE id=?').get(child),journal=q('SELECT * FROM tool_calls WHERE run_id=?').all(child),n=count();
try{runner.projectContinuation.pump();for(let i=0;i<80;i++){if(['done','error','needs_review'].includes(q('SELECT status FROM runs WHERE id=?').get(leader).status))break;await new Promise(r=>setTimeout(r,10));}
assert.deepEqual(q('SELECT * FROM runs WHERE id=?').get(child),before);assert.deepEqual(q('SELECT * FROM tool_calls WHERE run_id=?').all(child),journal);
assert.equal(count()-n,['safe','safeJournal'].includes(guard)?1:0,route+'/'+guard+' provider dispatch');if(['safe','safeJournal'].includes(guard))assert.equal(q('SELECT status FROM runs WHERE id=?').get(leader).status,'done');
}finally{runner.projectContinuation.stop(leader);}
}


export {exercise,runner,db};
