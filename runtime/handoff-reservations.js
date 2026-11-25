// Durable reservation store. Construction initializes only additive tables.
// No run insertion, queue submission, timer or activation occurs here.
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {HandoffError,normalizeHandoffIntent,handoffFingerprint,assertHandoffAuthorization,assertHandoffActivation,boundedHandoffContext} from './project-successor-handoff.js';
const reject=code=>{throw new HandoffError(code);};
const sha=b=>createHash('sha256').update(b).digest('hex');
function contained(root,target){const r=path.relative(root,target);return r!==''&&!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);}
function safeRead(root,ref,max){
 const base=fs.realpathSync(root),parts=ref.split('/');let current=base;
 for(const part of parts){current=path.join(current,part);const s=fs.lstatSync(current);if(s.isSymbolicLink()||!contained(base,fs.realpathSync(current)))reject('artifact_link_escape');}
 const fd=fs.openSync(current,'r');
 try{
  const before=fs.fstatSync(fd);if(!before.isFile()||before.size>max)reject('archive_oversized');
  const bytes=Buffer.alloc(before.size);let offset=0;
  while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!n)reject('artifact_changed');offset+=n;}
  const after=fs.fstatSync(fd),live=fs.lstatSync(current);
  if(before.dev!==live.dev||before.ino!==live.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||live.isSymbolicLink())reject('artifact_changed');
  return bytes;
 }finally{fs.closeSync(fd);}
}
export class HandoffReservations {
 constructor({db,dataDir,authority,now=()=>Date.now()}){
  if(!db||typeof authority!=='function')throw new Error('Host database and authority resolver required');
  Object.assign(this,{db,dataDir,authority,now});
  db.exec(`CREATE TABLE IF NOT EXISTS project_handoff_reservations(
   id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
   intent TEXT NOT NULL,principal TEXT NOT NULL,bot_id INTEGER NOT NULL,
   archive TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,
   successor_run_id INTEGER UNIQUE,blocked_code TEXT,created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS project_handoff_events(
   id INTEGER PRIMARY KEY,reservation_id TEXT NOT NULL,revision INTEGER NOT NULL,
   state TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 }
 // A committed reservation owns recovery until cancellation; activation cannot revive its leader.
 holdsLeader(runId){
  return this.db.prepare("SELECT 1 FROM project_handoff_reservations WHERE json_extract(intent,'$.leaderRunId')=? AND state IN ('reserved','blocked','activated') LIMIT 1").get(Number(runId))!==undefined;
 }
 row(id){return this.db.prepare('SELECT * FROM project_handoff_reservations WHERE id=?').get(id);}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 audit(row,detail){this.db.prepare('INSERT INTO project_handoff_events(reservation_id,revision,state,detail,created_at) VALUES(?,?,?,?,?)').run(row.id,row.revision,row.state,JSON.stringify(detail),this.now());}
 host(row,principal){
  const stored=JSON.parse(row.principal);
  if(!principal||!['named-owner','local-admin'].includes(principal.kind)||principal.kind!==stored.kind||principal.id!==stored.id)reject('owner_required');
 }
 worker(row,identity){
  if(!identity||identity.runId!==JSON.parse(row.intent).leaderRunId||identity.botId!==row.bot_id||typeof identity.requestKey!=='string'||!identity.requestKey)reject('consumer_binding');
 }
 archive(intent){
  const pins=[{ref:intent.checkpointRef,sha256:intent.checkpointSha256},...intent.relatedArtifactPins];
  let remaining=2*1024*1024;
  const artifacts=pins.map(p=>{const bytes=safeRead(this.dataDir,p.ref,remaining);remaining-=bytes.length;if(sha(bytes)!==p.sha256)reject('archive_hash_mismatch');return {...p,bytes};});
  boundedHandoffContext(intent,artifacts);
  // A random exclusive directory is immutable evidence, not authorization.
  const root=path.join(this.dataDir,'project-handoffs');
  fs.mkdirSync(root,{recursive:true});
  if(fs.lstatSync(root).isSymbolicLink()||!contained(fs.realpathSync(this.dataDir),fs.realpathSync(root)))reject('archive_link_escape');
  const directory=fs.mkdtempSync(path.join(root,randomUUID()+'-'));
  const manifest=artifacts.map((a,index)=>{
   const file=path.join(directory,index+'.bin');fs.writeFileSync(file,a.bytes,{flag:'wx'});
   if(sha(fs.readFileSync(file))!==a.sha256)reject('archive_readback');
   return {ref:a.ref,sha256:a.sha256,archiveRef:path.relative(this.dataDir,file).split(path.sep).join('/'),size:a.bytes.length};
  });
  const bytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'manifest.tmp'),bytes,{flag:'wx'});
  fs.renameSync(path.join(directory,'manifest.tmp'),path.join(directory,'manifest.json'));
  if(sha(fs.readFileSync(path.join(directory,'manifest.json')))!==sha(bytes))reject('manifest_readback');
  const prompt=boundedHandoffContext(intent,artifacts.map((a,i)=>({...a,archiveRef:manifest[i].archiveRef})));
  return {manifest,prompt,manifestHash:sha(bytes)};
 }
 authorize(input,principal){
  const intent=normalizeHandoffIntent(input),fingerprint=handoffFingerprint(intent);
  const existing=this.row(intent.reservationId);
  if(existing){
   this.host(existing,principal);if(existing.fingerprint!==fingerprint)reject('payload_conflict');
   // Idempotency cannot cache approval of mutable authority or evidence.
   if(!['authorized','reserved'].includes(existing.state))reject('invalid_transition');
   assertHandoffAuthorization(intent,{...this.authority(intent,principal),principal});
   this.verifyArtifacts(existing);
   return this.visible(existing);
  }
  const proof=this.authority(intent,principal);
  assertHandoffAuthorization(intent,{...proof,principal});
  if(!Number.isSafeInteger(proof.leader.bot_id)||proof.leader.bot_id<1)reject('consumer_binding');
  const archive=this.archive(intent);
  return this.transaction(()=>{
   // Re-evaluate live host policy after filesystem work, inside serialized publication.
   const current=this.authority(intent,principal);assertHandoffAuthorization(intent,{...current,principal});
   if(current.leader.bot_id!==proof.leader.bot_id)reject('consumer_binding');
   this.db.prepare('INSERT INTO project_handoff_reservations(id,request_id,fingerprint,intent,principal,bot_id,archive,state,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(intent.reservationId,intent.successorRequestId,fingerprint,JSON.stringify(intent),JSON.stringify(principal),proof.leader.bot_id,JSON.stringify(archive),'authorized',1,this.now());
   const row=this.row(intent.reservationId);this.audit(row,{kind:'owner_authorized',fingerprint});return this.visible(row);
  });
 }
 visible(row){if(!row)reject('reservation_missing');const i=JSON.parse(row.intent);return {reservationId:row.id,state:row.state,revision:row.revision,project:i.project,leaderRunId:i.leaderRunId,checkpointRef:i.checkpointRef,checkpointSha256:i.checkpointSha256,deployment:i.deployment,successorRequestId:row.request_id,successorRunId:row.successor_run_id??null,blockedReasonCode:row.blocked_code??null,archives:JSON.parse(row.archive).manifest};}
 status(id,identity,{principal}={}){const row=this.row(id);if(!row)reject('reservation_missing');if(principal)this.host(row,principal);else this.worker(row,identity);return this.visible(row);}
 command(args,identity,{principal}={}){
  if(!['reserve','cancel'].includes(args.action))reject('invalid_action');
  return this.transaction(()=>{
   const row=this.row(args.reservationId);if(!row)reject('reservation_missing');
   if(principal)this.host(row,principal);else this.worker(row,identity);
   if(args.action==='reserve'){
    if(principal)reject('worker_reserve_required');
    if(args.expectedCheckpointHash!==JSON.parse(row.intent).checkpointSha256)reject('checkpoint_changed');
    if(!['authorized','reserved'].includes(row.state))reject('invalid_transition');
    const intent=JSON.parse(row.intent);
    assertHandoffAuthorization(intent,{...this.authority(intent,JSON.parse(row.principal),identity),principal:JSON.parse(row.principal)});
    this.verifyArtifacts(row);
    // Idempotency preserves publication, not stale policy or checkpoint approval.
    if(row.state==='reserved')return this.visible(row);
   }else{
    if(row.state==='cancelled')return this.visible(row);
    if(!['authorized','reserved','blocked'].includes(row.state))reject('invalid_transition');
   }
   this.db.prepare('UPDATE project_handoff_reservations SET state=?,revision=revision+1 WHERE id=? AND revision=?')
    .run(args.action==='reserve'?'reserved':'cancelled',row.id,row.revision);
   const updated=this.row(row.id);this.audit(updated,{kind:args.action,requestKey:identity?.requestKey??null,reason:args.reason??''});return this.visible(updated);
  });
 }
 // Only a host boot adapter may invoke this; status is never a pump.
 // Adapter insertion and stable request mapping must share this transaction.
 activate(id,{evidence,createOrReconcile,enqueue}={}){
  if(typeof evidence!=='function'||typeof createOrReconcile!=='function'||typeof enqueue!=='function')reject('activation_host_required');
  const result=this.transaction(()=>{
   const row=this.row(id);if(!row)reject('reservation_missing');
   if(!['reserved','activated'].includes(row.state))reject('invalid_transition');
   const intent=JSON.parse(row.intent);
   this.verifyArtifacts(row);
   assertHandoffActivation(intent,evidence(intent,JSON.parse(row.principal)));
   const runId=createOrReconcile({intent,fingerprint:row.fingerprint,botId:row.bot_id,prompt:JSON.parse(row.archive).prompt,existingRunId:row.successor_run_id??null});
   if(!Number.isSafeInteger(runId)||runId<1||(row.successor_run_id!=null&&runId!==row.successor_run_id))reject('successor_mapping_conflict');
   if(row.state!=='activated'){
    this.db.prepare("UPDATE project_handoff_reservations SET state='activated',successor_run_id=?,revision=revision+1 WHERE id=? AND revision=?").run(runId,row.id,row.revision);
    this.audit(this.row(id),{kind:'activated',runId,fingerprint:row.fingerprint});
   }
   return this.visible(this.row(id));
  });
  // Failure here retains the committed mapping for reconciliation, not replay.
  enqueue(result.successorRunId);
  return result;
 }
 verifyArtifacts(row){
  const intent=normalizeHandoffIntent(JSON.parse(row.intent));
  if(handoffFingerprint(intent)!==row.fingerprint||intent.reservationId!==row.id||intent.successorRequestId!==row.request_id)reject('payload_conflict');
  const archive=JSON.parse(row.archive);
  if(!Array.isArray(archive.manifest)||sha(Buffer.from(JSON.stringify(archive.manifest)))!==archive.manifestHash)reject('manifest_readback');
  const pins=[{ref:intent.checkpointRef,sha256:intent.checkpointSha256},...intent.relatedArtifactPins];
  if(archive.manifest.length!==pins.length)reject('archive_mismatch');
  let remaining=2*1024*1024;
  const artifacts=archive.manifest.map((p,index)=>{
   if(p.ref!==pins[index].ref||p.sha256!==pins[index].sha256)reject('archive_mismatch');
   if(sha(safeRead(this.dataDir,p.ref,remaining))!==p.sha256)reject('checkpoint_changed');
   const bytes=safeRead(this.dataDir,p.archiveRef,remaining);remaining-=bytes.length;
   if(bytes.length!==p.size||sha(bytes)!==p.sha256)reject('archive_hash_mismatch');
   return {ref:p.ref,bytes,archiveRef:p.archiveRef};
  });
  // The saved prompt is derived data, not an independent source of instructions.
  // Reconstruct from the immutable intent and exact readback before any insertion.
  if(boundedHandoffContext(intent,artifacts)!==archive.prompt)reject('context_mismatch');
 }
}
