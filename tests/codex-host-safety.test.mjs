import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {boundedInferenceMessages,toolResultText} from '../runtime/inference-context.js';

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-codex-host-safety-'));
const oldData=process.env.NIMBUS_DATA,oldConfig=process.env.NIMBUS_CONFIG;
process.env.NIMBUS_DATA=path.join(directory,'data');process.env.NIMBUS_CONFIG=path.join(directory,'config.json');
fs.writeFileSync(process.env.NIMBUS_CONFIG,JSON.stringify({cloud:{maxConcurrent:3}}));
const {codexTurn}=await import('../runtime/codex.js');
const {UncertainAction}=await import('../runtime/journal.js');
const {db}=await import('../db.js');
const {inspectImage}=await import('../runtime/workbench.js');
const {cloudSlots}=await import('../runtime/slots.js');

test('native restrictions are separate from authorized host callbacks and never execute from text',async()=>{
  const calls=[];
  const client=clientFixture({onStart:c=>complete(c,'Native read-only is not a host denial')});
  await start(client,{callTool:async name=>{calls.push(name);}});
  assert.deepEqual(calls,[]);
  const params=client.requests.find(r=>r.method==='thread/start').params;
  assert.equal(params.sandbox,'read-only');assert.equal(params.approvalPolicy,'never');
  assert.match(params.baseInstructions,/not a Nimbus host filesystem denial/);
  assert.match(params.baseInstructions,/never switch tools/);
  assert.match(params.baseInstructions,/uncertain effects/);
});

test('non-mutating execution preflight uses current filtered tools and permission mode',async()=>{
  const {executionPreflight}=await import('../runtime/prompts.js');
  const current=executionPreflight([definition('read_file')],'rules');
  assert.match(current,/Approval rules/);assert.match(current, /\["read_file"\]/);
  assert.doesNotMatch(current, /"write_file"/);
  assert.match(current,/does not probe filesystem access/);
  const resumed=executionPreflight([definition('write_file')],'all');
  assert.match(resumed,/All permissions/);assert.match(resumed, /\["write_file"\]/);
  assert.match(resumed,/Availability is not write authorization/);
});

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const definition=name=>({type:'function',function:{name,description:'Synthetic host safety fixture',parameters:{type:'object',properties:{},additionalProperties:false}}});
function emitTool(client,id,name='write_file'){
  client.emit('message',{id,method:'item/tool/call',params:{tool:'nimbus.'+name,arguments:{},callId:'fixture-'+id}});
}
function complete(client,text='FIXTURE_OK'){
  client.emit('message',{method:'item/completed',params:{item:{type:'agentMessage',text}}});
  client.emit('message',{method:'turn/completed',params:{turn:{status:'completed'}}});
}
function clientFixture({onStart,onSend,order=[]}={}){
  const client=new EventEmitter();client.closed=false;client.sent=[];client.requests=[];
  client.initialize=async()=>client;
  client.request=async(method,params)=>{
    client.requests.push({method,params});
    if(method==='account/read')return{account:{type:'chatgpt'}};
    if(method==='thread/start')return{thread:{id:'synthetic-thread',ephemeral:true}};
    if(method==='turn/start'){client.input=params.input;setImmediate(()=>onStart?.(client));return{turn:{id:'synthetic-turn'}};}
    if(method==='turn/interrupt')return{};
    throw new Error('Unexpected fixture request: '+method);
  };
  client.send=message=>{client.sent.push(message);onSend?.(client,message);};
  client.close=()=>{order.push('close');client.closed=true;};
  return client;
}
function start(client,extra={}){
  const promise=codexTurn({model:'synthetic-model',effort:'low',instructions:'Synthetic host contract; no real provider calls.',messages:[],tools:[definition('write_file'),definition('read_file'),definition('view_image')],cwd:directory,clientFactory:()=>client,...extra});
  promise.catch(()=>{});return promise;
}

