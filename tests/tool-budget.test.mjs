import test from 'node:test';
import assert from 'node:assert/strict';
import { chargeToolAttempt, toolBudgetFeedback } from '../runtime/tool-budget.js';

const options = { maxSteps: 32 };
function exhausted(fn) {
  let error;
  try { fn(); } catch (caught) { error = caught; }
  assert.ok(error, 'The held tool request must throw');
  assert.equal(error.pause, true);
  assert.equal(error.code, 'tool_budget_exhausted');
  assert.equal(error.budget.notExecuted, true);
  return error;
}

test('action admission executes exactly the configured count and holds the next request before execution', () => {
  const state = {}, effects = [];
  const request = () => { chargeToolAttempt(state, 'read_file', options); effects.push('executed'); };
  for (let i = 0; i < 32; i++) request();
  assert.equal(effects.length, 32);
  assert.deepEqual([state.steps, state.toolAttempts, state.totalActionSteps, state.totalToolAttempts], [32, 32, 32, 32]);
  const error = exhausted(request);
  assert.equal(effects.length, 32);
  assert.deepEqual(error.budget, { actionLimit:32, attemptLimit:128, actionsUsed:32, actionRemaining:0, attemptsUsed:33, attemptRemaining:95, attemptedTool:'read_file', notExecuted:true });
  assert.deepEqual([state.steps, state.toolAttempts, state.totalActionSteps, state.totalToolAttempts], [32, 33, 32, 33]);
});

test('collection/status polling preserves action slots while every poll consumes an attempt', () => {
  const state = { steps: 32, toolAttempts: 32, totalActionSteps: 100, totalToolAttempts: 200 };
  for (let i = 0; i < 48; i++) {
    chargeToolAttempt(state, 'worker_result', options);
    chargeToolAttempt(state, 'tool_request_status', options);
  }
  assert.deepEqual([state.steps,state.toolAttempts,state.totalActionSteps,state.totalToolAttempts], [32,128,100,296]);
  const error = exhausted(() => chargeToolAttempt(state, 'worker_result', options));
  assert.equal(error.budget.attemptsUsed, 129);
  assert.equal(error.budget.attemptRemaining, 0);
  assert.equal(error.budget.actionRemaining, 0);
  assert.deepEqual([state.steps,state.totalActionSteps,state.totalToolAttempts], [32,100,297]);
});

test('an attempt cap holds an action without consuming an available action slot', () => {
  const state = { steps:3, toolAttempts:128, totalActionSteps:50, totalToolAttempts:300 };
  const error = exhausted(() => chargeToolAttempt(state, 'ask_worker', options));
  assert.equal(error.budget.actionRemaining, 29);
  assert.equal(error.budget.attemptedTool, 'ask_worker');
  assert.deepEqual([state.steps,state.toolAttempts,state.totalActionSteps,state.totalToolAttempts], [3,129,50,301]);
});

test('disabled names and cache-hit admissions cannot create an unbounded free request loop', () => {
  const state = {}, cache = new Map([['read_file','retained result']]);
  let held;
  for (let i=0;i<200;i++) {
    try {
      const name=i%2?'disabled_tool':'read_file';
      chargeToolAttempt(state,name,options);
      if(name==='disabled_tool') continue;
      assert.equal(cache.get(name),'retained result');
    } catch (error) { held=error; break; }
  }
  assert.equal(held?.code,'tool_budget_exhausted');
  assert.equal(held.budget.attemptsUsed,33);
  assert.deepEqual([state.steps,state.toolAttempts], [32,33]);
});

test('only exact collection tool names receive an action exemption', () => {
  const state = {};
  for (const name of ['worker_result','tool_request_status']) chargeToolAttempt(state,name,options);
  for (const name of ['Worker_Result','worker_result_extra','nimbus.worker_result','','not_available']) chargeToolAttempt(state,name,options);
  assert.deepEqual([state.steps,state.toolAttempts], [5,7]);
});

test('small configurations retain at least 64 attempt slots without increasing action limits', () => {
  const state = {};
  const budget = chargeToolAttempt(state,'ask_worker',{maxSteps:1});
  assert.equal(budget.actionLimit,1);assert.equal(budget.attemptLimit,64);
  exhausted(()=>chargeToolAttempt(state,'read_file',{maxSteps:1}));
  for(let i=0;i<62;i++) chargeToolAttempt(state,'worker_result',{maxSteps:1});
  assert.deepEqual([state.steps,state.toolAttempts], [1,64]);
  assert.equal(exhausted(()=>chargeToolAttempt(state,'tool_request_status',{maxSteps:1})).budget.attemptsUsed,65);
});

