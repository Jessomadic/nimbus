import test from 'node:test';
import assert from 'node:assert/strict';
import {describeTraceStep,traceInput,traceTechnicalDetails} from '../public/trace-activity.js';

const step = (tool, input, extra = {}) => ({tool, text: `${tool}(${JSON.stringify(input)})`, state: 'done', ...extra});

test('activity explains history, handoffs, results, plans and update stages without claiming success', () => {
  assert.equal(describeTraceStep(step('task_history', {runId: 344, limit: 15, maxChars: 26000})), 'Reviewing task #344’s history');
  assert.equal(describeTraceStep(step('task_history', {limit: 5})), 'Reviewing recent task history');
  assert.equal(describeTraceStep(step('task_history', {runId: 344, callId: '344:call_1'})), 'Retrieving saved tool evidence for task #344');
  assert.equal(describeTraceStep(step('team_status', {includeRecent: true, limit: 30})), 'Checking team progress and recent work');
  assert.equal(describeTraceStep(step('tool_catalog', {query: 'read_file'})), 'Finding available tools: read file');
  assert.equal(describeTraceStep(step('ask_worker', {to: '13', task: 'Retrieve milestone evidence'})), 'Handing off work: Retrieve milestone evidence');
  assert.equal(describeTraceStep(step('worker_result', {runId: 353})), 'Checking task #353’s progress and result');
  assert.equal(describeTraceStep(step('worker_result', {runId: 353}, {state: 'waiting', waitReason: 'delegated'})), 'Waiting for task #353');
  assert.equal(describeTraceStep(step('worker_result', {runId: 353}, {state: 'waiting', waitReason: 'approval'})), 'Checking task #353’s progress and result');
  assert.equal(describeTraceStep(step('update_plan', {steps: [{step: 'Retrieve evidence', status: 'completed'}, {step: 'Review compatibility', status: 'in_progress'}]})), 'Updating the work plan: Review compatibility');
  assert.equal(describeTraceStep(step('self_update', {action: 'validate'}, {state: 'error'})), 'Validating the Nimbus update');
  assert.equal(describeTraceStep(step('self_update', {action: 'apply'})), 'Scheduling the Nimbus update after active tasks finish');
});

test('historical truncation retains only real top-level context and never reads a fake property inside task text', () => {
  const full = step('ask_worker', {to: '13', task: 'Retrieve the complete work order and the canonical milestone evidence. '.repeat(5)});
  const retained = {...full, text: `ask_worker(${JSON.stringify({to: '13', task: 'Retrieve the complete work order and the canonical milestone evidence. '.repeat(5)}).slice(0, 120)})`};
  assert.match(describeTraceStep(retained), /^Handing off work: Retrieve the complete work order.*…$/);
  assert.equal(traceInput(retained).to, '13');
  const misleading = step('ask_worker', {task: 'Quote: "to": "Wrong worker", with \\ and unicode ☁', to: '13'});
  assert.equal(traceInput(misleading).to, '13');
  assert.deepEqual(traceInput({tool: 'ask_worker', text: 'ask_worker({"task":"Say \\"to\\": \\"99\\" then keep read)'}).to, undefined);
  assert.equal(describeTraceStep({tool: 'update_plan', text: 'update_plan({"steps":[{"step":"Recover complete owner work order","status":"in_progr)'}), 'Updating the work plan');
  for (const tail of ['\\', '\\u', '\\u26', '\\u260', '\\"']) {
    assert.doesNotThrow(() => describeTraceStep({tool: 'ask_worker', text: 'ask_worker({"to":"13","task":"Read ' + tail + ')'}));
  }
});

test('structured input, unknown tools, ordinary notes and raw details remain available without mutating evidence', () => {
  const action = {tool: 'read_file', text: 'read_file(truncated)', args: {path: 'F:\\Nimbus\\README.md'}, state: 'done'};
  const before = JSON.stringify(action);
  assert.equal(describeTraceStep(action), 'Reading a file: F:\\Nimbus\\README.md');
  assert.match(traceTechnicalDetails(action), /"path": "F:\\\\Nimbus\\\\README.md"/);
  assert.equal(JSON.stringify(action), before);
  assert.equal(describeTraceStep({tool: 'mcp__github__get_issue', input: {title: 'Review navigation'}}), 'Using github · get issue: Review navigation');
  assert.equal(describeTraceStep({text: 'Compacting retained context…'}), 'Compacting retained context…');
  assert.equal(describeTraceStep({tool: 'task_history', text: 'malformed'}), 'Reviewing recent task history');
  const raw = step('shell', {command: 'npm test'});
  assert.equal(traceTechnicalDetails(raw), raw.text);
  assert.equal(describeTraceStep(raw), 'Running a command: npm test');
  assert.equal(describeTraceStep(step('shared_note', {key: 'milestones', content: ''})), 'Saving shared project notes: milestones');
  assert.equal(describeTraceStep({tool: 'constructor', text: 'constructor({})'}), 'Using constructor');
  assert.equal(describeTraceStep({tool: 'update_plan', input: {steps: {find: 1}}}), 'Updating the work plan');
  assert.doesNotThrow(() => describeTraceStep({tool: 'read_file', text: 'read_file({"\\uZZZZ":"broken"})'}));
});