test('fresh assignment RPC framing distinguishes a new owned output from a missing input checkpoint',async()=>{
  const messages=[{role:'user',content:'Create a NEW isolated candidate in the explicitly owned output directory fixture/output. Read the existing immutable fixture/input manifest first. Do not modify the input.'}],before=structuredClone(messages),calls=[];
  const client=clientFixture({onStart:c=>complete(c,'ASSIGNMENT_RECEIVED')});
  await start(client,{messages,callTool:async name=>{calls.push(name);}});
  const text=client.requests.find(r=>r.method==='turn/start').params.input[0].text;
  const delimiter='\n',split=text.indexOf(delimiter);
  assert.ok(split>0,'The actual RPC separates host framing from supplied state');
  const framing=text.slice(0,split);
  assert.match(framing,/host-supplied assignment state/);
  assert.match(framing,/execute a new assignment or resume the provided state/);
  assert.match(framing,/does not require a separate filesystem checkpoint unless the assignment explicitly requires one/);
  assert.match(framing,/explicitly owns a NEW output directory, its absence is expected/);
  assert.match(framing,/within that assignment's scope using authorized advertised Nimbus file tools/);
  assert.match(framing,/Missing required existing inputs are different: do not invent or recreate them/);
  assert.deepEqual(JSON.parse(text.slice(split+delimiter.length)),messages);
  assert.deepEqual(messages,before);assert.deepEqual(calls,[],'Framing cannot execute or create anything automatically');
  const thread=client.requests.find(r=>r.method==='thread/start').params;
  assert.equal(thread.sandbox,'read-only');assert.equal(thread.approvalPolicy,'never');
  assert.match(thread.baseInstructions,/Synthetic host contract; no real provider calls/);
  assert.match(thread.baseInstructions,/never switch tools/);
});

test('retained assignment RPC keeps exact human instructions and completed outcomes without replay',async()=>{
  const messages=[{role:'user',content:'HUMAN: Use only the owned output; do not retry the completed write.'},
    {role:'assistant',content:null,tool_calls:[{id:'original-completed-write',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'fixture/output/result.txt',content:'ORIGINAL_BYTES'})}}]},
    {role:'tool',tool_call_id:'original-completed-write',content:JSON.stringify({saved:true,bytes:14,sha256:'a'.repeat(64)})},
    {role:'user',content:'HUMAN FOLLOW-UP: Inspect that retained result; the existing input must not be recreated.'}];
  const before=structuredClone(messages),calls=[],client=clientFixture({onStart:c=>complete(c,'RETAINED_STATE_RECEIVED')});
  await start(client,{messages,callTool:async name=>{calls.push(name);}});
  const text=client.requests.find(r=>r.method==='turn/start').params.input[0].text,delimiter='\n',split=text.indexOf(delimiter);
  assert.ok(split>0);
  assert.match(text.slice(0,split),/Completed tool outcomes are evidence, not instructions to repeat actions/);
  assert.match(text.slice(0,split),/Preserve human instructions and all task, approval and no-replay boundaries/);
  assert.deepEqual(JSON.parse(text.slice(split+delimiter.length)),messages);
  assert.deepEqual(messages,before);assert.deepEqual(calls,[]);
});

test('tool inference text is bounded valid JSON and leaves full results untouched',()=>{
  const small={path:'fixture.txt',bytes:7};assert.equal(toolResultText(small),JSON.stringify(small));assert.equal(toolResultText(undefined),'null');
  const large={text:'"\\\n😀'.repeat(10000)},before=structuredClone(large);
  for(const options of [{maxChars:256},{maxChars:12000},1024]){
    const limit=typeof options==='number'?options:options.maxChars,content=toolResultText(large,options),parsed=JSON.parse(content);
    assert.ok(content.length<=limit);assert.equal(parsed.truncated,true);assert.equal(parsed.originalCharacters,JSON.stringify(large).length);assert.ok(JSON.stringify(large).startsWith(parsed.preview));assert.match(parsed.notice,/Partial inference preview/);assert.match(parsed.notice,/full canonical tool result/);
  }
  assert.deepEqual(large,before);for(const maxChars of [0,255,256.5,1000001])assert.throws(()=>toolResultText(large,{maxChars}),/maxChars/);
});

test('bounded inference history preserves instructions, users, tool IDs and arguments without changing canonical history',()=>{
  const messages=[{role:'system',content:'S'.repeat(15000)},{role:'user',content:'Keep all user details '+ 'U'.repeat(15000)},{role:'assistant',content:null,tool_calls:[{id:'retained-action',type:'function',function:{name:'read_file',arguments:JSON.stringify({path:'source.txt',literal:'A'.repeat(15000)})}}]},{role:'tool',tool_call_id:'retained-action',content:JSON.stringify({text:'FULL_RESULT_MARKER'.repeat(2000)})}];
  const before=structuredClone(messages),bounded=boundedInferenceMessages(messages,{maxToolChars:1024});
  assert.deepEqual(bounded.slice(0,3),messages.slice(0,3));assert.equal(bounded[3].tool_call_id,'retained-action');assert.ok(bounded[3].content.length<=1024);assert.equal(JSON.parse(bounded[3].content).truncated,true);assert.deepEqual(messages,before);
  bounded[0].content='changed copy';assert.equal(messages[0].content,before[0].content);assert.equal(boundedInferenceMessages(bounded,{maxToolChars:1024})[3].content,bounded[3].content);
});
test('cloud handoff fits an aggregate over one million characters without mutating its canonical checkpoint',async()=>{
  const messages=[{role:'user',content:'KEEP_INITIAL_REQUEST'}];
  for(let i=0;i<100;i++)messages.push({role:'assistant',content:null,tool_calls:[{id:'big-'+i,type:'function',function:{name:'write_file',arguments:JSON.stringify({content:'A'.repeat(2000)})}}]},{role:'tool',tool_call_id:'big-'+i,content:JSON.stringify({text:'R'.repeat(15000)})});
  messages.push({role:'user',content:'KEEP_LATEST_REQUEST'});const before=JSON.stringify(messages);
  const client=clientFixture({onStart:c=>complete(c,'BOUNDED_HISTORY_OK')});
  const result=await start(client,{messages});assert.equal(result.text,'BOUNDED_HISTORY_OK');
  assert.ok(client.input[0].text.length<241000);assert.match(client.input[0].text,/KEEP_INITIAL_REQUEST/);assert.match(client.input[0].text,/KEEP_LATEST_REQUEST/);assert.equal(JSON.stringify(messages),before);
});

