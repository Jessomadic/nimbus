export class Slots {
  constructor(limit = 1) { this.limit = limit; this.active = 0; this.queue = []; }
  acquire(signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const item = { signal, resolve, reject, abort: null };
      item.abort = () => { this.queue = this.queue.filter(x => x !== item); reject(signal.reason || new Error('Cancelled')); };
      signal?.addEventListener('abort', item.abort, { once: true });
      this.queue.push(item); this.drain();
    });
  }
  drain() {
    while (this.active < this.limit && this.queue.length) {
      const item = this.queue.shift();
      item.signal?.removeEventListener('abort', item.abort);
      if (item.signal?.aborted) { item.reject(item.signal.reason); continue; }
      this.active++;
      let released = false;
      item.resolve(() => { if (!released) { released = true; this.active--; this.drain(); } });
    }
  }
  async use(signal, fn) { const release = await this.acquire(signal); try { return await fn(); } finally { release(); } }
  snapshot() { return { active: this.active, queued: this.queue.length, limit: this.limit }; }
}
export const localSlots = new Slots(1);
export const cloudSlots = new Slots(3);
export const workerSlots = new Slots(4);
