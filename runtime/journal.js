import { q, db } from '../db.js';
import {observeFreshCheck} from './fresh-output.js';
import { redact, encodeRedacted } from '../redact.js';
import { broadcast } from '../events.js';
import {UncertainAction} from './action-error.js';
export {UncertainAction} from './action-error.js';
export function event(runId, type, data, publish = broadcast) {
  const body = encodeRedacted(data);
  const result = q('INSERT INTO task_events (run_id,type,body) VALUES (?,?,?)').run(runId, type, body);
  publish('task_event', { id: Number(result.lastInsertRowid), runId, type, data: JSON.parse(body) });
}
export function checkpoint(runId, state) {
  q('UPDATE runs SET checkpoint=? WHERE id=?').run(encodeRedacted(state), runId);
}
export function events(runId) { return q('SELECT * FROM task_events WHERE run_id=? ORDER BY id').all(runId).map(row => ({ ...row, data: JSON.parse(row.body) })); }
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
  let resultReturned = false;
  try {
    const result = await observeFreshCheck({db,runId,callId:key,name,args,signal,execute:async()=>{
      const value = await execute();
      resultReturned = true;
      return value;
    }});
    const encoded = encodeRedacted(result ?? null);
    q("UPDATE tool_calls SET state='done',result=?,ended_at=unixepoch() WHERE id=?").run(encoded, key);
    event(runId, 'tool.completed', { id: key, name, result });
    return JSON.parse(encoded);
  } catch (error) {
    // A timeout, cancellation, transport break or process crash after execution
    // began may have committed its side effect. That is a review boundary.
    // A returned live value cannot be retried when observation, encoding,
    // persistence or publication fails. Do not inspect/emit that value or the
    // serializer exception: either may contain secrets or hostile accessors.
    let result = {error:'Tool outcome could not be safely recorded. Inspect before resuming; no replay.',uncertain:true};
    if (!resultReturned) {
      try {
        const uncertain = error.uncertain === true || error instanceof UncertainAction || signal?.aborted || /timeout|timed out|disconnect|ECONNRESET|fetch failed/i.test(error.message);
        result = JSON.parse(encodeRedacted({ error: error.message, uncertain, ...(error.hostDenied?{denied:true}:{}), ...(error.evidence!==undefined?{evidence:error.evidence}:{}) }));
      } catch {
        // Error metadata can itself be cyclic, BigInt or a throwing getter.
        // Preserve the fixed uncertainty envelope without reading it again.
      }
    }
    const uncertain = result.uncertain;
    q('UPDATE tool_calls SET state=?,result=?,ended_at=unixepoch() WHERE id=?').run(uncertain ? 'uncertain' : 'error', encodeRedacted(result), key);
    event(runId, uncertain ? 'tool.uncertain' : 'tool.failed', { id: key, name, ...result });
    if (uncertain) throw new UncertainAction(result.error,result.evidence);
    return result;
  }
}
