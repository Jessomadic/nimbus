import test from 'node:test';
import assert from 'node:assert/strict';
import {capture} from '../runtime/process.js';

test('known process failure keeps a useful bounded label without raw credentials or unfinished output',async()=>{
  const code="process.stderr.write('fixture group refusal\\nAuthorization: Bearer secret-fixture-token\\nunfinished-secret-fragment');process.exitCode=2";
  await assert.rejects(capture(process.execPath,['-e',code]),error=>{
    assert.match(error.message,/fixture group refusal/);
    assert.doesNotMatch(error.message,/secret-fixture-token|unfinished-secret-fragment/);
    assert.equal(error.exitCode,2);
    assert.equal(error.uncertain,false);
    assert.equal(error.evidence.exitCode,2);
    assert.ok(error.message.length<1300);
    return true;
  });
});
