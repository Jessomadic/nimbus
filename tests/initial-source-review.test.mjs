// Reuse real SQLite/runtime fixture without importing the original test registrations.
import fs from 'node:fs';
const original=fs.readFileSync(new URL('./tool-development.test.mjs',import.meta.url),'utf8');
const header=original.slice(0,original.indexOf("test('queue dispatch"));
const cases=`
async function staged(t){
 const s=fixture(t),id=await building(s);
 await s.finish(id,{approved:false});
 s.service.recoveryOwner=()=>({adopted:true,authorized:true,dispatchSafe:true});
 const prior=randomUUID();
 s.q("INSERT INTO tool_development_requests SELECT ?,tool_name,title,capability,domain,acceptance_json,effects,gap_type,'prior','blocked','blocked',message,version,origin_run_id,requester_run_id,origin_json,'prior-snapshot',validated_hash,candidate_spec,error,error_metadata,activation_state,activation_result,created_at,updated_at FROM tool_development_requests WHERE id=?").run(prior,id);
 s.snapshots.set('prior-snapshot',{state:'snapshot',baseline:{hash:baseline}});
 s.q("INSERT INTO runs(id,bot_id,thread,status,source) VALUES(200,2,'bot:2','done','tool-development')").run();
 s.q("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES(?,'building',1,2,200,'failed',?)").run(prior,path.join(s.root,'prior.json'));
 s.q("UPDATE tool_development_requests SET error_metadata=? WHERE id=?").run(JSON.stringify({code:'lifecycle_failed'}),id);
 const r=s.service.get(id);s.id=id;s.prior=prior;s.input={priorRequestId:prior,expectedSourceHash:candidate,expectedVersion:r.version,stageRunId:r.stages.at(-1).run_id,reason:'Independent baseline review'};
 return s;
}
test('staged first review preserves failure/design and only exact independent evidence enables building retry',async t=>{
 const s=await staged(t),before=s.service.get(s.id),bytes=before.stages.map(x=>fs.readFileSync(x.artifact_path));
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
 const result=s.service.initiateSourceReview(s.id,s.input);
 assert.equal(s.service.initiateSourceReview(s.id,s.input).reviewTaskId,result.reviewTaskId);
 assert.deepEqual(s.service.get(s.id).stages,before.stages);
 assert.equal(s.service.get(s.id).error_metadata.code,'lifecycle_failed');
 before.stages.forEach((x,i)=>assert.deepEqual(fs.readFileSync(x.artifact_path),bytes[i]));
 assert.equal(s.spawned.at(-1).source,'tool-development-investigation');
 const record=s.service.get(s.id).recoveries[0];
 s.q("UPDATE runs SET status='done' WHERE id=?").run(record.task_id);
 const report={requestId:s.id,priorRequestId:s.prior,sourceHash:candidate,approved:true,disposition:'dependency_build_only',summary:'Independent fixture review',findings:[]};
 for(const change of [{approved:false},{requestId:s.prior},{priorRequestId:s.id},{sourceHash:baseline},{findings:['defect']}]){
 fs.writeFileSync(record.artifact_path,JSON.stringify({...report,...change}));
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
 }
 fs.writeFileSync(record.artifact_path,JSON.stringify(report));
 await s.service.pump();assert.equal(s.service.get(s.id).status,'blocked');
 s.service.retry(s.id,{fromPhase:'building'});
 const after=s.service.get(s.id);assert.equal(after.status,'building');assert.equal(after.stages[0].run_id,before.stages[0].run_id);
 assert.equal(after.history.length,1);assert.equal(after.history[0].run_id,before.stages[1].run_id);
 const consumed=s.service.get(s.id).recoveries[0];assert.equal(consumed.artifact_hash,createHash('sha256').update(fs.readFileSync(record.artifact_path)).digest('hex'));
 fs.writeFileSync(record.artifact_path,JSON.stringify({...report,summary:'Tampered'}));
 assert.equal(s.service._reviewedDependency(s.service._row(s.id),s.service._row(s.prior),candidate,{readOnly:true}),false);
});
test('first review rejects stale identity and safety restrictions without dispatch',async t=>{
 for(const kind of ['version','stage','hash','owner','pending','stop','noProgress','uncertain','denied','concurrent']){
 const s=await staged(t),input={...s.input},n=s.spawned.length;
 if(kind==='version')input.expectedVersion++;
 if(kind==='stage')input.stageRunId++;
 if(kind==='hash')input.expectedSourceHash=baseline;
 if(kind==='owner')s.service.recoveryOwner=()=>({adopted:true,authorized:false});
 if(kind==='pending')s.options.maintenance.status=()=>({pending:true,sourceHash:candidate});
 if(kind==='stop')s.q("UPDATE runs SET status='stopped' WHERE id=?").run(input.stageRunId);
 if(kind==='noProgress')s.q('UPDATE runs SET checkpoint=? WHERE id=?').run(JSON.stringify({noProgress:true}),input.stageRunId);
 if(kind==='uncertain')s.q("INSERT INTO tool_calls VALUES('uncertain',?,'shell','uncertain')").run(input.stageRunId);
 if(kind==='denied')s.q("INSERT INTO approvals VALUES(88,?,'denied')").run(input.stageRunId);
 if(kind==='concurrent')s.q("UPDATE tool_development_requests SET status='building' WHERE id=?").run(s.prior);
 assert.throws(()=>s.service.initiateSourceReview(s.id,input),undefined,kind);assert.equal(s.spawned.length,n);
 }
});
test('first initiated setup failure supports fresh exact review and drift/missing/malformed remain held',async t=>{
 const s=await staged(t),r=s.service.initiateSourceReview(s.id,s.input);
 s.q("UPDATE runs SET status='done' WHERE id=?").run(r.reviewTaskId);
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
 fs.writeFileSync(r.artifactPath,'{malformed');
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
 fs.writeFileSync(r.artifactPath,JSON.stringify({requestId:s.id,priorRequestId:s.prior,approved:false,failureKind:'setup',summary:'Missing observation prerequisite'}));
 const fresh=s.service.reviewSource(s.id,{priorRequestId:s.prior,expectedSourceHash:candidate,reviewTaskId:r.reviewTaskId,reason:'Prerequisite corrected'});
 assert.notEqual(fresh.reviewTaskId,r.reviewTaskId);
 assert.throws(()=>s.service.reviewSource(s.id,{priorRequestId:s.prior,expectedSourceHash:candidate,reviewTaskId:r.reviewTaskId,reason:'Duplicate'}),/latest terminal/);
 s.q("UPDATE runs SET status='done' WHERE id=?").run(fresh.reviewTaskId);
 fs.writeFileSync(fresh.artifactPath,JSON.stringify({requestId:s.id,priorRequestId:s.prior,sourceHash:candidate,approved:true,disposition:'dependency_build_only',summary:'Safe baseline',findings:[]}));
 s.diskHash='c'.repeat(64);
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
});
test('every relevant prior must clear, no reversed approval fallback',async t=>{
 const s=await staged(t),r=s.service.initiateSourceReview(s.id,s.input);
 s.q("UPDATE runs SET status='done' WHERE id=?").run(r.reviewTaskId);
 fs.writeFileSync(r.artifactPath,JSON.stringify({requestId:s.id,priorRequestId:s.prior,sourceHash:candidate,approved:true,disposition:'dependency_build_only',summary:'Safe baseline',findings:[]}));
 const second=randomUUID();
 s.q("INSERT INTO tool_development_requests SELECT ?,tool_name,title,capability,domain,acceptance_json,effects,gap_type,'second','blocked','blocked',message,version,origin_run_id,requester_run_id,origin_json,snapshot_id,validated_hash,candidate_spec,error,error_metadata,activation_state,activation_result,created_at,updated_at FROM tool_development_requests WHERE id=?").run(second,s.prior);
 s.q("INSERT INTO runs(id,bot_id,thread,status,source) VALUES(300,2,'bot:2','done','tool-development')").run();
 s.q("INSERT INTO tool_development_stages(request_id,phase,ordinal,bot_id,run_id,status,artifact_path) VALUES(?,'building',1,2,300,'failed',?)").run(second,path.join(s.root,'second.json'));
 assert.throws(()=>s.service.retry(s.id,{fromPhase:'building'}),/Prior source/);
 assert.equal(s.service.get(s.id).history.length,0);
});
`;
await import('data:text/javascript;base64,'+Buffer.from(header.replaceAll("'../runtime/tool-development.js'",JSON.stringify(new URL('../runtime/tool-development.js',import.meta.url).href))+cases).toString('base64'));
