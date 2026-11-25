// Host-internal only. Never register this API as a model tool.
// The backend must implement held-handle identity/ACL checks and trusted
// CurrentUser enrollment. No fallback to credentials.js or process.env.
import {createHash} from 'node:crypto';
const failure = () => new Error('Protected connector credential unavailable');
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
function record(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype ||
      Object.keys(v).some(k => !keys.includes(k))) throw failure();
}
function validate(e) {
  record(e,['sourceId','ownerId','ownerSid','profileId','server','workerIds','purpose','transportId','destination','envKey','origin','revision','enabled']);
  for (const k of ['sourceId','ownerId','profileId','server','purpose','transportId']) if (!id(e[k])) throw failure();
  if (typeof e.ownerSid !== 'string' || !/^S-1-(?:\d+-)+\d+$/.test(e.ownerSid) ||
      !Number.isSafeInteger(e.revision) || e.revision < 1 || typeof e.enabled !== 'boolean' ||
      !Array.isArray(e.workerIds) || !e.workerIds.length || new Set(e.workerIds).size !== e.workerIds.length ||
      e.workerIds.some(v => !Number.isSafeInteger(v) || v < 1)) throw failure();
  if (e.destination === 'stdio-env') {
    if (!/^[A-Z_][A-Z0-9_]{0,99}$/.test(e.envKey || '') || e.origin !== undefined) throw failure();
  } else if (e.destination === 'http-bearer') {
    const u = new URL(e.origin);
    if (u.protocol !== 'https:' || u.origin !== e.origin || e.envKey !== undefined) throw failure();
  } else throw failure();
}
function validBytes(b) {
  return Buffer.isBuffer(b) && b.length >= 24 && b.length <= 65536 &&
    b.every(n => n >= 33 && n <= 126);
}
export function createConnectorCredentialResolver({backend, authorize, identity, timeoutMs = 5000} = {}) {
  if (typeof authorize !== 'function' || typeof identity !== 'function' ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) throw failure();
  const entries = new Map(), pending = new Set();
  let epoch = 0, closed = false;
  function invalidate() {
    epoch++;
    for (const controller of pending) controller.abort();
  }
  // Enrollment metadata is supplied exclusively by trusted host code, not tools/config imports.
  function replace(records) {
    try {
      if (closed || !Array.isArray(records) || records.length > 1000) throw failure();
      const next = new Map();
      for (const raw of records) {
        validate(raw);
        if (next.has(raw.sourceId)) throw failure();
        next.set(raw.sourceId, structuredClone(raw));
      }
      invalidate(); entries.clear();
      for (const [k,v] of next) entries.set(k,v);
    } catch { throw failure(); }
  }
  async function use(reference, request, consume, {signal} = {}) {
    let timer, bytes, controller;
    try {
      record(reference,['sourceId','destination']);
      record(request,['ownerId','profileId','server','workerId','purpose','transportId','origin','envKey','tool']);
      reference = structuredClone(reference); request = structuredClone(request);
      if (!id(reference.sourceId) || typeof consume !== 'function' || closed || signal?.aborted) throw failure();
      const e = entries.get(reference.sourceId), generation = epoch;
      const allowed = () => {
        if (closed || generation !== epoch || signal?.aborted || !e?.enabled ||
            reference.destination !== e.destination || request.ownerId !== e.ownerId ||
            request.profileId !== e.profileId || request.server !== e.server ||
            request.purpose !== e.purpose || !e.workerIds.includes(request.workerId) ||
            request.transportId !== e.transportId || !id(request.tool) ||
            request.origin !== e.origin || request.envKey !== e.envKey) return false;
        const who = identity();
        // Identity and authorization are synchronous host policy, never a truthy Promise.
        return who?.ownerId === e.ownerId && who?.profileId === e.profileId &&
          who?.ownerSid === e.ownerSid && authorize(structuredClone(request)) === true;
      };
      if (!allowed() || typeof backend?.read !== 'function') throw failure();
      controller = new AbortController(); pending.add(controller);
      const abort = () => controller.abort();
      signal?.addEventListener('abort',abort,{once:true});
      let removeAbort = () => signal?.removeEventListener('abort',abort);
      try {
        const rejected = new Promise((_,reject) => {
          controller.signal.addEventListener('abort',() => reject(failure()),{once:true});
          timer = setTimeout(() => controller.abort(),timeoutMs);
        });
        const read = Promise.resolve().then(() => {
          if (controller.signal.aborted) throw failure();
          return backend.read(structuredClone(e),{signal:controller.signal});
        }).then(value => {
          let accepted = false;
          try {
            accepted = !controller.signal.aborted && allowed();
            if (!accepted) throw failure();
            return value;
          } finally { if (!accepted && Buffer.isBuffer(value)) value.fill(0); }
        });
        bytes = await Promise.race([read,rejected]);
        if (!validBytes(bytes) || !allowed()) throw failure();
        // No await between final policy check and trusted transport injection.
        // Callback must not return credential material; resolver never returns its result.
        await Promise.race([Promise.resolve(consume(bytes, {
          signal:controller.signal,
          identity:createHash('sha256').update(JSON.stringify([e.sourceId,e.revision,generation,request])).digest('hex')
        })),rejected]);
        if (!allowed() || controller.signal.aborted) throw failure();
      } finally { removeAbort(); }
    } catch { throw failure(); }
    finally {
      clearTimeout(timer);
      controller?.abort(); pending.delete(controller);
      if (Buffer.isBuffer(bytes)) bytes.fill(0);
    }
  }
  return Object.freeze({replace,use,close() { closed = true; invalidate(); entries.clear(); }});
}
