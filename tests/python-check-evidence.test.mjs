import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {capture} from '../runtime/process.js';
import {execute} from '../runtime/toolsets/engineering.js';

const node=(source,options)=>capture(process.execPath,['-e',source],options);

test('capture keeps the stdout string interface and rejects successful overflow',async()=>{
  assert.equal(await node("process.stdout.write('z'.repeat(100000))"),'z'.repeat(100000));
  await assert.rejects(node("process.stdout.write('z'.repeat(2000001))"),e=>e.exitCode===0&&e.evidence.captureOverflow&&e.evidence.outputComplete===false);
});

test('successful result evidence preserves stderr and split UTF-8 with terminal facts',async()=>{
  const r=await node("const b=Buffer.from('界\\n');process.stderr.write(b.subarray(0,1));setTimeout(()=>process.stderr.write(b.subarray(1)),50)",{resultEvidence:true});
  assert.equal(r.stdout,'');assert.equal(r.stderr,'界\n');assert.equal(r.exitCode,0);
  assert.ok(r.evidence.closedAt);assert.equal(r.evidence.stderrBytesSeen,4);assert.equal(r.evidence.stderrTruncated,false);assert.equal(r.timedOut,false);
});

test('successful stderr evidence is bounded, redacted and reports truncation',async()=>{
  const r=await node("process.stderr.write('Authorization: Bearer synthetic-proof-only\\n'+'line\\n'.repeat(8000))",{resultEvidence:true});
  assert.ok(r.evidence.stderrTruncated);assert.ok(Buffer.byteLength(r.stderr)<=8192);
  assert.ok(!JSON.stringify(r).includes('synthetic-proof-only'));
});

test('detailed success capture does not change failure and timeout behavior',async()=>{
  await assert.rejects(node("console.error('known refusal');process.exitCode=7",{resultEvidence:true}),e=>e.exitCode===7&&e.evidence.closedAt&&/known refusal/.test(e.stderr));
  await assert.rejects(node('setInterval(()=>{},1000)',{timeout:100,resultEvidence:true}),e=>e.evidence.timedOut&&e.evidence.killRequested);
});

const python=process.platform==='win32'?'python.exe':'python3';
const pythonAvailable=spawnSync(python,['--version'],{encoding:'utf8',windowsHide:true,timeout:5000}).status===0;
test('run_checks retains real successful unittest diagnostics and preserves exit semantics',{skip:!pythonAvailable},async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-python-evidence-'));
  const marker='OWNED_UNITTEST_STDERR_PROOF';
  fs.writeFileSync(path.join(dir,'test_proof.py'),"import unittest,sys\nclass Proof(unittest.TestCase):\n def test_proof(self):\n  print('"+marker+"',file=sys.stderr)\n  self.assertTrue(True)\n");
  const r=await execute('run_checks',{runner:'python_unittest',path:dir},{workspace:dir});
  assert.equal(r.pass,true);assert.equal(r.exitCode,0);assert.equal(r.stdout,'');
  assert.match(r.stderr,/Ran 1 test/);assert.ok(r.stderr.includes(marker));assert.ok(r.evidence.closedAt);
  const empty=path.join(dir,'empty');fs.mkdirSync(empty);
  // Python versions differ on empty discovery exit status. Preserve the actual
  // interpreter's status while always retaining its diagnostics.
  const baseline=spawnSync(python,['-m','unittest','discover','-s',empty,'-v'],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(baseline.error,undefined);assert.notEqual(baseline.status,null);
  const e=await execute('run_checks',{runner:'python_unittest',path:empty},{workspace:dir});
  assert.equal(e.exitCode,baseline.status);assert.equal(e.pass,baseline.status===0);assert.match(e.stderr,/Ran 0 tests/);
  fs.writeFileSync(path.join(dir,'test_proof.py'),"import unittest\nclass Proof(unittest.TestCase):\n def test_failure(self):\n  self.fail('owned failure')\n");
  const f=await execute('run_checks',{runner:'python_unittest',path:dir},{workspace:dir});
  assert.equal(f.pass,false);assert.equal(f.exitCode,1);assert.match(f.stderr,/owned failure/);
});
