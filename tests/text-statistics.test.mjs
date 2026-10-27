import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, tools } from '../runtime/toolsets/generated/text_statistics.js';
import { specialistTools, executeSpecialist } from '../runtime/toolsets/index.js';

test('counts empty, words, Unicode code points, and logical lines', () => {
  assert.deepEqual(execute('text_statistics', { text: '' }), { words: 0, characters: 0, lines: 0 });
  assert.deepEqual(execute('text_statistics', { text: 'Nimbus builds tools.' }), { words: 3, characters: 20, lines: 1 });
  assert.deepEqual(execute('text_statistics', { text: 'café 🚀\nNimbus' }), { words: 3, characters: 13, lines: 2 });
  assert.deepEqual(execute('text_statistics', { text: 'a\r\nb' }), { words: 2, characters: 4, lines: 2 });
});

test('rejects invalid and oversized input without coercion', () => {
  for (const value of [undefined, null, 42, []]) assert.throws(() => execute('text_statistics', { text: value }), /must be a string/);
  assert.throws(() => execute('text_statistics', { text: 'x'.repeat(1_000_001) }), /exceeds/);
  assert.throws(() => execute('text_statistics', { text: '', extra: true }), /unsupported/);
});

test('advertises and registers exactly the requested schema', async () => {
  assert.equal(tools.length, 1);
  assert.equal(tools[0].function.name, 'text_statistics');
  assert.equal(tools[0].function.parameters.type, 'object');
  assert.equal(tools[0].function.parameters.additionalProperties, false);
  assert.equal(specialistTools.filter(tool => tool.function.name === 'text_statistics').length, 1);
  assert.deepEqual(await executeSpecialist('text_statistics', { text: 'ok' }), { words: 1, characters: 2, lines: 1 });
});
