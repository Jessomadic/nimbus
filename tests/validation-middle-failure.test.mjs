import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../runtime/process.js';
import {createFailureDiagnostics,failureDiagnosticLimit,limits} from '../runtime/diagnostics.js';
import {Maintenance} from '../runtime/maintenance.js';
import {execute} from '../runtime/toolsets/engineering.js';

const failed=async(code,options={})=>{
 let error;try{await capture(process.execPath,['-e',code],{diagnosticTail:true,...options});}catch(value){error=value;}
 assert.ok(error,'the synthetic child must fail');return error;
};

test('a real child retains a nested middle TAP assertion after both prefix and tail have moved past it',async()=>{
 const code="process.stdout.write('start\\n'+'ok 1 - prefix filler\\n'.repeat(3000));process.stdout.write('    not ok 2 - MIDDLE_DEFECT π\\n      ---\\n      error: actual middle assertion\\n      expected: 3\\n      actual: 2\\n      ...\\n');process.stdout.write('ok 3 - suffix filler\\n'.repeat(3000));process.exitCode=7;";
 const error=await failed(code);
 assert.equal(error.exitCode,7);assert.equal(error.uncertain,false);
 assert.doesNotMatch(error.stdout,/MIDDLE_DEFECT/);assert.doesNotMatch(error.stdoutTail,/MIDDLE_DEFECT/);
 assert.match(error.evidence.stdoutFailures,/not ok 2 - MIDDLE_DEFECT π/);
 assert.match(error.evidence.stdoutFailures,/actual middle assertion/);
 assert.match(error.message,/MIDDLE_DEFECT/);
 assert.equal(error.evidence.failureBlocks.stdout,1);
});

test('chunk-split UTF-8 and ANSI diagnostics redact credentials before retaining complete lines',async()=>{
 const code=String.raw`const parts=['\x1b[31mnot o','k 4 - colored π\x1b[0m\n  ---\n  error: Authorization: Bear','er synthetic-private-credential\n  location: https://alice:synthetic-private-password@example.test/a\n  ...\n'];let i=0;const send=()=>{if(i===parts.length){process.exitCode=3;return;}const bytes=Buffer.from(parts[i++]);for(const byte of bytes)process.stdout.write(Buffer.from([byte]));setTimeout(send,5);};send();`;
 const error=await failed(code),saved=JSON.stringify({message:error.message,evidence:error.evidence});
 assert.match(error.evidence.stdoutFailures,/colored π/);
 assert.doesNotMatch(saved,/synthetic-private-credential|synthetic-private-password|alice:|\\u001b|�/);
 assert.match(saved,/REDACTED/);
});

test('multiline secrets discovered after a failure suppress captured blocks on both streams',async()=>{
 const secret='SYNTHETIC_PRIVATE_BODY_MUST_NOT_PERSIST';
 const code=`process.stderr.write('Error: before secret\\n');process.stdout.write('not ok 1 - before secret\\n');process.stdout.write('-----BE');setTimeout(()=>{process.stdout.write('GIN PRIVATE KEY-----\\n'+${JSON.stringify(secret+'\n')}.repeat(2000)+'-----END PRIVATE KEY-----\\nnot ok 2 - after secret\\n');process.exitCode=4;},5);`;
 const error=await failed(code);
 assert.equal(error.evidence.diagnosticTailSuppressed,'multiline_secret_marker');
 assert.equal(error.evidence.stdoutFailures,'');assert.equal(error.evidence.stderrFailures,'');
 assert.ok(!JSON.stringify({message:error.message,evidence:error.evidence}).includes(secret));
});

test('failure collection drops oversized and unfinished lines and remains byte bounded under many failures',()=>{
 const collector=createFailureDiagnostics();
 collector.write('not ok 1 - first retained\n  error: expected bounded detail\n');
 collector.write('Authorization: Bearer '+ 'synthetic-private-fragment'.repeat(10000));
 collector.write('\n  ...\n');
 for(let i=2;i<3000;i++)collector.write(`not ok ${i} - later defect\n  error: ${'界'.repeat(30)}\n  ...\n`);
 collector.write('not ok 9999 - trailing\nAuthorization: Bearer unfinished-private');
 const value=collector.snapshot();
 assert.ok(Buffer.byteLength(value.text)<=failureDiagnosticLimit);
 assert.match(value.text,/first retained/);assert.doesNotMatch(value.text,/synthetic-private-fragment|unfinished-private|�/);
 assert.equal(value.truncated,true);assert.equal(value.count,3000);
});

test('passing output and ordinary failure compatibility do not invent failure blocks',async()=>{
 assert.equal(await capture(process.execPath,['-e',"console.log('not ok 1 - text from successful command')"],{diagnosticTail:true}),'not ok 1 - text from successful command\n');
 const error=await failed("console.log('ok 1 - ordinary output');process.exitCode=2;");
 assert.equal(error.evidence.stdoutFailures,'');assert.equal(error.evidence.failureBlocks.stdout,0);
 await assert.rejects(capture(process.execPath,['-e',"console.log('not ok 1 - default failure');process.exitCode=2;"]),e=>!Object.hasOwn(e.evidence,'stdoutFailures'));
});

