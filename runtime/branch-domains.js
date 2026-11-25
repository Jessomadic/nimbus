// Private durable lifecycle-domain closure. No release/transfer authority.
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';
export const domainTables=['runs','tool_calls','approvals','messages','task_events','task_requests','run_context','message_requests',
'project_continuations','project_silence_recovery','project_lifecycle_owners','project_lifecycle_owner_events',
'tool_development_requests','tool_development_stages','tool_development_stage_history','tool_development_recoveries','tool_development_watchers','tool_development_checks','tool_development_keys','tool_development_retries',
'project_handoff_reservations','project_handoff_events','project_handoff_bindings','task_questions','task_question_routes','task_question_outbox','task_question_attention','task_question_attention_members','task_question_events','task_question_commands','child_context'];
const runKeys=['run_id','child_run','parent_run','leader_run_id','previous_leader_run_id','origin_run_id','requester_run_id','task_id','coordinator_run_id','original_coordinator_run_id','successor_run_id'];
const digest=b=>createHash('sha256').update(b).digest('hex');
const fail=s=>{throw Error(s)};
function refs(table,row){
 const runs=runKeys.filter(k=>row[k]!=null).map(k=>Number(row[k]));
 const requests=[table==='project_handoff_reservations'?null:row.request_id,row.owner_request_id].filter(x=>x!=null);
 const reservations=[row.reservation_id,table==='project_handoff_reservations'?row.id:null].filter(x=>x!=null);
 const questions=row.question_id==null?[]:[row.question_id];
 if(table==='runs')runs.push(row.id);
 if(table==='tool_development_requests')requests.push(row.id);
 if(table==='task_questions')questions.push(row.id);
 if(table==='project_handoff_reservations'){const intent=JSON.parse(row.intent);if(!Number.isSafeInteger(intent.leaderRunId))fail('incomplete_handoff');runs.push(intent.leaderRunId);}
 return{runs,requests,questions,reservations};
}
export function captureDomains(db,leaderId){
 ensureChildContextSchema(db);
 const all=Object.fromEntries(domainTables.map(t=>[t,db.prepare('SELECT * FROM '+t).all()]));
 const runs=new Set([leaderId]),requests=new Set(),questions=new Set(),messages=new Set(),reservations=new Set();
 const selected=new Map(domainTables.map(t=>[t,new Set()]));
 let changed=true,n=0;
 while(changed){
  if(++n>10000)fail('domain_closure_budget');changed=false;
  const add=(set,v)=>{if(!set.has(v)){set.add(v);changed=true;}};
  for(const table of domainTables)for(const row of all[table]){
   const r=refs(table,row);
   if(r.runs.some(x=>runs.has(x))||r.requests.some(x=>requests.has(x))||r.questions.some(x=>questions.has(x))||r.reservations.some(x=>reservations.has(x))||
      table==='messages'&&messages.has(row.id)||(table==='message_requests'||table==='run_context')&&messages.has(row.message_id)){
    if(!selected.get(table).has(row)){selected.get(table).add(row);changed=true;}
    // Never traverse parent_run upwards: descendancy is containment, not authority.
    for(const x of r.runs)if(table!=='runs'||x===row.id)add(runs,x);
    for(const x of r.requests)add(requests,x);
    for(const x of r.questions)add(questions,x);
    for(const x of r.reservations)add(reservations,x);
    if(table==='messages')add(messages,row.id);
    if(table==='run_context')add(messages,row.message_id);
   }
  }
 }
 for(const id of runs)if(!all.runs.some(r=>r.id===id))fail('domain_run_missing');
 for(const id of requests)if(!all.tool_development_requests.some(r=>r.id===id))fail('domain_request_missing');
 for(const id of questions)if(!all.task_questions.some(r=>r.id===id))fail('domain_question_missing');
 const relations=Object.fromEntries([...selected].map(([t,rows])=>[t,[...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]));
 return{schema:Object.fromEntries(domainTables.map(t=>[t,db.prepare('PRAGMA table_info('+t+')').all()])),reservations:[...reservations].sort(),runs:[...runs].sort((a,b)=>a-b),requests:[...requests].sort(),questions:[...questions].sort((a,b)=>a-b),messages:[...messages].sort((a,b)=>a-b),relations};
}
export function archiveDomainArtifacts(domain,checkpointRoot){
 const root=fs.realpathSync(checkpointRoot),files=new Set();
 for(const [table,rows]of Object.entries(domain.relations))for(const row of rows){
  for(const key of ['artifact_path','archived_artifact_path']){
   if(row[key])files.add(row[key]);
  }
 }
 return [...files].sort().map(value=>{
  const file=path.resolve(root,value);
  if(!file.startsWith(root+path.sep)||fs.realpathSync(file)!==file)fail('domain_artifact_path');
  const bytes=fs.readFileSync(file);return{path:file,bytes:bytes.length,sha256:digest(bytes)};
 });
}
export function ensureDomainSchema(db){
 db.exec('CREATE TABLE IF NOT EXISTS branch_host_domain_holds(kind TEXT NOT NULL,domain_key TEXT NOT NULL,preparation_id TEXT NOT NULL,PRIMARY KEY(kind,domain_key));');
}
export function assertDomainMutation(db,requestId){
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='branch_host_domain_holds'").get()&&
 db.prepare("SELECT 1 FROM branch_host_domain_holds WHERE kind='request' AND domain_key=?").get(String(requestId)))fail('protected_lifecycle_domain');
}
export function installDomainFences(db,tables=domainTables){
 ensureDomainSchema(db);
 if(tables===domainTables)ensureChildContextSchema(db);
 const exists=(kind,value)=>"EXISTS(SELECT 1 FROM branch_host_domain_holds WHERE kind='"+kind+"' AND domain_key=CAST("+value+" AS TEXT))";
 for(const table of tables){
  const cols=db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name);
  if(!cols.length)fail('domain_schema_missing:'+table);
  const terms=prefix=>{
   const terms=runKeys.filter(k=>cols.includes(k)).map(k=>exists('run',prefix+'.'+k));
   if(table==='child_context')for(const k of ['parent_run','child_run'].filter(k=>cols.includes(k))){
    terms.push("EXISTS(WITH RECURSIVE ancestors(id,parent_run) AS (SELECT id,parent_run FROM runs WHERE id="+prefix+"."+k+" UNION SELECT r.id,r.parent_run FROM runs r JOIN ancestors a ON r.id=a.parent_run) SELECT 1 FROM branch_host_holds h JOIN ancestors a ON a.id=h.run_id)");
   }
   for(const k of ['request_id','owner_request_id'])if(cols.includes(k))terms.push(exists('request',prefix+'.'+k));
   if(cols.includes('reservation_id'))terms.push(exists('reservation',prefix+'.reservation_id'));
   if(table==='project_handoff_reservations')terms.push(exists('reservation',prefix+'.id'));
   if(cols.includes('question_id'))terms.push(exists('question',prefix+'.question_id'));
   if(table==='runs')terms.push(exists('run',prefix+'.id'));
   if(table==='tool_development_requests')terms.push(exists('request',prefix+'.id'));
   if(table==='task_questions')terms.push(exists('question',prefix+'.id'));
   if(table==='messages')terms.push(exists('message',prefix+'.id'));
   if(table==='message_requests'||table==='run_context')terms.push(exists('message',prefix+'.message_id'));
   if(table==='project_handoff_reservations')terms.push(exists('run',"json_extract("+prefix+".intent,'$.leaderRunId')"));
   return terms.join(' OR ')||'0';
  };
  for(const op of ['INSERT','UPDATE','DELETE']){
   const condition=op==='UPDATE'?'('+terms('OLD')+') OR ('+terms('NEW')+')':terms(op==='DELETE'?'OLD':'NEW');
   db.exec('CREATE TRIGGER IF NOT EXISTS '+(table==='child_context'?'branch_domain_v3_':'branch_domain_v2_')+table+'_'+op+' BEFORE '+op+' ON '+table+' WHEN '+condition+" BEGIN SELECT RAISE(ABORT,'protected_lifecycle_domain'); END;");
  }
 }
}
export function holdDomains(db,domain,id){
 for(const [kind,keys]of Object.entries({run:domain.runs,request:domain.requests,question:domain.questions,message:domain.messages,reservation:domain.reservations}))
  for(const key of keys)db.prepare('INSERT INTO branch_host_domain_holds VALUES(?,?,?)').run(kind,String(key),id);
}