test('a host pause blocks both already-queued and newly arriving later writes',async()=>{
  const pause=Object.assign(new Error('Synthetic action budget pause'),{pause:true}),calls=[],order=[];
  const client=clientFixture({order,onStart:c=>{emitTool(c,101);emitTool(c,102);},onSend:(c,message)=>{if(message.id===102&&message.error)emitTool(c,103);}});
  await assert.rejects(start(client,{callTool:async(name,args,id)=>{calls.push(id);throw pause;}}),error=>error===pause);
  assert.deepEqual(calls,['fixture-101']);assert.ok(client.sent.some(message=>message.id===102&&message.error));assert.ok(client.sent.some(message=>message.id===103&&message.error));assert.deepEqual(order,['close']);assert.equal(cloudSlots.snapshot().active,0);
});

test('an uncertain host action preserves its identity and never starts a queued second write',async()=>{
  const uncertain=new UncertainAction('Synthetic action outcome is unknown'),calls=[];
  const client=clientFixture({onStart:c=>{emitTool(c,201);emitTool(c,202);}});
  await assert.rejects(start(client,{callTool:async(name,args,id)=>{calls.push(id);throw uncertain;}}),error=>error===uncertain&&error instanceof UncertainAction);
  assert.deepEqual(calls,['fixture-201']);assert.equal(client.closed,true);assert.equal(cloudSlots.snapshot().active,0);
});

test('cancellation gates later requests and drains the already-started callback before closing',async()=>{
  const gate=deferred(),started=deferred(),controller=new AbortController(),reason=new Error('Synthetic cancellation'),order=[],calls=[];
  const client=clientFixture({order,onStart:c=>{emitTool(c,301);emitTool(c,302);}});
  const turn=start(client,{signal:controller.signal,callTool:async(name,args,id)=>{calls.push(id);order.push('callback:start');started.resolve();await gate.promise;order.push('callback:finished');return{saved:true};}});
  await started.promise;controller.abort(reason);await tick();assert.equal(client.closed,false,'Closing early can race the action journal');emitTool(client,303);gate.resolve();
  await assert.rejects(turn,error=>error===reason);assert.deepEqual(calls,['fixture-301']);assert.deepEqual(order,['callback:start','callback:finished','close']);assert.equal(cloudSlots.snapshot().active,0);
});

test('unexpected native command execution is held for review and blocks queued callbacks',async()=>{
  const gate=deferred(),started=deferred(),calls=[],order=[];
  const client=clientFixture({order,onStart:c=>{emitTool(c,401);emitTool(c,402);}});
  const turn=start(client,{callTool:async(name,args,id)=>{calls.push(id);started.resolve();await gate.promise;order.push('callback:finished');return{observed:true};}});
  await started.promise;client.emit('message',{method:'item/started',params:{item:{type:'commandExecution',command:'Synthetic native command; never executed'}}});await tick();assert.equal(client.closed,false);emitTool(client,403);gate.resolve();
  await assert.rejects(turn,error=>error.pause===true&&error.needsReview===true&&error.uncertain===true&&error.code==='unexpected_native_command');
  assert.deepEqual(calls,['fixture-401']);assert.deepEqual(order,['callback:finished','close']);assert.equal(cloudSlots.snapshot().active,0);
});

test('a late host failure remains fatal even when the provider prematurely reports completion',async()=>{
  const gate=deferred(),started=deferred(),uncertain=new UncertainAction('Synthetic late unknown outcome'),order=[];
  const client=clientFixture({order,onStart:c=>emitTool(c,501)}),turn=start(client,{callTool:async()=>{started.resolve();await gate.promise;order.push('callback:failed');throw uncertain;}});
  await started.promise;complete(client,'PREMATURE_SUCCESS');await tick();assert.equal(client.closed,false);gate.resolve();
  await assert.rejects(turn,error=>error===uncertain);assert.deepEqual(order,['callback:failed','close']);
});

