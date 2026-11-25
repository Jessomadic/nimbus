import test from 'node:test';
import assert from 'node:assert/strict';
import {createFailureDiagnostics} from '../runtime/diagnostics.js';

// Node 26's default (spec) reporter output for one passing and one failing test.
const spec=[
  '✔ passes (1.2ms)',
  '✖ middle failure keeps its cause (3.4ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  + 1',
  '  - 2',
  '✔ later test (0.5ms)',
  'ℹ tests 3',
  'ℹ fail 1',
  '',
  '✖ failing tests:',
  '',
  '✖ middle failure keeps its cause (3.4ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  ''
].join('\n');

test('spec reporter failures are captured once with their cause, not again from the summary',()=>{
  const collector=createFailureDiagnostics();collector.write(spec);
  const {text,count}=collector.snapshot();
  assert.equal(count,1);
  assert.match(text,/✖ middle failure keeps its cause/);
  assert.match(text,/AssertionError/);
  assert.doesNotMatch(text,/later test/);
});

test('TAP failures are still captured',()=>{
  const collector=createFailureDiagnostics();
  collector.write('ok 1 - passes\nnot ok 2 - broken\n  ---\n  error: boom\n  ...\nok 3 - after\n# fail 1\n');
  const {text,count}=collector.snapshot();
  assert.equal(count,1);assert.match(text,/not ok 2 - broken/);assert.doesNotMatch(text,/ok 3/);
});