test('totals remain independent and monotonic when a caller opens a new continuation slice', () => {
  const state={steps:31,toolAttempts:90,totalActionSteps:70,totalToolAttempts:180,messages:[{role:'user',content:'retained'}]};
  chargeToolAttempt(state,'ask_worker',options);
  state.steps=0;state.toolAttempts=0;
  chargeToolAttempt(state,'worker_result',options);
  chargeToolAttempt(state,'read_file',options);
  assert.deepEqual([state.steps,state.toolAttempts,state.totalActionSteps,state.totalToolAttempts], [1,2,72,183]);
  assert.deepEqual(state.messages,[{role:'user',content:'retained'}]);
});

test('missing/null/corrupt counters normalize to bounded numbers and held attempts saturate safely', () => {
  const empty={steps:null,toolAttempts:null,totalActionSteps:null,totalToolAttempts:null};
  chargeToolAttempt(empty,'worker_result',options);
  assert.deepEqual(empty,{steps:0,toolAttempts:1,totalActionSteps:0,totalToolAttempts:1});
  const corrupt={steps:-5,toolAttempts:NaN,totalActionSteps:Infinity,totalToolAttempts:'not a number'};
  chargeToolAttempt(corrupt,'read_file',options);
  assert.deepEqual(corrupt,{steps:1,toolAttempts:1,totalActionSteps:1,totalToolAttempts:1});
  const oversized={steps:1000000,toolAttempts:1000000,totalActionSteps:Number.MAX_SAFE_INTEGER,totalToolAttempts:Number.MAX_SAFE_INTEGER};
  const error=exhausted(()=>chargeToolAttempt(oversized,'worker_result',options));
  assert.equal(error.budget.actionsUsed,32);assert.equal(error.budget.attemptsUsed,129);
  assert.equal(oversized.totalToolAttempts,Number.MAX_SAFE_INTEGER);
  assert.equal(oversized.totalActionSteps,Number.MAX_SAFE_INTEGER);
  exhausted(()=>chargeToolAttempt(oversized,'worker_result',options));
  assert.equal(oversized.toolAttempts,129);
});

test('legacy action counters seed missing action totals without inflating independent attempt counters', () => {
  const state={steps:7};
  chargeToolAttempt(state,'read_file',options);
  assert.deepEqual([state.steps,state.toolAttempts,state.totalActionSteps,state.totalToolAttempts], [8,1,8,1]);
});

test('invalid configuration throws before mutating a checkpoint', () => {
  const state={steps:2,toolAttempts:4,totalActionSteps:6,totalToolAttempts:8},before=structuredClone(state);
  for(const maxSteps of [undefined,null,0,-1,1.5,'32',NaN,Infinity,Number.MAX_SAFE_INTEGER]){
    assert.throws(()=>chargeToolAttempt(state,'read_file',{maxSteps}),/maxSteps/);
    assert.throws(()=>toolBudgetFeedback(state,{maxSteps}),/maxSteps/);
  }
  assert.deepEqual(state,before);
  assert.throws(()=>chargeToolAttempt(null,'read_file',options),/checkpoint object/);
});

test('feedback begins at exact soft thresholds and describes bounded evidence/continuation choices', () => {
  assert.equal(toolBudgetFeedback({steps:23,toolAttempts:95},options),'');
  const actionFeedback=toolBudgetFeedback({steps:24,toolAttempts:30},options);
  assert.match(actionFeedback,/8 of 32 action slots/);assert.match(actionFeedback,/98 of 128 tool attempts/);
  assert.match(actionFeedback,/evidence/);assert.match(actionFeedback,/handoff/);assert.match(actionFeedback,/bounded/);assert.match(actionFeedback,/checkpoint/);
  const attemptFeedback=toolBudgetFeedback({steps:0,toolAttempts:96},options);
  assert.match(attemptFeedback,/32 of 32 action slots/);assert.match(attemptFeedback,/32 of 128 tool attempts/);
});

test('feedback is pure and does not copy/replace or mutate a frozen checkpoint', () => {
  const message=Object.freeze({role:'user',content:'unchanged'}),messages=Object.freeze([message]);
  const state=Object.freeze({steps:24,toolAttempts:30,totalActionSteps:44,totalToolAttempts:90,messages});
  assert.ok(toolBudgetFeedback(state,options));
  assert.equal(state.messages,messages);assert.equal(state.messages[0],message);
  assert.deepEqual(state,{steps:24,toolAttempts:30,totalActionSteps:44,totalToolAttempts:90,messages:[{role:'user',content:'unchanged'}]});
});
