import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-completion-status-'));
process.env.NIMBUS_DATA=path.join(root,'data');process.env.NIMBUS_CONFIG=path.join(root,'config.json');
const {q,db}=await import('../db.js'),{taskResult,drainRuntime}=await import('../runner.js');
const bot=Number(q("INSERT INTO bots(name) VALUES('Completion diagnostic fixture')").run().lastInsertRowid);
const create=(required,scope,state,status='paused')=>Number(q('INSERT INTO runs(bot_id,thread,prompt,status,checkpoint,completion_required,delegation_scope) VALUES(?,?,?,?,?,?,?)').run(bot,'fixture','retained',status,JSON.stringify(state),required,scope).lastInsertRowid);
test('paused task exposes its actual missing evidence without exposing the checkpoint or changing state',()=>{
 const feedback='Check 0 failed; missing F:/owned/report.json',id=create(1,'execution',{noProgress:true,requiredCompletion:false,instructions:'PRIVATE CHECKPOINT',delegatedEvidence:{complete:false,code:'missing_evidence',feedback},messages:[]});
 const before=JSON.stringify(q('SELECT * FROM runs WHERE id=?').get(id)),r=taskResult(id);
 assert.deepEqual(r.completion,{required:true,scope:'execution',bindingPresent:false,outputCaptureRecorded:false,heldForNoProgress:true,decisionCode:'missing_evidence',feedback,feedbackTruncated:false});
 assert.doesNotMatch(JSON.stringify(r),/PRIVATE CHECKPOINT/);assert.equal(JSON.stringify(q('SELECT * FROM runs WHERE id=?').get(id)),before);assert.equal(r.status,'paused');
});
test('checkpoint claims cannot invent immutable binding or output capture',()=>{
 const id=create(1,'execution',{requiredCompletion:true,delegatedCompletion:{contract:{}},delegatedEvidence:{complete:true,receipts:['forged'],files:['forged']}},'stopped');
 let r=taskResult(id);assert.equal(r.completion.bindingPresent,false);assert.equal(r.completion.outputCaptureRecorded,false);assert.equal(r.status,'stopped');
 q('INSERT INTO required_completion_bindings(run,binding) VALUES(?,?)').run(id,'{}');q('INSERT INTO completion_output_captures(run,evidence) VALUES(?,?)').run(id,'{}');
 r=taskResult(id);assert.equal(r.completion.bindingPresent,true);assert.equal(r.completion.outputCaptureRecorded,true);assert.equal(r.status,'stopped');assert.equal(Object.hasOwn(r.completion,'complete'),false);
});
test('diagnostic text is redacted before bounded projection and reports truncation',()=>{
 const secret='secret=do-not-expose-me',pem='-----BEGIN PRIVATE KEY-----\n'+'sensitive'.repeat(1000)+'\n-----END PRIVATE KEY-----';
 const id=create(1,'execution',{delegatedEvidence:{code:'missing_evidence',feedback:secret+' '+pem+' '+'retained '.repeat(1000)}});
 const c=taskResult(id).completion;assert.ok(c.feedback.length<=4000);assert.equal(c.feedbackTruncated,true);assert.doesNotMatch(c.feedback,/do-not-expose-me|sensitive|PRIVATE KEY/);assert.match(c.feedback,/REDACTED/);
});
test('ordinary legacy and new conversation outcomes remain distinct',()=>{
 assert.equal(taskResult(create(0,'legacy',{messages:[]})).completion,null);
 const c=taskResult(create(0,'conversation',{messages:[]},'done')).completion;assert.equal(c.required,false);assert.equal(c.scope,'conversation');assert.equal(c.outputCaptureRecorded,false);
});
test.after(async()=>{await drainRuntime();db.close();assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.match(path.basename(root),/^nimbus-completion-status-/);fs.rmSync(root,{recursive:true,force:true});});