test('real Maintenance validation persists a middle assertion, truthful exit, and bounded redacted logs',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-middle-maintenance-'));
 t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-middle-maintenance-/);fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 fs.writeFileSync(path.join(root,'tests','middle.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';for(let i=0;i<200;i++)test('before filler '+i,()=>{});test('MIDDLE_MAINTENANCE_DEFECT',()=>assert.fail('actual middle defect Authorization: Bearer synthetic-private-token'));for(let i=0;i<200;i++)test('after filler '+i,()=>{});");
 const manager=new Maintenance({root,dataDir:path.join(root,'data')}),snapshot=manager.snapshot();
 await assert.rejects(manager.validate(snapshot.id));
 const receipt=manager.load(snapshot.id),check=receipt.checks.find(c=>c.pass===false),log=fs.readFileSync(check.outputLog,'utf8');
 assert.equal(receipt.state,'validation_failed');assert.equal(check.exitCode,1);assert.equal(receipt.validatedHash,undefined);
 assert.match(check.processEvidence.stdoutFailures,/MIDDLE_MAINTENANCE_DEFECT/);
 assert.match(check.output,/actual middle defect/);assert.match(log,/actual middle defect/);
 assert.doesNotMatch(JSON.stringify(receipt)+log,/synthetic-private-token/);
 assert.ok(Buffer.byteLength(log)<limits.stdout*2+failureDiagnosticLimit+500);
});

test('ordinary run_checks returns the middle failure as bounded evidence instead of losing its cause',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-middle-checks-'));
 t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-middle-checks-/);fs.rmSync(root,{recursive:true,force:true});});
 fs.writeFileSync(path.join(root,'middle.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';for(let i=0;i<200;i++)test('before filler '+i,()=>{});test('ORDINARY_MIDDLE_DEFECT',()=>assert.fail('ordinary middle cause'));for(let i=0;i<200;i++)test('after filler '+i,()=>{});");
 const result=await execute('run_checks',{runner:'node_test',path:root,files:['middle.test.mjs']},{workspace:root});
 assert.equal(result.pass,false);assert.equal(result.exitCode,1);assert.equal(result.timedOut,false);
 assert.match(result.evidence.stdoutFailures,/ORDINARY_MIDDLE_DEFECT/);
 assert.match(result.error,/ordinary middle cause/);
 assert.ok(Buffer.byteLength(result.evidence.stdoutFailures)<=failureDiagnosticLimit);
});

test('oversized ANSI-styled private key headers cannot leave orphaned secret bodies in middle diagnostics',async()=>{
 const secret='SYNTHETIC_OVERSIZED_PEM_BODY';
 const code="process.stdout.write('ok 1 - prefix\\n'.repeat(3000)+'not ok 2 - private block\\n');process.stdout.write('\\x1b[31m'.repeat(1200)+'-----BE\\x1b[0mGIN PRIVATE KEY-----\\n'+"+JSON.stringify(secret+'\n')+"+'-----END PRIVATE KEY-----\\n');process.stdout.write('ok 3 - suffix\\n'.repeat(3000));process.exitCode=5;";
 const error=await failed(code);
 assert.equal(error.evidence.diagnosticTailSuppressed,'multiline_secret_marker');
 assert.equal(error.evidence.stdoutFailures,'');assert.equal(error.evidence.stderrFailures,'');
 assert.ok(!JSON.stringify({message:error.message,evidence:error.evidence}).includes(secret));
});

test('streaming secret classification crosses chunks and line limits; unclassifiable escape sequences fail closed',()=>{
 for(const header of ['\x1b[31m'.repeat(1200)+'-----BE\x1b[0mGIN PRIVATE KEY-----\n','\x1b]'+ 'oversized-control'.repeat(30)]){
  let reason;const collector=createFailureDiagnostics({onSecret:value=>{reason=value;}});
  collector.write('not ok 1 - active failure\n');
  for(const char of header)collector.write(char);
  collector.write('SYNTHETIC_ORPHAN_BODY\n');
  assert.ok(['multiline_secret_marker','unclassified_terminal_sequence'].includes(reason));
  assert.equal(collector.snapshot().text,'');assert.equal(collector.snapshot().truncated,true);
 }
});

test('redaction expansion clips only at complete lines and truthfully marks truncation',()=>{
 const collector=createFailureDiagnostics();
 for(let i=0;i<110;i++)collector.write('not ok 1 - token=abcdef token=abcdef token=abcdef token=abcdef\n');
 const value=collector.snapshot();
 assert.ok(Buffer.byteLength(value.text)<=failureDiagnosticLimit);
 assert.equal(value.text.endsWith('\n'),true);assert.equal(value.truncated,true);
 assert.doesNotMatch(value.text,/abcdef/);
});

test('short terminal strings around oversized styled headers suppress both streams before clipping',async()=>{
 const secret='SYNTHETIC_TERMINAL_STRING_SECRET_BODY';
 for(const [start,end] of [['\x1bP','\x1b\\'],['\x1b]','\x07'],['\x1bX','\x1b\\'],['\x1b^','\x1b\\'],['\x1b_','\x1b\\'],['\u0090','\u009c'],['\u009d','\u009c']]){
  const header='\x1b[0m'.repeat(1100)+start+'-----BE\x1b[31mGIN PRIVATE KEY-----'+end+'\n'+secret+'\n-----END PRIVATE KEY-----\n';
  const code="process.stdout.write('ok 1 - prefix\\n'.repeat(3000)+'not ok 2 - active failure\\n');process.stderr.write('Error: other stream\\n');process.stdout.write("+JSON.stringify(header)+");process.stdout.write('ok 3 - suffix\\n'.repeat(3000));process.exitCode=19;";
  const error=await failed(code);
  assert.equal(error.evidence.diagnosticTailSuppressed,'unclassified_terminal_sequence');
  assert.equal(error.evidence.stdoutFailures,'');assert.equal(error.evidence.stderrFailures,'');
  assert.ok(!JSON.stringify({message:error.message,evidence:error.evidence}).includes(secret));
 }
});
