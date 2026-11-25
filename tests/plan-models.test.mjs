import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-plan-'));
process.env.NIMBUS_CONFIG=path.join(dir,'config.json');
process.env.NIMBUS_DATA=path.join(dir,'data');
const {config}=await import('../runtime/config.js');
const {chooseRoute,cloudFallbackTier}=await import('../runtime/router.js');
const {claudePlanTiers,openaiCatalogTiers}=await import('../runtime/plan-models.js');
const {runLocalSlash}=await import('../runtime/slash.js');

// A ChatGPT account whose live Codex catalog has no Sol model.
const catalog={models:[{model:'gpt-6.2-luna'},{model:'gpt-6.2-terra'},{model:'gpt-6.2-astra'}]};

test('Claude plans: Pro never includes Fable, Max does, unknown plans get the Pro set, config can override',()=>{
  const c=config();
  assert.deepEqual(claudePlanTiers('pro',c),['claude-haiku','claude-sonnet','claude-opus']);
  assert.ok(claudePlanTiers('max',c).includes('claude-fable'));
  assert.ok(claudePlanTiers('Max 20x',c).includes('claude-fable'));
  assert.ok(!claudePlanTiers('',c).includes('claude-fable'),'unknown plan is treated as Pro');
  assert.deepEqual(claudePlanTiers('pro',{claude:{planTiers:['claude-sonnet'],disabledTiers:[]}}),['claude-sonnet']);
  assert.deepEqual(claudePlanTiers('max',{claude:{disabledTiers:['claude-fable']}}),['claude-haiku','claude-sonnet','claude-opus']);
});

test('OpenAI tiers come from the live catalog; a missing tier is not offered',()=>{
  const c=config();
  assert.deepEqual(openaiCatalogTiers(catalog,c),['luna','terra','astra']);
  assert.deepEqual(openaiCatalogTiers({models:[]},c),[]);
});

test('routing never chooses a model the connected plans exclude',async()=>{
  const c=config();c.local.enabled=false;
  const openai=new Set(openaiCatalogTiers(catalog,c)),claude=new Set(claudePlanTiers('pro',c));
  const tierAvailable=t=>t.startsWith('claude-')?claude.has(t):openai.has(t);
  // Both subscriptions: the ranking for a Builder drops Sol and Fable.
  const both=await chooseRoute({task:'fix',role:'builder Builder Implements software changes',preferredTier:'sol',cloudAvailable:true,claudeAvailable:true,tierAvailable,c});
  assert.equal(both.tier,'claude-opus');assert.ok(!both.candidates.includes('sol'));assert.ok(!both.candidates.includes('claude-fable'));
  // Architect prefers Fable; on Pro it gets the next same-class model.
  const arch=await chooseRoute({task:'design',role:'architect Architect',preferredTier:'astra',cloudAvailable:true,claudeAvailable:true,tierAvailable,c});
  assert.notEqual(arch.tier,'claude-fable');assert.ok(!arch.candidates.includes('claude-fable'));
  // OpenAI only: the role preference Sol is not in the catalog.
  const openaiOnly=await chooseRoute({task:'fix',role:'builder',preferredTier:'sol',cloudAvailable:true,claudeAvailable:false,tierAvailable,c});
  assert.notEqual(openaiOnly.tier,'sol');assert.ok(openai.has(openaiOnly.tier));
  // A pinned model outside the plan falls back with a recorded reason.
  const pinned=await chooseRoute({task:'x',role:'builder',pinned:'sol',cloudAvailable:true,claudeAvailable:false,tierAvailable,c});
  assert.notEqual(pinned.tier,'sol');assert.match(pinned.reason,/not available on the connected plan/);
  const pinnedFable=await chooseRoute({task:'x',role:'builder',pinned:'claude-fable',cloudAvailable:true,claudeAvailable:true,tierAvailable,c});
  assert.notEqual(pinnedFable.tier,'claude-fable');assert.match(pinnedFable.reason,/not available on the connected plans/);
  // Local router path: a classifier that picks Sol is corrected.
  c.local.enabled=true;
  const classified=await chooseRoute({task:'x',role:'builder',preferredTier:'sol',cloudAvailable:true,claudeAvailable:false,tierAvailable,c,
    classify:async()=>({model:'router',message:{content:JSON.stringify({tier:'sol',effort:'high',reason:'complex',fallbackTier:'sol'})}})});
  assert.ok(openai.has(classified.tier));assert.ok(classified.fallbackTier==='local'||openai.has(classified.fallbackTier));
});

test('cloudFallbackTier picks the nearest available class, cheaper on ties, and pauses when nothing is available',()=>{
  const c=config();
  assert.equal(cloudFallbackTier('sol',c,t=>t!=='sol'),'terra');
  assert.equal(cloudFallbackTier('sol',c,t=>t==='astra'),'astra');
  assert.equal(cloudFallbackTier('sol',c),'sol','no availability filter keeps the old behavior');
  assert.throws(()=>cloudFallbackTier('sol',c,()=>false),e=>e.pause===true);
});

test('/model refuses a tier the plan excludes and /providers lists what is excluded',async()=>{
  const updates=[];const query=sql=>({run:(...args)=>updates.push([sql,args]),get:()=>null,all:()=>[]});
  const bot={id:1,name:'Builder',role:'Implements software changes',template:'builder',model:'auto',default_model:'sol',effort:'medium'};
  const providerStatus=async()=>({openai:{ok:true,tiers:['luna','terra','astra']},claude:{ok:true,enabled:true,allowedTiers:['claude-haiku','claude-sonnet','claude-opus']}});
  const ctx={query,bot,thread:'bot:1',dataDir:dir,settings:{maxHistoryChars:1000},stopRun:()=>{},providerStatus};
  await assert.rejects(runLocalSlash('/model claude-fable',ctx),e=>e.statusCode===400&&/not included in the connected plans/.test(e.message));
  await assert.rejects(runLocalSlash('/model sol',ctx),e=>e.statusCode===400);
  assert.equal(updates.length,0);
  assert.match(await runLocalSlash('/model claude-opus',ctx),/Claude subscription/);
  const providers=await runLocalSlash('/providers',ctx);
  assert.match(providers,/Not in your plans or not connected: .*sol/);assert.match(providers,/claude-fable/);
});
