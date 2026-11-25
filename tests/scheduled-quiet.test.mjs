import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Module mocks belong to a separate process with isolated data/config paths.
// Clearing the inherited flag ensures Node actually executes the child tests.
test('scheduled quiet tasks retain exact requests, results, and recovery holds', {timeout:120000}, () => {
  const env={...process.env};
  delete env.NODE_TEST_CONTEXT;
  const fixture=fileURLToPath(new URL('./helpers/scheduled-quiet-fixture.mjs',import.meta.url));
  const result=spawnSync(process.execPath,['--no-warnings','--experimental-test-module-mocks','--test','--test-reporter=tap','--test-concurrency=1',fixture],{
    cwd:path.dirname(fixture),env,encoding:'utf8',windowsHide:true,timeout:110000,maxBuffer:1024*1024,
  });
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.signal,null,result.stderr);
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.match(result.stdout,/# tests 8\b/);
  assert.match(result.stdout,/# pass 8\b/);
  assert.match(result.stdout,/# fail 0\b/);
  assert.match(result.stdout,/# skipped 0\b/);
});
