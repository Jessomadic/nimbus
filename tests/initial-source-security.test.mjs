import fs from 'node:fs';
const root=new URL('../',import.meta.url);
const original=fs.readFileSync(new URL('tests/tool-development.test.mjs',root),'utf8');
const header=original.slice(0,original.indexOf("test('queue dispatch")).replaceAll("'../runtime/tool-development.js'",JSON.stringify(new URL('runtime/tool-development.js',root).href));
const initial=fs.readFileSync(new URL('tests/initial-source-review.test.mjs',root),'utf8');
const staged=initial.slice(initial.indexOf('async function staged(t)'),initial.indexOf("test('staged first"));
const cases=`
function accepted(s) {
 const r=s.service.initiateSourceReview(s.id,s.input);
 s.q("UPDATE runs SET status='done' WHERE id=?").run(r.reviewTaskId);
 fs.writeFileSync(r.artifactPath,JSON.stringify({requestId:s.id,priorRequestId:s.prior,sourceHash:candidate,approved:true,disposition:'dependency_build_only',summary:'Synthetic independent acceptance',findings:[]}));
 return r;
}
for(const gate of ['stopped','noProgress'])test('SECURITY retry must reject prior stage '+gate+' after initial review',async t=>{
 const s=await staged(t);accepted(s);
 if(gate==='stopped')s.q("UPDATE runs SET status='stopped' WHERE id=200").run();
 else s.q("UPDATE runs SET checkpoint=? WHERE id=200").run(JSON.stringify({noProgress:true}));
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),undefined,'Unsafe prior must prevent Builder dispatch');
});
test('SECURITY retry must reject reviewer noProgress',async t=>{
 const s=await staged(t),r=accepted(s);
 s.q("UPDATE runs SET checkpoint=? WHERE id=?").run(JSON.stringify({noProgress:true}),r.reviewTaskId);
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),undefined,'Unsafe review must not clear source');
});
test('SECURITY request-level no_progress must block initiation',async t=>{
 const s=await staged(t);
 s.q("UPDATE tool_development_requests SET error_metadata=? WHERE id=?").run(JSON.stringify({code:'no_progress'}),s.id);
 assert.throws(()=>s.service.initiateSourceReview(s.id,s.input),undefined,'Request no-progress hold must survive');
});
test('SECURITY fresh setup review must reject stopped consumer stage',async t=>{
 const s=await staged(t),r=accepted(s);
 fs.writeFileSync(r.artifactPath,JSON.stringify({requestId:s.id,priorRequestId:s.prior,sourceHash:candidate,approved:false,failureKind:'setup',summary:'Synthetic setup missing'}));
 s.q("UPDATE runs SET status='stopped' WHERE id=?").run(s.input.stageRunId);
 assert.throws(()=>s.service.reviewSource(s.id,{priorRequestId:s.prior,expectedSourceHash:candidate,reviewTaskId:r.reviewTaskId,reason:'Synthetic setup corrected'}),undefined,'Stopped consumer cannot trigger a new reviewer');
});
`;
await import('data:text/javascript;base64,'+Buffer.from(header+staged+cases).toString('base64'));
