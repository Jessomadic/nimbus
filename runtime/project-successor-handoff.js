// Pure boundary checks shared by host authorization and postboot activation.
// No DB, filesystem, queue, timers or import-time effects.
import {createHash} from 'node:crypto';
export class HandoffError extends Error {
  constructor(code){super(code);this.name='HandoffError';this.code=code;this.statusCode=409;}
}
const fail=code=>{throw new HandoffError(code);};
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&value.length<=200&&/^[a-zA-Z0-9._:-]+$/.test(value);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
function exact(value,keys){if(!object(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('invalid_fields');}
function pin(value){
  exact(value,['ref','sha256']);
  if(typeof value.ref!=='string'||value.ref.length>500||!value.ref.startsWith('shared/')||
    value.ref.includes('\\')||value.ref.includes(':')||value.ref.split('/').some(p=>!p||p==='.'||p==='..')||
    !hash(value.sha256))fail('invalid_pin');
  return {ref:value.ref,sha256:value.sha256};
}
export function normalizeHandoffIntent(input){
  exact(input,['reservationId','project','leaderRunId','checkpointRef','checkpointSha256','relatedArtifactPins','successorRequestId','taskSummary','deployment','continuationPolicy','explicitAdoptionRequestIds','reason']);
  if(!id(input.reservationId)||!id(input.successorRequestId)||!id(input.project)||
    !Number.isSafeInteger(input.leaderRunId)||input.leaderRunId<1)fail('invalid_binding');
  const checkpoint=pin({ref:input.checkpointRef,sha256:input.checkpointSha256});
  const pins=input.relatedArtifactPins??[];
  if(!Array.isArray(pins)||pins.length>32)fail('invalid_pins');
  const relatedArtifactPins=pins.map(pin);
  if(new Set([checkpoint.ref,...relatedArtifactPins.map(p=>p.ref)]).size!==relatedArtifactPins.length+1)fail('duplicate_pin');
  exact(input.deployment,['snapshotId','validatedHash','oldPid']);
  const d=input.deployment;
  if(typeof d.snapshotId!=='string'||!/^[a-f0-9-]{36}$/.test(d.snapshotId)||!hash(d.validatedHash)||!Number.isSafeInteger(d.oldPid)||d.oldPid<1)fail('invalid_deployment');
  if(typeof input.taskSummary!=='string'||!input.taskSummary.trim()||Buffer.byteLength(input.taskSummary)>8192)fail('invalid_summary');
  // Policy is explicit, not inferred from the worker template.
  if(!['none','owner_armed'].includes(input.continuationPolicy))fail('invalid_continuation_policy');
  const adoptions=input.explicitAdoptionRequestIds??[];
  if(!Array.isArray(adoptions)||adoptions.length>16||adoptions.some(v=>!id(v))||new Set(adoptions).size!==adoptions.length)fail('invalid_adoptions');
  if(input.reason!==undefined&&(typeof input.reason!=='string'||input.reason.length>2000))fail('invalid_reason');
  return {reservationId:input.reservationId,project:input.project,leaderRunId:input.leaderRunId,
    checkpointRef:checkpoint.ref,checkpointSha256:checkpoint.sha256,relatedArtifactPins,
    successorRequestId:input.successorRequestId,taskSummary:input.taskSummary,
    deployment:{snapshotId:d.snapshotId,validatedHash:d.validatedHash,oldPid:d.oldPid},
    continuationPolicy:input.continuationPolicy,explicitAdoptionRequestIds:[...adoptions],reason:input.reason??''};
}
export function handoffFingerprint(intent){
  return createHash('sha256').update(JSON.stringify(normalizeHandoffIntent(intent))).digest('hex');
}
export function assertHandoffAuthorization(intent,{principal,leader,project,ownerArmed}={}){
  if(!principal||!['named-owner','local-admin'].includes(principal.kind)||typeof principal.id!=='string'||!principal.id)fail('owner_required');
  if(ownerArmed!==true||project!==intent.project)fail('owner_project_binding');
  if(!leader||leader.id!==intent.leaderRunId||leader.parent_run!=null||leader.template!=='orchestrator'||
    !['running','waiting_tool','waiting_input','waiting_approval','waiting_local','waiting_cloud','paused'].includes(leader.status))fail('inactive_or_invalid_leader');
}
// All values must come from host policy/readback, never worker arguments.
// Missing evidence fails closed. Pure status calls must not call this as a pump.
export function assertHandoffActivation(intent,evidence={}){
  const {receipt,currentPid,currentHash,bootHash,pending,supervised,checkpointHash,policy}=evidence,d=intent.deployment;
  if(supervised!==true||pending!==null)fail('restart_not_settled');
  if(!receipt||receipt.id!==d.snapshotId||receipt.state!=='applied'||
    receipt.validatedHash!==d.validatedHash||receipt.candidate?.hash!==d.validatedHash||
    receipt.bootHash!==d.validatedHash||currentHash!==d.validatedHash||bootHash!==d.validatedHash)fail('deployment_hash_mismatch');
  if(!Number.isSafeInteger(currentPid)||currentPid<1||currentPid===d.oldPid||receipt.pid!==currentPid)fail('deployment_pid_mismatch');
  if(checkpointHash!==intent.checkpointSha256)fail('checkpoint_changed');
  if(!policy||policy.ownerAuthorized!==true||policy.project!==intent.project||
    policy.leaderRunId!==intent.leaderRunId||policy.stopped!==false||policy.sourceHeld!==false||
    policy.uncertain!==false||policy.rejectedApproval!==false||policy.noProgress!==false||
    policy.activeEffects!==false)fail('policy_gate');
}
export function boundedHandoffContext(intent,artifacts){
  if(!Array.isArray(artifacts)||artifacts.length!==intent.relatedArtifactPins.length+1)fail('archive_missing');
  const pins=[{ref:intent.checkpointRef,sha256:intent.checkpointSha256},...intent.relatedArtifactPins];
  let total=0;
  const readback=artifacts.map((artifact,index)=>{
    const p=pins[index];
    if(!object(artifact)||artifact.ref!==p.ref||!Buffer.isBuffer(artifact.bytes))fail('archive_mismatch');
    total+=artifact.bytes.length;
    if(total>2*1024*1024)fail('archive_oversized');
    if(createHash('sha256').update(artifact.bytes).digest('hex')!==p.sha256)fail('archive_hash_mismatch');
    if(artifact.archiveRef!==undefined&&(typeof artifact.archiveRef!=='string'||!/^project-handoffs\/[a-zA-Z0-9-]+\/\d+\.bin$/.test(artifact.archiveRef)))fail('invalid_archive_ref');
    return {ref:p.ref,sha256:p.sha256,...(artifact.archiveRef?{archiveRef:artifact.archiveRef}:{})};
  });
  // Exact evidence stays archived; no old worker history enters these messages.
  const context=JSON.stringify({project:intent.project,leaderRunId:intent.leaderRunId,
    reservationId:intent.reservationId,checkpoint:readback[0],artifacts:readback.slice(1)});
  const prompt=intent.taskSummary+'\nHost-pinned handoff evidence (read before acting):\n'+context;
  if(Buffer.byteLength(prompt)>32768)fail('context_oversized');
  return prompt;
}
