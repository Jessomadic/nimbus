// Host-owned fixed synthetic fixture. No production state, activation or queue imports.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HandoffReservations} from './handoff-reservations.js';
export const profile='project-successor-status-v1';
export function handoffVerification({db,dataDir,signal}) {
 signal?.throwIfAborted();
 const bytes=Buffer.from('Synthetic isolated handoff verification checkpoint');
 fs.mkdirSync(path.join(dataDir,'shared'),{recursive:true});
 fs.writeFileSync(path.join(dataDir,'shared','verification.md'),bytes,{flag:'wx'});
 db.prepare("INSERT INTO bots(id,name,template) VALUES(1,'Synthetic verification','orchestrator')").run();
 db.prepare("INSERT INTO runs(id,bot_id,status,parent_run) VALUES(1,1,'paused',NULL)").run();
 const store=new HandoffReservations({db,dataDir,authority:()=>({leader:db.prepare('SELECT r.*,b.template FROM runs r JOIN bots b ON b.id=r.bot_id WHERE r.id=1').get(),project:'synthetic-verification',ownerArmed:true})});
 store.authorize({reservationId:'synthetic-status',successorRequestId:'synthetic-successor',project:'synthetic-verification',leaderRunId:1,checkpointRef:'shared/verification.md',checkpointSha256:createHash('sha256').update(bytes).digest('hex'),taskSummary:'Synthetic verification only',deployment:{snapshotId:'00000000-0000-0000-0000-000000000001',validatedHash:'a'.repeat(64),oldPid:1},continuationPolicy:'none'}, {kind:'local-admin',id:'isolated-host'});
 return {args:{action:'status',reservationId:'synthetic-status'},context:{runId:1,projectSuccessorHandoff:args=>{
  signal?.throwIfAborted();
  if(args.action!=='status'||args.reservationId!=='synthetic-status'||Object.keys(args).length!==2)throw Error('Synthetic profile is status-only');
  return store.status(args.reservationId,{runId:1,botId:1,requestKey:'synthetic:status'});
 }}};
}
