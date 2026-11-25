import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-claude-'));
process.env.NIMBUS_CONFIG=path.join(dir,'config.json');
process.env.NIMBUS_DATA=path.join(dir,'data');
const FAKE=path.join(path.dirname(fileURLToPath(import.meta.url)),'helpers','fake-claude.mjs');
const {config}=await import('../runtime/config.js');
const {chooseRoute}=await import('../runtime/router.js');
const {rankCandidates,roleCategory,backendOf,providerOf}=await import('../runtime/provider-catalog.js');
const {claudeTurn,claudeEnv,CLAUDE_TOKEN_RE,resolveClaudeModel,claudeModelAvailable}=await import('../runtime/claude.js');
const tools=[{type:'function',function:{name:'echo_tool',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']}}}];
const fakeSpawn=(mode='tool')=>(cmd,args,opts)=>spawn(process.execPath,['--no-warnings',FAKE,...args],{...opts,env:{...opts.env,FAKE_CLAUDE_MODE:mode},windowsHide:true});

test('role categories and evidence ranking choose across providers and keep the role capability class',()=>{
  assert.equal(roleCategory('Implements software changes and verifies working behavior'),'engineering');
  assert.equal(roleCategory('architect Architect Designs systems, interfaces and migration decisions'),'architecture');
  assert.equal(roleCategory('browser-operator — Browser Operator — Executes bounded web workflows with saved-result verification'),'operations');
  const all=rankCandidates({role:'Builder',preferredTier:'sol'});
  assert.equal(all.candidates[0],'claude-opus');assert.equal(all.candidates[1],'sol');
  assert.equal(rankCandidates({role:'Browser Operator',preferredTier:'terra'}).candidates[0],'terra');
  assert.equal(rankCandidates({role:'Office assistant',preferredTier:'luna'}).candidates[0],'luna');
  assert.equal(rankCandidates({role:'Architect',preferredTier:'astra'}).candidates[0],'claude-fable');
  const noClaude=rankCandidates({role:'Builder',preferredTier:'sol',available:t=>!t.startsWith('claude')});
  assert.ok(noClaude.candidates.every(t=>!t.startsWith('claude')));assert.equal(noClaude.candidates[0],'sol');
  const configured=rankCandidates({role:'Builder',preferredTier:'sol',c:{routing:{providerRanking:{engineering:['sol','claude-sonnet']}}}});
  assert.deepEqual(configured.candidates,['sol','claude-sonnet']);assert.equal(configured.basis,'configured');
  assert.equal(backendOf('claude-opus'),'claude');assert.equal(providerOf('claude-opus'),'anthropic');assert.equal(backendOf('sol'),'codex');
});

test('router uses the ranking only when Claude is available and falls back to the next best',async()=>{
  const c=config();c.local.enabled=false;
  const both=await chooseRoute({task:'fix bug',role:'Builder',preferredTier:'sol',cloudAvailable:true,claudeAvailable:true,c});
  assert.equal(both.tier,'claude-opus');assert.equal(both.fallbackTier,'sol');assert.equal(both.candidates[1],'sol');
  const openaiOnly=await chooseRoute({task:'fix bug',role:'Builder',preferredTier:'sol',cloudAvailable:true,claudeAvailable:false,c});
  assert.equal(openaiOnly.tier,'sol');assert.equal(openaiOnly.candidates,undefined);
  const claudeOnly=await chooseRoute({task:'fix bug',role:'Builder',preferredTier:'sol',cloudAvailable:false,claudeAvailable:true,c});
  assert.equal(claudeOnly.tier,'claude-opus');assert.ok(claudeOnly.candidates.every(t=>t.startsWith('claude')));
  const pinned=await chooseRoute({task:'x',role:'Builder',pinned:'claude-sonnet',cloudAvailable:true,claudeAvailable:true,c});
  assert.equal(pinned.tier,'claude-sonnet');assert.equal(pinned.router,'explicit');
  c.local.enabled=true;
  const classified=await chooseRoute({task:'x',role:'Builder',preferredTier:'sol',cloudAvailable:true,claudeAvailable:true,c,
    classify:async messages=>{assert.match(messages[1].content,/rankedCandidates/);return{model:'router',message:{content:JSON.stringify({tier:'claude-opus',effort:'high',reason:'complex',fallbackTier:'astra'})}};}});
  assert.equal(classified.tier,'claude-opus');assert.equal(classified.fallbackTier,'astra');
  const invented=await chooseRoute({task:'x',role:'Builder',preferredTier:'sol',cloudAvailable:false,claudeAvailable:true,c,
    classify:async()=>({model:'router',message:{content:JSON.stringify({tier:'sol',effort:'high',reason:'r',fallbackTier:'sol'})}})});
  assert.equal(invented.tier,'claude-opus','a tier that is not available is replaced by the best ranked one');
  const noFable=await chooseRoute({task:'x',role:'architect',preferredTier:'astra',cloudAvailable:true,claudeAvailable:true,tierAvailable:t=>t!=='claude-fable',c,classify:async()=>{throw new Error('offline');}});
  assert.equal(noFable.tier,'astra','next same-class model after Fable');assert.equal(noFable.candidates[1],'claude-opus');assert.ok(!noFable.candidates.includes('claude-fable'));
  const down=await chooseRoute({task:'x',role:'Builder',preferredTier:'sol',cloudAvailable:true,claudeAvailable:true,c,classify:async()=>{throw new Error('offline');}});
  assert.equal(down.tier,'claude-opus');assert.match(down.fallbackReason,/offline/);
});

test('Claude turn runs Nimbus tools through the MCP bridge with built-in tools off and a clean subscription environment',async()=>{
  process.env.ANTHROPIC_API_KEY='sk-should-not-leak';process.env.CLAUDE_CODE_SIMPLE='1';
  const calls=[];
  const r=await claudeTurn({model:'claude-opus-5-5',effort:'high',instructions:'Test worker',messages:[{role:'user',content:'Say hello'}],tools,
    callTool:async(name,args,callId)=>{calls.push({name,args,callId});return {echo:args.text};},cwd:dir,spawnProcess:fakeSpawn()});
  assert.equal(calls.length,1);assert.equal(calls[0].name,'echo_tool');assert.deepEqual(calls[0].args,{text:'ping'});
  assert.match(r.text,/echoed \{"echo":"ping"\} tools=echo_tool promptHasTask=true/);
  assert.equal(r.model,'claude-opus-5-5');assert.equal(r.threadId,'fake-session');
  assert.deepEqual(r.usage,{inputTokens:12,outputTokens:5,costUsd:undefined});assert.deepEqual(r.unconsumedToolResults,[]);
  const env=await claudeEnv();
  assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(env.CLAUDE_CODE_SIMPLE,undefined);
  delete process.env.ANTHROPIC_API_KEY;delete process.env.CLAUDE_CODE_SIMPLE;
});

test('Claude turn refuses API-key billing, maps usage limits, and honours cancellation',async()=>{
  const base={model:'claude-sonnet-5-5',effort:'low',instructions:'t',messages:[{role:'user',content:'Say hello'}],tools,callTool:async()=>({}),cwd:dir};
  await assert.rejects(claudeTurn({...base,spawnProcess:fakeSpawn('apikey')}),/subscription login only/);
  await assert.rejects(claudeTurn({...base,spawnProcess:fakeSpawn('limit')}),e=>e.code==='claude_limit');
  await assert.rejects(claudeTurn({...base,model:'claude-fable-5-2',spawnProcess:fakeSpawn('nomodel')}),e=>e.code==='claude_model_unavailable');
  assert.equal(claudeModelAvailable('claude-fable-5-2'),false,'a refused model is skipped');assert.equal(claudeModelAvailable('claude-sonnet-5-5'),true,'other Claude models stay usable');
  const abort=new AbortController();abort.abort(new Error('User stopped'));
  await assert.rejects(claudeTurn({...base,signal:abort.signal,spawnProcess:fakeSpawn()}),/User stopped/);
});

test('Claude token format and model resolution',()=>{
  assert.ok(CLAUDE_TOKEN_RE.test('sk-ant-oat01-'+'a'.repeat(40)));assert.ok(!CLAUDE_TOKEN_RE.test('sk-ant-api03-'+'a'.repeat(40)));
  assert.equal(resolveClaudeModel('claude-opus'),'claude-opus-5-5');
  const c=config();c.claude.models['claude-opus']='claude-opus-5';assert.equal(resolveClaudeModel('claude-opus',c),'claude-opus-5');
});
