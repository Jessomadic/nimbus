import {test,mock,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import {fileURLToPath,pathToFileURL} from 'node:url'; import {createHash} from 'node:crypto';
const root=path.dirname(fileURLToPath(import.meta.url));
const candidate=fileURLToPath(new URL('../../',import.meta.url));
const url=p=>pathToFileURL(path.join(candidate,p)).href;
const data=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-scheduled-quiet-'));
process.env.NIMBUS_DATA=data;process.env.NIMBUS_CONFIG=path.join(data,'fixture-config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({local:{enabled:true,managed:{enabled:false}},cloud:{enabled:false},routing:{maxAttempts:1},workers:{maxConcurrent:1,maxSteps:8}}));
let behavior,seen=[],effects=0,network=0;
globalThis.fetch=async()=>{network++;throw Error('network forbidden in independent fixture')};
const digest=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inventory=Object.fromEntries(['runner.js','runtime/journal.js','runtime/tools.js'].map(p=>[p,digest(path.join(candidate,p))]));
function verify(){ for(const [p,h] of Object.entries(inventory)) assert.equal(digest(path.join(candidate,p)),h,p); }
verify();
mock.module(url('runtime/router.js'),{namedExports:{chooseRoute:async()=>({tier:'local',reason:'independent isolated provider',effort:'low'}),cloudFallbackTier:()=>null}});
mock.module(url('runtime/local.js'),{namedExports:{localChat:async(m,o)=>{seen.push(structuredClone(m));return behavior(m,o)}}});
const {q,db}=await import(url('db.js'));
const actualTools=await import(url('runtime/tools.js'));
mock.module(url('runtime/tools.js'),{namedExports:{...actualTools,buildTools:async()=>({tools:[{type:'function',function:{name:'fixture_effect',parameters:{type:'object',properties:{}}}}],bindings:new Map(),errors:[]}),executeTool:async()=>{effects++;return {retained:'independent-completed-effect',sequence:effects}}}});
const runner=await import(url('runner.js'));
const {journalTool,UncertainAction}=await import(url('runtime/journal.js'));
const bot=Number(q('INSERT INTO bots(name,tools) VALUES(?,?)').run('Independent quiet QA','["fixture_effect"]').lastInsertRowid);
const response=content=>({message:{content},usage:{prompt_tokens:3,completion_tokens:4},model:'independent-fixture'});
const call=id=>({id,type:'function',function:{name:'fixture_effect',arguments:'{}'}});
const toolResponse=id=>({...response(''),message:{content:'',tool_calls:[call(id)]}});
const terminal=id=>q("SELECT kind,body FROM messages WHERE run_id=? AND kind IN ('text','quiet') ORDER BY id DESC LIMIT 1").get(id);
async function settle(id){for(let i=0;i<800;i++){const r=q('SELECT * FROM runs WHERE id=?').get(id);if(['done','paused','error','stopped','needs_review'].includes(r.status)&&runner.runtimeQueues().workers.active===0)return r;await new Promise(r=>setTimeout(r,10))}throw Error('fixture timeout')}
async function run(prompt,quiet=true,source='schedule'){const id=runner.runBot({botId:bot,thread:'bot:'+bot,prompt,quiet,source});return {id,row:await settle(id)}}
const preambles=m=>m.filter(x=>x.content?.startsWith('Delivery context:')).length;
const samples=['  ALL_CLEAR: café Ω 🧭\n\t第二行\r\n trailing  ','\t  status without marker 🛰️\nend\n','ALL_CLEAR\n\n— independent verbatim\t'];
for(let n=0;n<samples.length;n++) test('independent exact quiet vs visible payload variant '+n,async()=>{
 const payload=samples[n],prompt='\tTask '+n+'\nReturn these bytes:\n'+payload+'\n ';
 behavior=async()=>response(payload);
 const a=await run(prompt);assert.equal(a.row.status,'done');assert.equal(seen.at(-1).at(-1).content,prompt);assert.equal(preambles(seen.at(-1)),1);
 assert.deepEqual({...terminal(a.id)},{kind:'quiet',body:payload});assert.equal(runner.taskResult(a.id).reply,payload);
 const b=await run(prompt,false);assert.equal(b.row.status,'done');assert.equal(preambles(seen.at(-1)),0);assert.equal(seen.at(-1).at(-1).content,prompt);
 assert.deepEqual({...terminal(b.id)},{kind:'text',body:payload});assert.equal(runner.taskResult(b.id).reply,payload);assert.equal(network,0);assert.equal(effects,0);
});
test('legacy user quiet ALL_CLEAR stripping and nonmarker visibility unchanged',async()=>{
 behavior=async()=>response(' \tALL_CLEAR —  legacy Ω\n tail ');
 const a=await run('independent legacy marker',true,'user');assert.equal(a.row.status,'done');assert.deepEqual({...terminal(a.id)},{kind:'quiet',body:'legacy Ω\n tail '});assert.match(seen.at(-1).at(-1).content,/Reply ALL_CLEAR/);
 behavior=async()=>response('legacy nonmarker Ω\n');
 const b=await run('independent legacy ordinary',true,'user');assert.equal(b.row.status,'done');assert.equal(terminal(b.id).kind,'text');assert.equal(terminal(b.id).body,'legacy nonmarker Ω\n');
 assert.equal(preambles(seen.at(-1)),0);
});
test('two provider failures resume same exact checkpoint without duplicated preamble',async()=>{
 const prompt='  Resume Ω\n\tunchanged payload  ';
 behavior=async()=>{throw Error('independent provider refused fixture')};
 const a=await run(prompt);assert.notEqual(a.row.status,'done');assert.equal(terminal(a.id),undefined);
 const saved=JSON.parse(a.row.checkpoint).messages;
 runner.resumeRun(a.id);const again=await settle(a.id);assert.notEqual(again.status,'done');assert.deepEqual(JSON.parse(again.checkpoint).messages,saved);assert.deepEqual(seen.at(-1).slice(1),saved);
 behavior=async()=>response(samples[0]);runner.resumeRun(a.id);assert.equal((await settle(a.id)).status,'done');
 assert.deepEqual(seen.at(-1).slice(1),saved);assert.equal(preambles(seen.at(-1)),1);assert.equal(terminal(a.id).body,samples[0]);
 assert.equal(q("SELECT count(*) n FROM messages WHERE run_id=? AND kind='quiet'").get(a.id).n,1);
 assert.equal(effects,0);
});
test('cancelled late provider response cannot overwrite result or resume stopped task',async()=>{
 behavior=async()=>{const id=q("SELECT id FROM runs WHERE status='waiting_local' ORDER BY id DESC LIMIT 1").get().id;runner.stopRun(id);await new Promise(r=>setTimeout(r,15));return response('ALL_CLEAR forbidden late result')};
 const a=await run('cancel independent late response\n Ω');assert.equal(a.row.status,'stopped');assert.equal(terminal(a.id),undefined);
 const checkpoint=a.row.checkpoint;assert.throws(()=>runner.resumeRun(a.id),/cannot be resumed/);assert.equal(q('SELECT checkpoint FROM runs WHERE id=?').get(a.id).checkpoint,checkpoint);assert.equal(network,0);
});
test('actual completed tool journal receipt is recovered without executing it twice',async()=>{
 let phase=0;
 behavior=async()=>{if(phase++===0)return toolResponse('independent-done-1912');throw Object.assign(Error('pause after real fixture effect'),{pause:true})};
 const a=await run('preserve completed receipt Ω');assert.notEqual(a.row.status,'done');assert.equal(effects,1);
 const receipt=q('SELECT * FROM tool_calls WHERE run_id=?').get(a.id);assert.equal(receipt.state,'done');
 // Simulate retained checkpoint stopping before delivery of a completed result.
 const state=JSON.parse(a.row.checkpoint);state.messages=state.messages.filter(m=>m.role!=='tool');q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify(state),a.id);
 behavior=async(m)=>{const t=m.filter(x=>x.tool_call_id==='independent-done-1912');assert.equal(t.length,1);assert.deepEqual(JSON.parse(t[0].content),JSON.parse(receipt.result));return response('ALL_CLEAR: recovered Ω\n ')};
 runner.resumeRun(a.id);assert.equal((await settle(a.id)).status,'done');assert.equal(effects,1);assert.equal(preambles(seen.at(-1)),1);assert.equal(q('SELECT result FROM tool_calls WHERE id=?').get(receipt.id).result,receipt.result);
 assert.equal(terminal(a.id).body,'ALL_CLEAR: recovered Ω\n ');
});
test('uncertain actual tool journal blocks resume preserving checkpoint and receipt bytes',async()=>{
 behavior=async()=>{const id=q("SELECT id FROM runs WHERE status='waiting_local' ORDER BY id DESC LIMIT 1").get().id;
 await journalTool({id:'uncertain-fixture-1912',runId:id,name:'fixture_uncertain',args:{test:1912},execute:async()=>{throw new UncertainAction('independent uncertain fixture outcome')}});return response('must not publish')};
 const a=await run('hold unknown outcome Ω');assert.equal(a.row.status,'needs_review');assert.equal(terminal(a.id),undefined);
 const receipt=q('SELECT * FROM tool_calls WHERE run_id=?').get(a.id);assert.equal(receipt.state,'uncertain');
 const calls=seen.length;assert.throws(()=>runner.resumeRun(a.id),/uncertain action/);assert.equal(seen.length,calls);assert.equal(q('SELECT checkpoint FROM runs WHERE id=?').get(a.id).checkpoint,a.row.checkpoint);assert.deepEqual(q('SELECT * FROM tool_calls WHERE id=?').get(receipt.id),receipt);assert.equal(effects,1);assert.equal(network,0);
});
after(async()=>{await runner.drainRuntime();db.close();mock.restoreAll();verify();fs.writeFileSync(path.join(data,'isolation.json'),JSON.stringify({effects,network,schedulerOperations:0,candidateInventoryVerifiedBeforeAndAfter:true}));});
