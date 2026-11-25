import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {QuestionRouter} from '../runtime/question-routing.js';
import {registerQuestionRoutes} from '../runtime/question-http.js';
import {renderQuestionCard} from '../public/question-card.js';

async function fixture(t){
 const db=new DatabaseSync(':memory:');db.exec(`CREATE TABLE bots(id INTEGER PRIMARY KEY,template TEXT,name TEXT);INSERT INTO bots VALUES(22,'orchestrator','Orchestrator'),(2,'builder','Builder');
 CREATE TABLE runs(id INTEGER PRIMARY KEY,bot_id INTEGER,parent_run INTEGER,status TEXT,source TEXT,thread TEXT,checkpoint TEXT);INSERT INTO runs VALUES(930,22,NULL,'running','api','bot:22','{}'),(956,2,930,'waiting_input','api','bot:2','{}'),(1000,22,NULL,'queued','api','bot:22','{}');
 CREATE TABLE tool_calls(id TEXT PRIMARY KEY,run_id INTEGER,name TEXT,state TEXT);INSERT INTO tool_calls VALUES('956:ask',956,'request_user_input','running');CREATE TABLE approvals(run_id INTEGER,status TEXT);`);
 const router=new QuestionRouter({db}),routes=[],q=sql=>db.prepare(sql),json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 const authenticate=(req,res)=>{if(req.headers.authorization!=='Bearer fixture-owner'){json(res,401,{error:'Sign in required'});return false;}if(req.headers.origin&&req.headers.origin!==base){json(res,403,{error:'Same origin required'});return false;}return true;};
 let base;
 registerQuestionRoutes({router,route:(method,pattern,handler)=>routes.push({method,pattern,handler}),body:async req=>{let raw='';for await(const chunk of req)raw+=chunk;return JSON.parse(raw||'{}');},json,authenticate,rebindOwner:(req,res)=>{if(!authenticate(req,res))return false;if(req.headers['x-owner']!=='yes'){json(res,403,{error:'Host owner required'});return false;}return true;},principal:()=> 'fixture-owner',listPending:()=>q("SELECT id FROM task_questions WHERE status='pending'").all().map(row=>row.id)});
 const server=http.createServer(async(req,res)=>{for(const route of routes){const match=req.url.match(new RegExp('^'+route.pattern.replace(':id','([0-9]+)')+'$'));if(req.method===route.method&&match){try{await route.handler(req,res,{id:match[1]});}catch(error){json(res,500,{error:error.message});}return;}}json(res,404,{error:'Not found'});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));db.close();});
 const request=async(url,{method='GET',body,headers={}}={})=>{const r=await fetch(base+url,{method,headers:{authorization:'Bearer fixture-owner','content-type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,value:await r.json()};};
 const ticket=router.create({runId:956,callId:'956:ask',questions:[{question:'Which owner preference is missing?',options:['First','Second']}]});return{router,q,request,ticket};
}

test('real HTTP human inbox excludes coordinator-only questions; escalation and answer retain actor, version and idempotency',async t=>{
 const s=await fixture(t);assert.deepEqual((await s.request('/api/questions')).value,[]);assert.equal((await s.request('/api/questions/inbox')).value[0].id,s.ticket.id);
 const escalated=s.router.escalate({questionId:s.ticket.id,expectedVersion:s.ticket.version,reason:'The owner preference is not recorded'},{runId:930,botId:22});
 assert.equal((await s.request('/api/questions')).value[0].audience,'human');
 const body={answers:['Second'],expectedVersion:escalated.version,idempotencyKey:'fixture-human-answer'};
 const answer=await s.request('/api/questions/'+s.ticket.id+'/answer',{method:'POST',body});assert.equal(answer.status,200);assert.equal(answer.value.answerActor.kind,'human');assert.equal(answer.value.answerActor.principal,'fixture-owner');
 assert.deepEqual((await s.request('/api/questions/'+s.ticket.id+'/answer',{method:'POST',body})).value,answer.value);
 assert.equal((await s.request('/api/questions/'+s.ticket.id+'/answer',{method:'POST',body:{...body,answers:['First'],idempotencyKey:'another'}})).status,409);
 assert.deepEqual((await s.request('/api/questions')).value,[]);assert.equal(s.q("SELECT count(*) AS n FROM task_question_events WHERE event='answered'").get().n,1);
});

test('HTTP authentication, same-origin and host-bound input reject spoofing; explicit human override is truthful',async t=>{
 const s=await fixture(t),path='/api/questions/'+s.ticket.id+'/answer',body={answers:['Owner override'],expectedVersion:s.ticket.version};
 assert.equal((await s.request(path,{method:'POST',body,headers:{authorization:'Bearer wrong'}})).status,401);
 assert.equal((await s.request(path,{method:'POST',body,headers:{origin:'https://other.invalid'}})).status,403);
 assert.equal((await s.request(path,{method:'POST',body:{...body,authenticated:true,principal:'fake-coordinator',coordinatorRunId:930}})).status,400);
 assert.equal(s.router.get(s.ticket.id).status,'pending');const result=await s.request(path,{method:'POST',body});assert.equal(result.status,200);assert.equal(result.value.answerActor.kind,'human');assert.equal(result.value.answerActor.runId,undefined);
});

test('host-only explicit rebind preserves ticket and DONE record; unsupported body authority cannot rebind',async t=>{
 const s=await fixture(t);s.q("UPDATE runs SET status='done' WHERE id=930").run();const body={expectedVersion:s.ticket.version,coordinatorRunId:1000,reason:'Explicit host successor assignment'};
 assert.equal((await s.request('/api/questions/'+s.ticket.id+'/rebind',{method:'POST',body})).status,403);
 const result=await s.request('/api/questions/'+s.ticket.id+'/rebind',{method:'POST',body,headers:{'x-owner':'yes'}});assert.equal(result.status,200);assert.equal(result.value.id,s.ticket.id);assert.equal(result.value.coordinatorRunId,1000);assert.equal(s.q('SELECT status FROM runs WHERE id=930').get().status,'done');
 assert.equal((await s.request('/api/questions/'+s.ticket.id+'/rebind',{method:'POST',body:{...body,host:{authenticated:true}},headers:{'x-owner':'yes'}})).status,400);
});

test('legacy human question remains answerable by authenticated UI without a historical version',async t=>{
 const s=await fixture(t),id=Number(s.q('INSERT INTO task_questions(run_id,questions) VALUES(?,?)').run(930,JSON.stringify([{question:'Legacy owner question'}])).lastInsertRowid);
 const result=await s.request('/api/questions/'+id+'/answer',{method:'POST',body:{answers:['Legacy reply']}});assert.equal(result.status,200);assert.equal(result.value.answerActor.kind,'human');assert.deepEqual(result.value.answers,['Legacy reply']);
});

test('dashboard question cards show actual origin/actor and only present automatic human form in coordinator chat',()=>{
 const q={questionId:6,version:2,status:'pending',audience:'coordinator',originRunId:956,coordinatorRunId:930,questions:[{question:'Choose <script>bad</script>',options:['A" onclick="bad']}],interactive:false};
 const child=renderQuestionCard(q);assert.doesNotMatch(child,/<textarea|<button|<script>/);assert.match(child,/Orchestrator is reviewing/);assert.match(child,/task #956/);
 const coordinator=renderQuestionCard({...q,interactive:true});assert.match(coordinator,/<details[^>]*><summary>Answer yourself/);assert.doesNotMatch(coordinator,/Your input is needed/);
 const escalated=renderQuestionCard({...q,interactive:true,audience:'human',transportStatus:'not_sent_disabled'});assert.match(escalated,/Your input is needed/);assert.match(escalated,/data-question-version="2"/);assert.match(escalated,/External message delivery is not connected/);assert.doesNotMatch(renderQuestionCard({...q,audience:'human'}),/<textarea/);
 assert.match(renderQuestionCard({...q,status:'answered',answers:['Safe <answer>'],answerActor:{kind:'coordinator'}}),/Answered by Orchestrator/);assert.match(renderQuestionCard({...q,status:'answered',answers:['Owner answer'],answerActor:{kind:'human'}}),/Answered by owner/);
 const admin=renderQuestionCard({...q,status:'answered',answers:['Administrative reply'],answerActor:{kind:'human',principal:'local-admin'}});assert.match(admin,/Answered by local administrator/);assert.match(admin,/approval decided/);assert.doesNotMatch(admin,/Answered by you/);assert.match(renderQuestionCard({...q,status:'answered',answers:['Reply'],answerActor:{kind:'human',principal:'<owner>'}}),/Answered by &lt;owner&gt;/);
});
