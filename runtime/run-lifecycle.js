// Execution ownership is maintained by the host queue, never inferred from age.
// Reconciliation retires orphan status only; it cannot replay or approve actions.
export function reconcileOrphanRuns({db,query,ownedRunIds,event,limit=100}) {
  if (!(ownedRunIds instanceof Set) || [...ownedRunIds].some(id=>!Number.isSafeInteger(id)||id<1) || !Number.isSafeInteger(limit) || limit<1 || limit>1000) throw new Error('A host ownership set and bounded reconciliation limit are required');
  const active=['queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input'];
  const owned=[...ownedRunIds],filter=owned.length?` AND id NOT IN (${owned.map(()=>'?').join(',')})`:'';
  const rows=query(`SELECT id,status FROM runs WHERE status IN (${active.map(()=>'?').join(',')})${filter} ORDER BY id LIMIT ?`).all(...active,...owned,limit);
  if(!rows.length)return [];
  const repaired=[];
  db.exec('BEGIN IMMEDIATE');
  try {
    for(const run of rows){
      if(ownedRunIds.has(Number(run.id)))continue;
      if(repaired.length>=limit)break;
      const unresolved=!!query("SELECT id FROM tool_calls WHERE run_id=? AND state IN ('running','uncertain') LIMIT 1").get(run.id);
      const status=unresolved||['waiting_approval','waiting_input'].includes(run.status)?'needs_review':'interrupted';
      const reason='No host queue or execution owns this task. Checkpoint and action evidence retained; no action was replayed or marked successful.';
      const changed=query('UPDATE runs SET status=?,last_error=?,ended_at=unixepoch() WHERE id=? AND status=?').run(status,reason,run.id,run.status);
      if(changed.changes){
        const evidence={from:run.status,status,reason,unresolvedActions:unresolved};
        event(run.id,'task.orphan_reconciled',evidence);repaired.push({id:Number(run.id),...evidence});
      }
    }
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return repaired;
}