// Additive upgrade only: no historical domain rows, snapshots, triggers or seals rewritten.
export function ensureChildContextSchema(db){
 db.exec('SAVEPOINT child_context_schema');
 try{
  db.exec(`CREATE TABLE IF NOT EXISTS child_context (
   id INTEGER PRIMARY KEY AUTOINCREMENT,parent_run INTEGER NOT NULL,child_run INTEGER NOT NULL,
   request_key TEXT NOT NULL,fingerprint TEXT NOT NULL,target TEXT NOT NULL,prompt TEXT NOT NULL,
   UNIQUE(parent_run,request_key));`);
  db.exec('CREATE TABLE IF NOT EXISTS branch_host_holds(run_id INTEGER PRIMARY KEY,preparation_id TEXT NOT NULL)');
  // Add the lookup index only where the relation column exists.
  const cols=db.prepare('PRAGMA table_info(child_context)').all().map(c=>c.name);
  if(cols.includes('child_run'))db.exec('CREATE INDEX IF NOT EXISTS child_context_child ON child_context(child_run,id)');
  installDomainFences(db,['child_context']);
  db.exec('RELEASE child_context_schema');
 }catch(e){db.exec('ROLLBACK TO child_context_schema');db.exec('RELEASE child_context_schema');throw e;}
}
export function assertContextRunDispatch(db,runId){
 const has=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 if(has('branch_host_domain_holds')&&db.prepare("SELECT 1 FROM branch_host_domain_holds WHERE kind='run' AND domain_key=?").get(String(runId)))fail('protected_lifecycle_domain');
 if(has('branch_host_holds')&&db.prepare('WITH RECURSIVE ancestors(id,parent_run) AS (SELECT id,parent_run FROM runs WHERE id=? UNION SELECT r.id,r.parent_run FROM runs r JOIN ancestors a ON r.id=a.parent_run) SELECT 1 FROM branch_host_holds h JOIN ancestors a ON a.id=h.run_id LIMIT 1').get(runId))fail('protected_branch_held');
}
