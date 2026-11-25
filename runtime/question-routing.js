import {createHash,randomUUID} from 'node:crypto';
import {redact} from '../redact.js';
import {resolveOrchestrator} from './orchestrator.js';

const parse=(value,fallback=null)=>{try{return JSON.parse(value);}catch{return fallback;}};
const live=new Set(['queued','routing','running','waiting_local','waiting_cloud','waiting_input','waiting_tool','paused','interrupted']);
const coordinatorCalls=new Set(['question_inbox','answer_worker_question','escalate_worker_question','worker_result','team_status']);
const fingerprint=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive=value=>Number.isSafeInteger(value)&&value>0;
function fail(message,code='question_conflict'){throw Object.assign(new Error(message),{code,statusCode:409});}

export function validateQuestions(questions){
  if(!Array.isArray(questions)||!questions.length||questions.length>3||questions.some(item=>!item||typeof item!=='object'||Array.isArray(item)||typeof item.question!=='string'||!item.question.trim()||item.question.length>4000||item.options!==undefined&&(!Array.isArray(item.options)||item.options.length>3||item.options.some(o=>typeof o!=='string'||!o.trim()||o.length>500))))throw new Error('Provide 1 to 3 concise questions and up to 3 answer options each');
  const limits={title:120,context:600,recommendation:600,details:4000};
  return questions.map(item=>{
    const value={question:item.question,...(item.options?{options:[...item.options]}:{})};
    for(const [key,limit]of Object.entries(limits))if(item[key]!==undefined){
      if(typeof item[key]!=='string'||!item[key].trim()||item[key].length>limit)throw new Error(`Question ${key} must be nonempty text of at most ${limit} characters`);
      value[key]=item[key];
    }
    return value;
  });
}

