import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {capture} from '../runtime/process.js';
import {boundedTail,limits} from '../runtime/diagnostics.js';
import {Maintenance} from '../runtime/maintenance.js';

test('opt-in failed command retains early and late complete diagnostics with true exit and bounded redacted tails',async()=>{
 const script=`process.stdout.write('EARLY_MARKER\\n');for(let i=0;i<2000;i++)process.stdout.write('passing '+i+'\\n');process.stdout.write('Authorization: Bear');setTimeout(()=>{process.stdout.write('er synthetic-private-token\\nLATE_ASSERTION π failed\\n');process.stderr.write('https://alice:synthetic-password@example.test/path\\nFINAL_ERROR\\n');process.exitCode=7;},5);`;
 let failure;try{await capture(process.execPath,['-e',script],{diagnosticTail:true});}catch(error){failure=error;}
 assert.ok(failure);assert.equal(failure.exitCode,7);assert.equal(failure.uncertain,false);
 assert.match(failure.stdout,/EARLY_MARKER/);assert.match(failure.stdoutTail,/LATE_ASSERTION π failed/);assert.match(failure.stderrTail,/FINAL_ERROR/);
 assert.equal(failure.evidence.stdoutTruncated,true);assert.equal(failure.evidence.stdoutTailTruncated,true);
 assert.ok(Buffer.byteLength(failure.stdoutTail)<=limits.stdout);assert.ok(Buffer.byteLength(failure.stderrTail)<=limits.stderr);
 const persisted=JSON.stringify({message:failure.message,evidence:failure.evidence});
 for(const secret of ['synthetic-private-token','synthetic-password','alice:'])assert.ok(!persisted.includes(secret),secret);
});

test('clipped leading and unfinished trailing lines never survive tail redaction, including multibyte boundaries',()=>{
 const secret='UNRECOGNIZABLE_SECRET_FRAGMENT';
 assert.equal(boundedTail(secret+'\nvalid π\nlast partial secret',64,{clipped:true}),'valid π\n');
 assert.equal(boundedTail(secret,64,{clipped:true}),'');
 const text='old line\n'+'界'.repeat(40)+'\nlatest π\n';
 const result=boundedTail(text,24);assert.equal(result,'latest π\n');assert.ok(!result.includes('\ufffd'));
 assert.equal(boundedTail('x'.repeat(10000)+'\n',32),'');
});

test('successful output and default failure shape remain compatible; successful overflow is still rejected',async()=>{
 assert.equal(await capture(process.execPath,['-e',"process.stdout.write('ordinary success')"],{diagnosticTail:true}),'ordinary success');
 await assert.rejects(capture(process.execPath,['-e',"console.log('failure');process.exitCode=2"]),error=>error.exitCode===2&&!Object.hasOwn(error,'stdoutTail')&&!Object.hasOwn(error.evidence,'stdoutTail'));
 await assert.rejects(capture(process.execPath,['-e',"process.stdout.write('x'.repeat(2000100)+'\\nFINAL_OVERFLOW\\n')"],{diagnosticTail:true}),error=>error.exitCode===0&&error.evidence.captureOverflow===true&&error.evidence.outputComplete===false&&error.stdoutTail==='FINAL_OVERFLOW\n');
});

test('a chunk-split multiline secret suppresses rolling tails even after its header has been evicted',async()=>{
 const secretLine='SYNTHETIC_PEM_BODY_DO_NOT_PERSIST'.repeat(3);
 const script=`process.stdout.write('-----BE');setTimeout(()=>{process.stdout.write('GIN PRIVATE KEY-----\\n'+${JSON.stringify(secretLine+'\n')}.repeat(800)+'-----END PRIVATE KEY-----\\nLATE_FAILURE\\n');process.exitCode=6;},5);`;
 let failure;try{await capture(process.execPath,['-e',script],{diagnosticTail:true});}catch(error){failure=error;}
 assert.equal(failure.exitCode,6);assert.equal(failure.uncertain,false);
 assert.equal(failure.evidence.diagnosticTailSuppressed,'multiline_secret_marker');
 assert.ok(!JSON.stringify({message:failure.message,evidence:failure.evidence,stdout:failure.stdout,stderr:failure.stderr,stdoutTail:failure.stdoutTail,stderrTail:failure.stderrTail}).includes(secretLine));
 assert.match(failure.stdoutTail,/omitted/);assert.match(failure.stdout,/\[REDACTED\]/);
});

test('Maintenance never persists an evicted multiline secret body in either log or receipt',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-pem-maintenance-'));
 t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-pem-maintenance-/);fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 const secret='SYNTHETIC_KEY_BODY_MUST_NOT_BE_SAVED'.repeat(3);
 fs.writeFileSync(path.join(root,'tests','pem.test.mjs'),`import test from 'node:test';test('synthetic PEM failure',()=>{console.error('-----BEGIN RSA PRIVATE KEY-----\\n'+${JSON.stringify(secret+'\n')}.repeat(800)+'-----END RSA PRIVATE KEY-----\\n');throw Error('fixture failure');});`);
 const manager=new Maintenance({root,dataDir:path.join(root,'data')}),snapshot=manager.snapshot();
 await assert.rejects(manager.validate(snapshot.id));
 const receipt=manager.load(snapshot.id),failed=receipt.checks.find(c=>c.pass===false);assert.equal(failed.exitCode,1);
 assert.equal(failed.processEvidence.diagnosticTailSuppressed,'multiline_secret_marker');
 for(const value of [JSON.stringify(receipt),fs.readFileSync(failed.outputLog,'utf8'),fs.readFileSync(failed.stderrLog,'utf8')])assert.ok(!value.includes(secret));
});

test('Maintenance preserves a late failing assertion after large passing output and keeps failed attempt logs after repair',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-tail-maintenance-'));
 t.after(()=>{assert.equal(path.dirname(root),os.tmpdir());assert.match(path.basename(root),/^nimbus-tail-maintenance-/);fs.rmSync(root,{recursive:true,force:true});});
 fs.mkdirSync(path.join(root,'tests'));fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
 const file=path.join(root,'tests','late.test.mjs');
 fs.writeFileSync(file,"import test from 'node:test';import assert from 'node:assert/strict';test('EARLY_VALIDATION_MARKER',()=>{});for(let i=0;i<400;i++)test('passing filler '+i,()=>{});test('LATE_FAILURE_REASON',()=>assert.fail('actual late defect'));");
 const manager=new Maintenance({root,dataDir:path.join(root,'data')}),snapshot=manager.snapshot();
 await assert.rejects(manager.validate(snapshot.id));
 const failed=manager.load(snapshot.id),check=failed.checks.find(c=>c.pass===false);
 assert.equal(failed.state,'validation_failed');assert.equal(check.exitCode,1);
 assert.ok(check.processEvidence.stdoutBytesSeen>limits.stdout);
 const retained=fs.readFileSync(check.outputLog,'utf8');assert.match(retained,/EARLY_VALIDATION_MARKER/);assert.match(retained,/LATE_FAILURE_REASON/);assert.match(retained,/actual late defect/);
 assert.ok(Buffer.byteLength(retained)<limits.stdout*2+200);
 fs.writeFileSync(file,"import test from 'node:test';test('corrected behavior',()=>{});");
 const passed=await manager.validate(snapshot.id);assert.equal(passed.state,'validated');
 assert.notEqual(passed.checks.find(c=>c.name==='Nimbus tests').outputLog,check.outputLog);assert.equal(fs.readFileSync(check.outputLog,'utf8'),retained);
});
