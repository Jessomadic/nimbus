export function restartDrainStatus({ q, queues, terminals }) {
  const tasks = Number(q("SELECT count(*) AS n FROM runs WHERE status IN ('queued','routing','running','waiting_local','waiting_cloud','waiting_approval','waiting_input')").get().n);
  // Uncertainty is a replay/recovery HOLD, not evidence of executing work.
  // Live owners remain covered independently by runs, worker queues and terminals.
  // Do not settle or otherwise mutate retained journal outcomes here.
  const effects = Number(q("SELECT count(*) AS n FROM tool_calls WHERE state = 'running'").get().n);
  const workers = queues().workers;
  const counts = { tasks, effects, activeWorkers: Number(workers.active), queuedWorkers: Number(workers.queued), activeTerminals: terminals.active().length };
  if (Object.values(counts).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid drain counts');
  return { ready: Object.values(counts).every(n => n === 0), counts };
}
export function restartDrainTick({ read, assertSource, restart, hold }) {
  const first = read();
  if (!first.ready) { hold(first.counts); return false; }
  assertSource();
  const final = read();
  if (!final.ready) { hold(final.counts); return false; }
  restart();
  return true;
}