// Host-owned routing, with no queue, network, provider, approval or tool-journal
// mutation. All actor/host arguments are supplied by the runtime, never tools.
export class QuestionRouter{
  constructor({db,emit=()=>{},sanitize=redact,humanOwner='owner',resolveCoordinator=()=>null}={}){
    if(!db?.prepare)throw new Error('QuestionRouter requires an injected database');
    this.db=db;this.q=sql=>db.prepare(sql);this.emit=emit;this.sanitize=sanitize;this.humanOwner=humanOwner;this.resolveCoordinator=resolveCoordinator;this.serial=0;
    db.exec(`CREATE TABLE IF NOT EXISTS task_questions(
      id INTEGER PRIMARY KEY AUTOINCREMENT,run_id INTEGER NOT NULL,questions TEXT NOT NULL,
      answers TEXT,status TEXT DEFAULT 'pending',created_at INTEGER DEFAULT(unixepoch()));
    CREATE TABLE IF NOT EXISTS task_question_routes(
      question_id INTEGER PRIMARY KEY,origin_call_id TEXT NOT NULL,origin_fingerprint TEXT NOT NULL,
      coordinator_run_id INTEGER,project_key TEXT NOT NULL,audience TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,answer_actor TEXT,reason TEXT,hold_reason TEXT,
      delivered_at INTEGER,owner_request_id TEXT,UNIQUE(origin_call_id));
    CREATE TABLE IF NOT EXISTS task_question_events(
      id INTEGER PRIMARY KEY AUTOINCREMENT,question_id INTEGER NOT NULL,event TEXT NOT NULL,
      version INTEGER NOT NULL,actor TEXT NOT NULL,details TEXT NOT NULL,created_at INTEGER DEFAULT(unixepoch()));
    CREATE TABLE IF NOT EXISTS task_question_commands(
      command_key TEXT PRIMARY KEY,question_id INTEGER NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_question_outbox(
      correlation_id TEXT PRIMARY KEY,question_id INTEGER NOT NULL,question_version INTEGER NOT NULL,
      intended_owner TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'disabled',payload TEXT NOT NULL,
      created_at INTEGER DEFAULT(unixepoch()),UNIQUE(question_id,question_version));
    CREATE TABLE IF NOT EXISTS task_question_attention(
      question_id INTEGER PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,run_id INTEGER UNIQUE,
      original_coordinator_run_id INTEGER,bot_id INTEGER NOT NULL,status TEXT NOT NULL,
      created_at INTEGER DEFAULT(unixepoch()));
    CREATE TABLE IF NOT EXISTS task_question_attention_members(
      question_id INTEGER PRIMARY KEY,run_id INTEGER NOT NULL,created_at INTEGER DEFAULT(unixepoch()));`);
    if(!this.q('PRAGMA table_info(task_question_routes)').all().some(c=>c.name==='owner_request_id'))db.exec('ALTER TABLE task_question_routes ADD COLUMN owner_request_id TEXT');
  }
  _clean(value){if(typeof value==='string')return this.sanitize(value);if(Array.isArray(value))return value.map(x=>this._clean(x));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this._clean(v)]));return value;}
  _atomic(fn){const key='question_'+(++this.serial);this.db.exec('SAVEPOINT '+key);try{const result=fn();this.db.exec('RELEASE '+key);return result;}catch(error){this.db.exec('ROLLBACK TO '+key);this.db.exec('RELEASE '+key);throw error;}}
  _table(name){return!!this.q("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  _run(id){return positive(Number(id))?this.q('SELECT * FROM runs WHERE id=?').get(Number(id)):null;}
  _bot(run){return run?this.q('SELECT * FROM bots WHERE id=?').get(run.bot_id):null;}
  _policy(run){return run&&this._table('project_continuations')?this.q('SELECT * FROM project_continuations WHERE run_id=?').get(run.id):null;}
  _row(id){return this.q('SELECT q.*,r.origin_call_id,r.origin_fingerprint,r.coordinator_run_id,r.project_key,r.audience,r.version,r.answer_actor,r.reason,r.hold_reason,r.delivered_at,r.owner_request_id FROM task_questions q LEFT JOIN task_question_routes r ON r.question_id=q.id WHERE q.id=?').get(Number(id));}
  _audit(row,event,actor,details={}){this.q('INSERT INTO task_question_events(question_id,event,version,actor,details) VALUES(?,?,?,?,?)').run(row.id,event,row.version||1,JSON.stringify(this._clean(actor)),JSON.stringify(this._clean(details)));}
  _publish(id){const view=this.get(id);try{this.emit('question.changed',view);}catch{/* durable state remains authoritative when a UI observer fails */}return view;}
  _hold(id,reason){
    const row=this._row(id);if(!row||row.status!=='pending'||!row.origin_call_id||(row.hold_reason||null)===(reason||null))return;
    this._atomic(()=>{this.q('UPDATE task_question_routes SET hold_reason=? WHERE question_id=?').run(reason||null,id);this._audit(this._row(id),'attention_hold',{kind:'runtime'},{reason:reason||null});});
    this._publish(id);
  }
  _coordinator(origin){let run=origin?.parent_run&&this._bot(origin)?.template==='orchestrator'?this._run(origin.parent_run):origin;const seen=new Set();for(let n=0;run&&n<64;n++){
    if(seen.has(run.id))return null;seen.add(run.id);
    if(this._bot(run)?.template==='orchestrator')return run;
    run=this._run(run.parent_run);
  }return null;}
  _escalationAncestor(coordinator){
    // Attention runs are deliberately parentless and question-only. Their
    // retained origin, never their replacement shape, supplies ancestry.
    let source=coordinator;const seen=new Set();
    while(source){
      if(seen.has(source.id)||seen.size>=64)fail('Question attention ancestry requires reconciliation','question_owner_unsafe');seen.add(source.id);
      const attention=this.attentionForRun(source.id);if(!attention){const upstream=this._coordinator(source);return upstream?.id===source.id?null:upstream;}
      source=this._run(attention.original_coordinator_run_id);if(!source)fail('Original coordinator is missing','question_owner_unsafe');
      const unsafe=this._unsafe(source);if(unsafe&&unsafe!=='run_unavailable')fail('Original coordinator authority requires reconciliation: '+unsafe,'question_owner_unsafe');
    }
    return null;
  }
  _binding(origin){
    const resolved=this.resolveCoordinator(origin?.id);
    if(resolved?.then)throw new Error('Question coordinator resolver must be synchronous');
    if(resolved!==null&&resolved!==undefined){
      if(!resolved||typeof resolved!=='object'||typeof resolved.authorized!=='boolean'||typeof resolved.requestId!=='string'||!resolved.requestId)throw new Error('Invalid host coordinator resolution');
      const run=this._run(resolved.runId);
      return{run,requestId:resolved.requestId,projectKey:resolved.projectKey||'request:'+resolved.requestId,authorized:resolved.authorized&&!!run&&this._bot(run)?.template==='orchestrator',attentionOnly:resolved.attentionOnly===true};
    }
    const run=this._coordinator(origin);return{run,requestId:null,projectKey:this._policy(run)?.project||'run:'+(run?.id||origin?.id),authorized:true,attentionOnly:false};
  }
  _refreshBinding(id){
    const row=this._row(id);if(!row?.origin_call_id||row.status!=='pending')return;
    const binding=this._binding(this._run(row.run_id));if(!binding.requestId)return;
    if(!binding.authorized){this._hold(id,'coordinator_ownership_requires_review');return;}
    const attention=this.attentionForRun(row.coordinator_run_id);
    if(binding.attentionOnly&&attention?.original_coordinator_run_id===binding.run?.id)return;
    if(row.coordinator_run_id===binding.run.id&&row.owner_request_id===binding.requestId){if(row.hold_reason==='coordinator_ownership_requires_review')this._hold(id,null);return;}
    this._originSafe(row);
    this._atomic(()=>{this.q('UPDATE task_question_routes SET coordinator_run_id=?,owner_request_id=?,project_key=?,version=version+1,hold_reason=NULL WHERE question_id=?').run(binding.run.id,binding.requestId,binding.projectKey,id);this._audit(this._row(id),'ownership_rebound',{kind:'runtime'},{previousCoordinatorRunId:row.coordinator_run_id,coordinatorRunId:binding.run.id,requestId:binding.requestId});this.q("UPDATE task_question_outbox SET state='superseded' WHERE question_id=?").run(id);if(row.audience==='human')this._outbox(this._row(id));});
    this._publish(id);
  }
  _unsafe(run,{callId,questionCall=false}={}){
    if(!run)return 'run_missing';
    if(run.status==='stopped'||this._policy(run)?.stopped)return 'owner_stopped';
    if(parse(run.checkpoint,{})?.noProgress)return 'no_progress';
    if(this._table('approvals')&&this.q("SELECT 1 FROM approvals WHERE run_id=? AND status IN ('denied','rejected') LIMIT 1").get(run.id))return 'policy_denied';
    if(this._table('tool_calls')){const other=[];for(const call of this.q("SELECT id,name,state FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain')").all(run.id)){
      const own=call.id===callId&&(questionCall?call.name==='request_user_input':call.state==='running'&&coordinatorCalls.has(call.name));
      if(!own)other.push(call);
    }if(other.some(call=>call.state==='uncertain'))return 'uncertain_action';if(other.length)return 'running_action';}
    if(!live.has(run.status))return 'run_unavailable';
    return null;
  }
  _originSafe(row){if(row.origin_call_id?.startsWith('legacy-question:'))fail('Legacy question call correlation requires host review','question_origin_unsafe');const error=this._unsafe(this._run(row.run_id),{callId:row.origin_call_id,questionCall:true});if(error)fail('The originating task requires reconciliation: '+error,'question_origin_unsafe');}
  _actor(actor,row,{readOnly=false}={}){
    const run=this._run(actor?.runId),bot=this._bot(run);
    if(!run||Number(actor?.botId)!==run.bot_id||bot?.template!=='orchestrator')fail('Only the actual coordinating Orchestrator may handle this question','question_owner_required');
    if(row&&row.coordinator_run_id!==run.id)fail('Question belongs to another coordinator','question_scope_denied');
    if(!readOnly){
      if(row?.owner_request_id){const binding=this._binding(this._run(row.run_id)),attention=this.attentionForRun(run.id);if(!binding.authorized||binding.requestId!==row.owner_request_id||binding.run?.id!==run.id&&!(binding.attentionOnly&&attention?.original_coordinator_run_id===binding.run?.id))fail('Current adopted coordinator ownership requires reconciliation','question_owner_unsafe');}
      const unsafe=this._unsafe(run,{callId:actor.callId});if(unsafe)fail('Coordinator requires reconciliation: '+unsafe,'question_owner_unsafe');
      const attention=this.attentionForRun(run.id),original=attention&&this._run(attention.original_coordinator_run_id);
      if(original){const priorUnsafe=this._unsafe(original);if(priorUnsafe&&priorUnsafe!=='run_unavailable')fail('Original coordinator authority requires reconciliation: '+priorUnsafe,'question_owner_unsafe');}
    }
    return{kind:'coordinator',runId:run.id,botId:run.bot_id};
  }
  _host(host){if(host?.authenticated!==true||typeof host.principal!=='string'||!host.principal.trim()||host.principal.length>200)fail('Authenticated owner required','question_owner_required');return{kind:'human',principal:host.principal};}
  _expected(row,version){if(!row||row.status!=='pending')fail('Question is no longer pending');if(!positive(version)||version!==(row.version||1))fail('Question version changed','question_stale_version');}
  _answers(row,answers){const questions=parse(row.questions,[]);if(!Array.isArray(answers)||answers.length!==questions.length||answers.some(a=>typeof a!=='string'||!a.trim()||a.length>16000))throw new Error('Answer each question');return this._clean(answers);}
  _command(key,id,body,fn){
    if(key!==undefined&&(typeof key!=='string'||!key.trim()||key.length>200))throw new Error('Invalid question command identity');
    const digest=fingerprint(body),previous=key?this.q('SELECT * FROM task_question_commands WHERE command_key=?').get(key):null;
    if(previous){if(previous.question_id!==id||previous.fingerprint!==digest)fail('Question command identity was reused with different input');return parse(previous.result);}
    const result=fn();if(key)this.q('INSERT INTO task_question_commands VALUES(?,?,?,?)').run(key,id,digest,JSON.stringify(result));return result;
  }
  _outbox(row){
    const id='nimbus-question:'+row.id+':'+row.version;
    // No transcript, credentials, filesystem contents or provider context.
    const payload={correlationId:id,questionId:row.id,version:row.version,questions:parse(row.questions),originRunId:row.run_id,coordinatorRunId:row.coordinator_run_id};
    this.q("INSERT OR IGNORE INTO task_question_outbox(correlation_id,question_id,question_version,intended_owner,state,payload) VALUES(?,?,?,?,'disabled',?)").run(id,row.id,row.version,this.humanOwner,JSON.stringify(payload));
    return id;
  }
  create({runId,callId,questions,destination}){
    const items=this._clean(validateQuestions(questions));if(!positive(runId)||typeof callId!=='string'||!callId||callId.length>200)throw new Error('Question origin identity required');
    if(destination!==undefined&&!['host','human'].includes(destination))throw new Error('Choose human or host recovery');
    const digest=fingerprint({runId,questions:items,...(destination?{destination}:{})});
    const result=this._atomic(()=>{
      const existing=this.q('SELECT question_id,origin_fingerprint FROM task_question_routes WHERE origin_call_id=?').get(callId);
      if(existing){if(existing.origin_fingerprint!==digest)fail('Question call identity changed');return this.get(existing.question_id);}
      const origin=this._run(runId);const unsafe=this._unsafe(origin,{callId,questionCall:true});if(unsafe)fail('Question origin requires reconciliation: '+unsafe);
      if(this._table('tool_calls')){const call=this.q('SELECT run_id,name,state FROM tool_calls WHERE id=?').get(callId);if(!call||call.run_id!==runId||call.name!=='request_user_input'||call.state!=='running')fail('Question call is not the current host journal entry');}
      const binding=this._binding(origin),coordinator=binding.run,rootQuestion=coordinator?.id===origin.id&&!origin.parent_run&&!binding.requestId;
      // A child's hint cannot bypass its coordinator. Only the actual root
      // Orchestrator can request internal host recovery for its own question.
      const audience=rootQuestion?(destination||'human'):'coordinator',hold=!binding.authorized?'coordinator_ownership_requires_review':!coordinator?'host_rebind_required':null;
      const project=binding.projectKey;
      const id=Number(this.q('INSERT INTO task_questions(run_id,questions) VALUES(?,?)').run(runId,JSON.stringify(items)).lastInsertRowid);
      this.q('INSERT INTO task_question_routes(question_id,origin_call_id,origin_fingerprint,coordinator_run_id,project_key,audience,hold_reason,owner_request_id) VALUES(?,?,?,?,?,?,?,?)').run(id,callId,digest,coordinator?.id||null,project,audience,hold,binding.requestId);
      const row=this._row(id);this._audit(row,'created',{kind:'runtime',runId},{audience,coordinatorRunId:coordinator?.id||null});
      if(audience==='human')this._outbox(row);return this.get(id);
    });return this._publish(result.id);
  }
  get(id){
    const row=this._row(id);if(!row)return null;
    const origin=this._run(row.run_id),coordinator=this._run(row.coordinator_run_id),coordinatorBot=this._bot(coordinator);
    let holdReason=row.hold_reason||null;
    if(row.origin_call_id&&row.status==='pending'){
      const unsafe=this._unsafe(origin,{callId:row.origin_call_id,questionCall:true});
      if(unsafe)holdReason=unsafe;
      else if(!holdReason&&row.audience==='coordinator'&&(!coordinator||!live.has(coordinator.status)||this._policy(coordinator)?.stopped||parse(coordinator.checkpoint,{})?.noProgress))holdReason='host_rebind_required';
    }
    const outbox=this.q('SELECT correlation_id,state FROM task_question_outbox WHERE question_id=? AND question_version=?').get(row.id,row.version||1);
    const legacyActor=!row.origin_call_id&&row.status==='answered'?parse(this.q("SELECT actor FROM task_question_events WHERE question_id=? AND event='answered' ORDER BY id DESC LIMIT 1").get(row.id)?.actor):null,questions=parse(row.questions,[]);
    return{id:row.id,questionId:row.id,run_id:row.run_id,originRunId:row.run_id,originThread:origin?.thread||null,callId:row.origin_call_id||null,coordinatorRunId:row.coordinator_run_id||null,coordinatorBotId:coordinatorBot?.id||null,thread:coordinator?.thread||origin?.thread||null,projectKey:row.project_key||null,ownerRequestId:row.owner_request_id||null,questions:Array.isArray(questions)?questions:[],answers:parse(row.answers),status:row.status,audience:row.audience||'human',version:row.version||1,holdReason,answerActor:parse(row.answer_actor)||legacyActor,reason:row.reason||null,deliveredAt:row.delivered_at||null,correlationId:outbox?.correlation_id||null,transportStatus:outbox?outbox.state==='disabled'?'not_sent_disabled':outbox.state:null};
  }
  inbox(actor,{limit=20,includeAnswered=false}={}){
    const identity=this._actor(actor,null,{readOnly:true});limit=Math.max(1,Math.min(100,Math.trunc(Number(limit)||20)));
    return this.q(`SELECT q.id FROM task_questions q JOIN task_question_routes r ON r.question_id=q.id WHERE r.coordinator_run_id=? ${includeAnswered?'':"AND q.status='pending'"} ORDER BY q.id LIMIT ?`).all(identity.runId,limit).map(x=>this.get(x.id));
  }
  pendingForCoordinator(runId){return this.q("SELECT q.id FROM task_questions q JOIN task_question_routes r ON r.question_id=q.id WHERE r.coordinator_run_id=? AND q.status='pending' ORDER BY q.id").all(Number(runId)).map(x=>this.get(x.id));}
  pendingForRun(runId,{descendants=false}={}){
    const ids=new Set([Number(runId)]);if(descendants){let frontier=[Number(runId)];for(let n=0;frontier.length&&n<64;n++){const next=[];for(const id of frontier)for(const row of this.q('SELECT id FROM runs WHERE parent_run=?').all(id))if(!ids.has(row.id)){ids.add(row.id);next.push(row.id);}frontier=next;}}
    return this.q("SELECT id,run_id FROM task_questions WHERE status='pending' ORDER BY id").all().filter(x=>ids.has(x.run_id)).map(x=>this.get(x.id));
  }
  listHuman(){return this.q("SELECT q.id FROM task_questions q LEFT JOIN task_question_routes r ON r.question_id=q.id WHERE q.status='pending' AND (r.audience='human' OR r.question_id IS NULL) ORDER BY q.id").all().map(x=>this.get(x.id));}
  answer(input,actor){
    const result=this._atomic(()=>{const row=this._row(input.questionId),identity=this._actor(actor,row);if(!row)fail('Unknown question');
      return this._command(input.idempotencyKey,row.id,{action:'answer',identity,...input},()=>{
        this._expected(row,input.expectedVersion);if(!['coordinator','host'].includes(row.audience))fail('This question requires the human owner');this._originSafe(row);
        const answers=this._answers(row,input.answers);this.q("UPDATE task_questions SET answers=?,status='answered' WHERE id=? AND status='pending'").run(JSON.stringify(answers),row.id);
        this.q("UPDATE task_question_outbox SET state='resolved' WHERE question_id=? AND state!='cancelled'").run(row.id);
        this.q('UPDATE task_question_routes SET version=version+1,answer_actor=?,reason=?,hold_reason=NULL WHERE question_id=?').run(JSON.stringify(identity),this.sanitize(input.reason||'Answered from existing scope and evidence'),row.id);
        this._audit(this._row(row.id),'answered',identity,{answers});return this.get(row.id);
      });});return this._publish(result.id);
  }
  escalate(input,actor){
    const result=this._atomic(()=>{const row=this._row(input.questionId),identity=this._actor(actor,null);if(!row)fail('Unknown question');
      return this._command(input.idempotencyKey,row.id,{action:'escalate',identity,...input},()=>{
        this._actor(actor,row);
        this._expected(row,input.expectedVersion);if(!['coordinator','host'].includes(row.audience))fail('Question already awaits the human');this._originSafe(row);
        if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>4000)throw new Error('Explain the genuinely unresolved human input');
        const destination=input.destination??'human';
        if(!['human','host'].includes(destination))throw new Error('Choose human or host recovery');
        // A scoped coordinator asks its actual coordinating ancestor first.
        // Lifecycle-owned questions keep their authenticated host binding.
        const upstream=!row.owner_request_id&&destination==='human'?this._escalationAncestor(this._run(row.coordinator_run_id)):null;
        if(upstream&&upstream.id!==row.coordinator_run_id){
          const unsafe=this._unsafe(upstream);if(unsafe&&unsafe!=='running_action')fail('Upstream coordinator requires reconciliation: '+unsafe,'question_owner_unsafe');
          this.q("UPDATE task_question_routes SET coordinator_run_id=?,audience='coordinator',version=version+1,reason=?,hold_reason=NULL WHERE question_id=?").run(upstream.id,this.sanitize(input.reason),row.id);
          const updated=this._row(row.id);this._audit(updated,'escalated',identity,{reason:input.reason,destination:'coordinator',previousCoordinatorRunId:row.coordinator_run_id,coordinatorRunId:upstream.id});return this.get(row.id);
        }
        if(row.audience===destination)fail('Question already awaits this destination');
        this.q("UPDATE task_question_routes SET audience=?,version=version+1,reason=?,hold_reason=NULL WHERE question_id=?").run(destination,this.sanitize(input.reason),row.id);
        const updated=this._row(row.id);if(destination==='human')this._outbox(updated);this._audit(updated,'escalated',identity,{reason:input.reason,destination});return this.get(row.id);
      });});return this._publish(result.id);
  }
  answerHuman(id,answers,host){
    const identity=this._host(host),result=this._atomic(()=>{const row=this._row(id);if(!row)fail('Unknown question');
      return this._command(host.idempotencyKey,row.id,{action:'human_answer',identity,id:Number(id),answers,version:host.expectedVersion},()=>{
        this._expected(row,row.origin_call_id?host.expectedVersion:host.expectedVersion??1);if(row.origin_call_id)this._originSafe(row);
        const clean=this._answers(row,answers);this.q("UPDATE task_questions SET answers=?,status='answered' WHERE id=? AND status='pending'").run(JSON.stringify(clean),row.id);
        this.q("UPDATE task_question_outbox SET state='resolved' WHERE question_id=? AND state!='cancelled'").run(row.id);
        if(row.origin_call_id)this.q('UPDATE task_question_routes SET version=version+1,answer_actor=?,hold_reason=NULL WHERE question_id=?').run(JSON.stringify(identity),row.id);
        this._audit(this._row(row.id),'answered',identity,{answers:clean});return this.get(row.id);
      });});return this._publish(result.id);
  }
  getForCall(runId,callId){const row=this.q('SELECT q.id FROM task_questions q JOIN task_question_routes r ON r.question_id=q.id WHERE q.run_id=? AND r.origin_call_id=?').get(Number(runId),callId);return row?this.get(row.id):null;}
  result({questionId,runId,callId}){
    if(questionId===undefined)questionId=this.getForCall(runId,callId)?.id;
    const row=this._row(questionId);if(!row||row.run_id!==runId||row.origin_call_id!==callId)fail('Question result belongs to another call','question_scope_denied');
    return this.get(row.id);
  }
  markDelivered({questionId,runId,callId}){
    const view=this.result({questionId,runId,callId});if(view.status!=='answered')fail('Question is not answered');
    this.q('UPDATE task_question_routes SET delivered_at=COALESCE(delivered_at,unixepoch()) WHERE question_id=?').run(questionId);return this.get(questionId);
  }
  cancelRun(runId,reason='Originating task stopped'){
    const changed=this._atomic(()=>{const rows=this.q("SELECT id FROM task_questions WHERE run_id=? AND status='pending'").all(Number(runId));for(const {id}of rows){this.q("UPDATE task_questions SET status='expired' WHERE id=? AND status='pending'").run(id);this.q('UPDATE task_question_routes SET version=version+1,reason=? WHERE question_id=?').run(this.sanitize(reason),id);this.q("UPDATE task_question_outbox SET state='cancelled' WHERE question_id=?").run(id);this._audit(this._row(id),'cancelled',{kind:'runtime',runId:Number(runId)},{reason});}return rows.map(x=>x.id);});return changed.map(id=>this._publish(id));
  }
  rebind(input,host){
    const identity=this._host(host),result=this._atomic(()=>{const row=this._row(input.questionId);this._expected(row,input.expectedVersion);if(!row.origin_call_id)fail('Legacy human question has no coordinator routing');this._originSafe(row);
      if(row.owner_request_id){const binding=this._binding(this._run(row.run_id));if(!binding.authorized||binding.requestId!==row.owner_request_id||binding.run?.id!==input.coordinatorRunId)fail('Host rebind must respect the current adopted coordinator');}
      if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>2000)throw new Error('Explicit rebind reason required');
      const previous=this._run(row.coordinator_run_id),next=this._run(input.coordinatorRunId),bot=this._bot(next),policy=this._policy(next);
      if(previous){const priorUnsafe=this._unsafe(previous);if(priorUnsafe&&priorUnsafe!=='run_unavailable')fail('Rebinding cannot override an explicit stop or unresolved authority: '+priorUnsafe);}
      if(previous&&live.has(previous.status)&&previous.id!==next?.id)fail('Existing coordinator is still active');
      if(!next||next.parent_run||bot?.template!=='orchestrator'||this._unsafe(next))fail('An available parentless Orchestrator is required');
      if(!row.project_key.startsWith('run:')&&policy?.project!==row.project_key)fail('Successor project does not match');
      this.q('UPDATE task_question_routes SET coordinator_run_id=?,version=version+1,reason=?,hold_reason=NULL WHERE question_id=?').run(next.id,this.sanitize(input.reason),row.id);
      this._audit(this._row(row.id),'rebound',identity,{previousCoordinatorRunId:previous?.id||null,coordinatorRunId:next.id,reason:input.reason});
      // Old transport correlations are stale after a binding/version change.
      this.q("UPDATE task_question_outbox SET state='superseded' WHERE question_id=?").run(row.id);if(row.audience==='human')this._outbox(this._row(row.id));return this.get(row.id);
    });return this._publish(result.id);
  }
  reconcile(){
    const changed=this.migrateLegacyPending();for(const row of this.q("SELECT q.id,q.run_id FROM task_questions q JOIN task_question_routes r ON r.question_id=q.id WHERE q.status='pending'").all()){
      const origin=this._run(row.run_id);if(origin?.status==='stopped')changed.push(...this.cancelRun(origin.id));
      else try{this._refreshBinding(row.id);}catch(error){this._hold(row.id,this.sanitize(error.message).slice(0,700));}
    }return changed;
  }
  migrateLegacyPending(){
    const rows=this.q("SELECT q.* FROM task_questions q LEFT JOIN task_question_routes r ON r.question_id=q.id WHERE q.status='pending' AND r.question_id IS NULL ORDER BY q.id").all(),changed=[];
    const hasArgs=this._table('tool_calls')&&this.q('PRAGMA table_info(tool_calls)').all().some(c=>c.name==='args');
    for(const row of rows){try{
      const origin=this._run(row.run_id);if(!origin)continue;if(origin.status==='stopped'){changed.push(...this.cancelRun(origin.id));continue;}
      // Existing root-human questions retain their legacy answer compatibility.
      if(!origin.parent_run&&this._bot(origin)?.template==='orchestrator')continue;
      const items=this._clean(validateQuestions(parse(row.questions))),binding=this._binding(origin);
      const matches=hasArgs?this.q("SELECT id,args FROM tool_calls WHERE run_id=? AND name='request_user_input' AND state IN ('running','uncertain')").all(origin.id).filter(call=>{
        try{return fingerprint(this._clean(validateQuestions(parse(call.args)?.questions)))===fingerprint(items)&&!this.q('SELECT 1 FROM task_question_routes WHERE origin_call_id=?').get(call.id);}catch{return false;}
      }):[];
      const singlePending=this.q("SELECT count(*) AS n FROM task_questions WHERE run_id=? AND status='pending'").get(origin.id).n===1;
      const callId=matches.length===1&&singlePending?matches[0].id:'legacy-question:'+row.id;
      const hold=callId.startsWith('legacy-question:')?'legacy_question_call_requires_review':!binding.authorized?'coordinator_ownership_requires_review':!binding.run?'host_rebind_required':null;
      this._atomic(()=>{
        this.q("INSERT INTO task_question_routes(question_id,origin_call_id,origin_fingerprint,coordinator_run_id,project_key,audience,hold_reason,owner_request_id) VALUES(?,?,?,?,?,'coordinator',?,?)").run(row.id,callId,fingerprint({runId:origin.id,questions:items}),binding.run?.id||null,binding.projectKey,hold,binding.requestId);
        this._audit(this._row(row.id),'legacy_routed',{kind:'runtime'},{journalMatched:!callId.startsWith('legacy-question:'),callId:callId.startsWith('legacy-question:')?null:callId});
      });changed.push(this._publish(row.id));
    }catch(error){
      const exists=this.q('SELECT 1 FROM task_question_routes WHERE question_id=?').get(row.id);
      if(!exists)this._atomic(()=>{this.q("INSERT INTO task_question_routes(question_id,origin_call_id,origin_fingerprint,project_key,audience,hold_reason) VALUES(?,?,?,?,'coordinator',?)").run(row.id,'legacy-question:'+row.id,fingerprint({runId:row.run_id,rawQuestions:row.questions}),'legacy-run:'+row.run_id,'legacy_question_requires_review');this._audit(this._row(row.id),'legacy_held',{kind:'runtime'},{reason:this.sanitize(error.message).slice(0,700)});});
      changed.push(this._publish(row.id));
    }
    }return changed;
  }
  attentionForRun(runId){const row=this.q('SELECT * FROM task_question_attention WHERE run_id=?').get(Number(runId));return row?{...row,questionIds:[row.question_id,...this.q('SELECT question_id FROM task_question_attention_members WHERE run_id=? ORDER BY question_id').all(Number(runId)).map(x=>x.question_id)]}:null;}
  // Runtime-only insertion callback. Commit route/run ownership before caller
  // enqueues. No project continuation, lifecycle adoption or source grant exists.
  ensureAttention(questionId,{create}={}){
    let result;
    try{this._refreshBinding(Number(questionId));result=this._atomic(()=>{
      const row=this._row(questionId);if(!row||row.status!=='pending'||row.audience!=='coordinator')return{questionId:Number(questionId),status:'not_needed',enqueue:false};
      const binding=this._binding(this._run(row.run_id));
      if(row.owner_request_id&&!binding.authorized)return{questionId:row.id,status:'blocked',enqueue:false,reason:'coordinator_ownership_requires_review'};
      this._originSafe(row);
      const member=this.q('SELECT run_id FROM task_question_attention_members WHERE question_id=?').get(row.id);
      const prior=this.q('SELECT * FROM task_question_attention WHERE question_id=?').get(row.id)||(member&&this.attentionForRun(member.run_id));
      if(prior){
        const run=this._run(prior.run_id);
        if(!run||row.coordinator_run_id!==run.id)return{questionId:row.id,status:'blocked',enqueue:false,reason:'attention_binding_requires_review'};
        return{questionId:row.id,runId:run.id,status:live.has(run.status)?'existing':'blocked',enqueue:run.status==='queued',reason:live.has(run.status)?null:'attention_ended_without_answer'};
      }
      const old=this._run(row.coordinator_run_id);
      const parked=!!(old&&binding.requestId&&binding.authorized&&binding.attentionOnly&&binding.run?.id===old.id&&old.status==='waiting_tool'&&parse(old.checkpoint,{})?.awaitingToolRequest===binding.requestId);
      if(old&&live.has(old.status)&&!parked)return{questionId:row.id,runId:old.id,status:'existing',enqueue:false};
      if(old){const unsafe=this._unsafe(old);if(unsafe&&unsafe!=='run_unavailable')fail('Attention cannot override coordinator hold: '+unsafe);if(old.status!=='done'&&!parked)fail('Previous coordinator requires reconciliation before attention');}
      const ancestor=old||this._coordinator(this._run(row.run_id));
      let bot=this._bot(ancestor);
      if(bot?.template!=='orchestrator'){
        try{bot=resolveOrchestrator(this.q('SELECT * FROM bots ORDER BY id').all());}
        catch{fail('No unambiguous Orchestrator profile for question attention','question_coordinator_unavailable');}
      }
      const shared=this.q("SELECT a.run_id FROM task_question_attention a JOIN runs rr ON rr.id=a.run_id JOIN task_question_routes route ON route.question_id=a.question_id WHERE a.original_coordinator_run_id IS ? AND a.bot_id=? AND route.project_key=? AND rr.status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_input','waiting_tool','paused','interrupted') ORDER BY a.run_id LIMIT 1").get(old?.id||null,bot.id,row.project_key);
      if(shared){
        const run=this._run(shared.run_id),unsafe=this._unsafe(run);
        // Only live host-owned question attention is shared. A running question
        // coordinator may be reading/waiting; unknown effects still fail closed.
        if(unsafe&&unsafe!=='running_action')fail('Existing attention requires reconciliation: '+unsafe);
        this.q('INSERT INTO task_question_attention_members(question_id,run_id) VALUES(?,?)').run(row.id,run.id);
        this.q('UPDATE task_question_routes SET coordinator_run_id=?,version=version+1,hold_reason=NULL WHERE question_id=?').run(run.id,row.id);
        this._audit(this._row(row.id),'attention_joined',{kind:'runtime'},{coordinatorRunId:run.id,originalCoordinatorRunId:old?.id||null,scope:'same_original_coordinator_and_project'});
        return{questionId:row.id,runId:run.id,status:'bound_existing',enqueue:run.status==='queued'};
      }
      const busy=this.q("SELECT id FROM runs WHERE bot_id=? AND id!=? AND status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input','waiting_tool') LIMIT 1").get(bot.id,parked?old.id:-1);
      if(busy)return{questionId:row.id,status:'blocked',enqueue:false,reason:'coordinator_bot_busy',busyRunId:busy.id};
      if(typeof create!=='function')fail('Host attention insertion callback unavailable');
      const requestId='question-attention:'+row.id;
      this.q("INSERT INTO task_question_attention(question_id,request_key,original_coordinator_run_id,bot_id,status) VALUES(?,?,?,?,'reserving')").run(row.id,requestId,old?.id||null,bot.id);
      const highWater=this.q('SELECT COALESCE(max(id),0) AS id FROM runs').get().id;
      const runId=Number(create({botId:bot.id,questionId:row.id,requestId,projectKey:row.project_key,originRunId:row.run_id,originalCoordinatorRunId:old?.id||null}));
      const run=this._run(runId);
      if(!positive(runId)||runId<=highWater||!run||run.bot_id!==bot.id||run.parent_run||run.source!=='api'||run.status!=='queued')fail('Host attention insertion did not create the expected queued run');
      this.q("UPDATE task_question_attention SET run_id=?,status='bound' WHERE question_id=?").run(runId,row.id);
      this.q('UPDATE task_question_routes SET coordinator_run_id=?,version=version+1,hold_reason=NULL WHERE question_id=?').run(runId,row.id);
      this._audit(this._row(row.id),'attention_bound',{kind:'runtime'},{originalCoordinatorRunId:old?.id||null,coordinatorRunId:runId,requestId,scope:'question_only'});
      return{questionId:row.id,runId,status:'queued',enqueue:true};
    });}catch(error){this._hold(Number(questionId),this.sanitize(String(error.code||'attention_setup_required')+': '+error.message).slice(0,700));throw error;}
    if(result.status==='blocked')this._hold(result.questionId,result.reason);
    else if(result.status==='existing')this._hold(result.questionId,null);
    if(['queued','bound_existing'].includes(result.status))this._publish(result.questionId);return result;
  }
  transportOutbox(){return this.q('SELECT correlation_id AS correlationId,question_id AS questionId,question_version AS version,intended_owner AS intendedOwner,state,payload FROM task_question_outbox ORDER BY created_at,correlation_id').all().map(row=>({...row,payload:parse(row.payload)}));}
  acceptTransportReply(input,host){
    this._host(host);if(host.transport!=='mock'||host.linkedOwner!==host.principal)fail('External question transport is disabled; only authenticated linked mocks are supported','question_transport_disabled');
    const item=this.q('SELECT * FROM task_question_outbox WHERE correlation_id=?').get(input.correlationId);
    if(!item||item.intended_owner!==host.principal)fail('Unknown or unauthorized question correlation','question_scope_denied');
    if(input.expectedVersion!==item.question_version)fail('Transport reply version changed','question_stale_version');
    return this.answerHuman(item.question_id,input.answers,{...host,expectedVersion:item.question_version,idempotencyKey:input.idempotencyKey});
  }
}
