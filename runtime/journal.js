import { q } from '../db.js';
import { redact, encodeRedacted } from '../redact.js';
import { broadcast } from '../events.js';
export function event(runId, type, data) {
  const body = encodeRedacted(data);
  const result = q('INSERT INTO task_events (run_id,type,body) VALUES (?,?,?)').run(runId, type, body);
  broadcast('task_event', { id: Number(result.lastInsertRowid), runId, type, data: JSON.parse(body) });
}
export function checkpoint(runId, state) {
  q('UPDATE runs SET checkpoint=? WHERE id=?').run(encodeRedacted(state), runId);
}
export function events(runId) { return q('SELECT * FROM task_events WHERE run_id=? ORDER BY id').all(runId).map(row => ({ ...row, data: JSON.parse(row.body) })); }
export class UncertainAction extends Error { constructor(message) { super(message); this.name = 'UncertainAction'; } }
export async function journalTool({ id, runId, name, args, execute, signal }) {
  const key = `${runId}:${id}`;
  const prev = q('SELECT * FROM tool_calls WHERE id=?').get(key);
  if (prev) {
    if (prev.name !== name || prev.args !== encodeRedacted(args)) throw new UncertainAction('A tool call ID was reused with different arguments.');
    if (prev.state === 'done' || prev.state === 'error') return JSON.parse(prev.result);
    throw new UncertainAction(`The outcome of ${name} is uncertain. Inspect it before resuming; it has not been replayed.`);
  }
  signal?.throwIfAborted();
  q('INSERT INTO tool_calls (id,run_id,name,args,state) VALUES (?,?,?,?,?)').run(key, runId, name, encodeRedacted(args), 'running');
  event(runId, 'tool.started', { id: key, name, args });
  try {
    const result = await execute();
    const encoded = encodeRedacted(result ?? null);
    q("UPDATE tool_calls SET state='done',result=?,ended_at=unixepoch() WHERE id=?").run(encoded, key);
    event(runId, 'tool.completed', { id: key, name, result });
    return JSON.parse(encoded);
  } catch (error) {
    // A timeout, cancellation, transport break or process crash after execution
    // began may have committed its side effect. That is a review boundary.
    const uncertain = error instanceof UncertainAction || signal?.aborted || /timeout|timed out|disconnect|ECONNRESET|fetch failed/i.test(error.message);
    const result = { error: error.message, uncertain };
    q('UPDATE tool_calls SET state=?,result=?,ended_at=unixepoch() WHERE id=?').run(uncertain ? 'uncertain' : 'error', encodeRedacted(result), key);
    event(runId, uncertain ? 'tool.uncertain' : 'tool.failed', { id: key, name, ...result });
    if (uncertain) throw new UncertainAction(error.message);
    return result;
  }
}