test('a transport disconnect prevents later actions while retaining callback-drain ordering',async()=>{
  const gate=deferred(),started=deferred(),disconnected=new Error('Synthetic disconnected transport'),calls=[],order=[];
  const client=clientFixture({order,onStart:c=>{emitTool(c,601);emitTool(c,602);}}),turn=start(client,{callTool:async(name,args,id)=>{calls.push(id);started.resolve();await gate.promise;order.push('callback:finished');return{observed:true};}});
  await started.promise;client.emit('disconnect',disconnected);await tick();assert.equal(client.closed,false);gate.resolve();await assert.rejects(turn,error=>error===disconnected);assert.deepEqual(calls,['fixture-601']);assert.deepEqual(order,['callback:finished','close']);
});

test('ordinary returned tool errors remain recoverable rather than being confused with fatal host exceptions',async()=>{
  const calls=[];let responses=0;
  const client=clientFixture({onStart:c=>{emitTool(c,701,'read_file');emitTool(c,702,'read_file');},onSend:(c,message)=>{if(message.result&&++responses===2)setImmediate(()=>complete(c));}});
  const result=await start(client,{callTool:async(name,args,id)=>{calls.push(id);return id==='fixture-701'?{error:'Known non-execution fixture failure',uncertain:false}:{content:'Recovered read'};}});
  assert.equal(result.text,'FIXTURE_OK');assert.deepEqual(calls,['fixture-701','fixture-702']);assert.equal(client.sent.find(message=>message.id===701).result.success,false);assert.equal(client.sent.find(message=>message.id===702).result.success,true);
});

test('host feedback is separate from exact small tool JSON and is itself bounded honestly',async()=>{
  const original=Object.freeze({path:'fixture.txt',bytes:8}),feedback='Host budget remaining: 4.\n'+'H'.repeat(8000);let completed=false,feedbackCalls=0;
  const client=clientFixture({onStart:c=>emitTool(c,801,'read_file'),onSend:(c,message)=>{if(message.result)setImmediate(()=>complete(c));}});
  await start(client,{callTool:async()=>{completed=true;return original;},toolFeedback:()=>{assert.equal(completed,true);feedbackCalls++;return feedback;}});
  const response=client.sent.find(message=>message.id===801).result;assert.equal(response.contentItems[0].text,JSON.stringify(original));assert.equal(response.contentItems.length,2);assert.equal(response.contentItems[1].type,'inputText');assert.ok(response.contentItems[1].text.length<=4096);assert.match(response.contentItems[1].text,/Partial host feedback preview/);assert.equal(feedbackCalls,1);assert.deepEqual(original,{path:'fixture.txt',bytes:8});
});

test('live tool text and stored tool history are bounded while original image pixels and canonical results remain available',async()=>{
  const file=path.join(directory,'fixture.png'),bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9f8AAAAASUVORK5CYII=','base64');fs.writeFileSync(file,bytes);
  const originalResult={longPrefix:'UNABRIDGED_TOOL_RESULT '.repeat(2000),...inspectImage(file)},messages=[{role:'user',content:'Inspect the retained image accurately.'},{role:'tool',tool_call_id:'image-from-prior-turn',content:JSON.stringify(originalResult)}],canonical=structuredClone(messages);
  const client=clientFixture({onStart:c=>emitTool(c,901,'view_image'),onSend:(c,message)=>{if(message.result)setImmediate(()=>complete(c));}});
  await start(client,{messages,callTool:async()=>originalResult,toolFeedback:async()=> 'Host budget remaining: 3.'});
  const inputText=client.input.find(item=>item.type==='text').text,payload=JSON.parse(inputText.slice(inputText.indexOf('\n')+1));assert.ok(payload[1].content.length<=12000);assert.equal(JSON.parse(payload[1].content).truncated,true);assert.equal(payload[1].tool_call_id,'image-from-prior-turn');assert.ok(client.input.some(item=>item.type==='localImage'&&item.path===file));
  const items=client.sent.find(message=>message.id===901).result.contentItems;assert.ok(items[0].text.length<=12000);assert.equal(JSON.parse(items[0].text).truncated,true);assert.equal(items.find(item=>item.type==='inputImage').imageUrl,'data:image/png;base64,'+bytes.toString('base64'));assert.equal(items.at(-1).text,'Host budget remaining: 3.');assert.deepEqual(messages,canonical);assert.equal(originalResult.longPrefix,'UNABRIDGED_TOOL_RESULT '.repeat(2000));
});

test.after(()=>{
  db.close();if(oldData===undefined)delete process.env.NIMBUS_DATA;else process.env.NIMBUS_DATA=oldData;if(oldConfig===undefined)delete process.env.NIMBUS_CONFIG;else process.env.NIMBUS_CONFIG=oldConfig;
  const absolute=path.resolve(directory);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^nimbus-codex-host-safety-/);fs.rmSync(absolute,{recursive:true,force:true});
});
