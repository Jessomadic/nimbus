// Mandatory persisted authority check. Missing schema/binding fails closed.
import {config} from './runtime/config.js';
export function assertSchedulerDispatch(db,id){
 if(id==null)return;
 const run=db.prepare('SELECT source FROM runs WHERE id=?').get(Number(id));
 if(run?.source!=='private-scheduler')return;
 if(config().scheduler?.ownedEnabled!==true)throw Error('scheduler_dispatch_denied');
 let b;try{b=db.prepare(`SELECT o.*,p.owner policyOwner,p.held,j.enabled,j.removed,j.definition,j.next currentNext,v.revision currentRevision FROM scheduler_run_bindings b JOIN dispatch_occurrences o ON o.id=b.occurrence AND o.execution=b.execution AND o.job=b.job JOIN dispatch_policy p ON p.job=o.job JOIN jobs j ON j.id=o.job JOIN dispatch_revisions v ON v.job=o.job WHERE b.run_id=? AND o.handle=CAST(b.run_id AS TEXT)`).get(Number(id));}catch{throw Error('scheduler_authority_unavailable');}
 if(!b||b.phase!=='acknowledged'||!b.owner||b.owner!==b.policyOwner||b.held||!b.enabled||b.removed||b.job.startsWith('hermes:')||b.currentRevision!==b.expected_revision||b.currentNext!==b.expected_next||b.definition!==b.expected_definition||JSON.parse(b.definition).imported===true)throw Error('scheduler_dispatch_denied');
}
