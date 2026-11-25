import fs from 'node:fs';
const root=new URL('../',import.meta.url);
const original=fs.readFileSync(new URL('tests/tool-development.test.mjs',root),'utf8');
const header=original.slice(0,original.indexOf("test('queue dispatch")).replaceAll("'../runtime/tool-development.js'",JSON.stringify(new URL('runtime/tool-development.js',root).href));
const initial=fs.readFileSync(new URL('tests/initial-source-review.test.mjs',root),'utf8');
const staged=initial.slice(initial.indexOf('async function staged(t)'),initial.indexOf("test('staged first"));
const cases=`
for (const when of [1,2]) test('receipt replacement after read '+when+' must reject before Builder dispatch',async t=>{
 const s=await staged(t),r=s.service.initiateSourceReview(s.id,s.input);
 s.q("UPDATE runs SET status='done' WHERE id=?").run(r.reviewTaskId);
 const report={requestId:s.id,priorRequestId:s.prior,sourceHash:candidate,approved:true,disposition:'dependency_build_only',summary:'Synthetic independent acceptance',findings:[]};
 fs.writeFileSync(r.artifactPath,JSON.stringify(report));
 const oldRead=fs.readFileSync;let reads=0,error;
 const count=s.spawned.length;
 fs.readFileSync=function(file,...args){
  const bytes=oldRead.call(this,file,...args);
  if(String(file)===r.artifactPath&&++reads===when)fs.writeFileSync(r.artifactPath,JSON.stringify({...report,approved:false,findings:['Injected rejection']}));
  return bytes;
 };
 try{s.service.retry(s.id,{fromPhase:'building'});}catch(e){error=e;}finally{fs.readFileSync=oldRead;}
 const recovery=s.service.get(s.id).recoveries[0];
 console.log(JSON.stringify({when,reads,rejected:!!error,error:error?.message,status:s.service.get(s.id).status,newDispatches:s.spawned.length-count,retained:recovery.status,hashMatchesRejected:recovery.artifact_hash===createHash('sha256').update(fs.readFileSync(r.artifactPath)).digest('hex')}));
 assert.ok(error,'Changed receipt must reject before dispatch');
 assert.equal(s.spawned.length,count);
 assert.equal(s.service.get(s.id).history.length,0);
});
`;
await import('data:text/javascript;base64,'+Buffer.from(header+staged+cases).toString('base64'));
