import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { config } from './config.js';
import { protect, unprotect } from './credentials.js';
import { Slots } from './slots.js';
import { UncertainAction } from './action-error.js';
import { redact } from '../redact.js';

export class BrowserGroups {
  constructor({ dataDir, browserType = chromium, protectState = protect, unprotectState = unprotect } = {}) {
    this.root = dataDir; this.browserType = browserType; this.protectState = protectState; this.unprotectState = unprotectState;
    this.pageState = new WeakMap(); this.groups = new Map(); this.opening = new Map(); this.browserPromise = null;
  }
  async browser() {
    if (!this.browserPromise) {
      const c = config().browser;
      this.browserPromise = this.browserType.launch({ headless: c.headless, ...(c.channel ? { channel: c.channel } : {}) })
        .catch(e => { this.browserPromise = null; throw new Error(`Nimbus browser could not start: ${e.message}. Run npm run browser:install.`); });
    }
    return this.browserPromise;
  }
  async group(botId) {
    const id = String(botId);
    if (!/^\d+$/.test(id)) throw new Error('Invalid browser group owner');
    if (this.groups.has(id)) return this.groups.get(id);
    if (this.opening.has(id)) return this.opening.get(id);
    const promise = (async () => {
      if (this.groups.size + this.opening.size >= config().browser.maxGroups) throw new Error('Browser group limit reached');
      const dir = path.join(this.root, 'browser', id); fs.mkdirSync(dir, { recursive: true });
      const stateFile = path.join(dir, 'state.dpapi');
      let storageState;
      if (fs.existsSync(stateFile)) storageState = JSON.parse(await this.unprotectState(fs.readFileSync(stateFile, 'utf8')));
      const context = await (await this.browser()).newContext({ storageState, acceptDownloads: true, viewport: { width: 1280, height: 800 } });
      const group = { id, context, tabs: new Map(), slots: new Slots(1), stateFile };
      context.on('page', page => { if (![...group.tabs.values()].includes(page)) {
        if(group.tabs.size>=config().browser.maxTabsPerGroup){page.close().catch(()=>{});return;}
        group.tabs.set(randomUUID(), page); this.observe(page);
      } });
      this.groups.set(id, group); return group;
    })().finally(() => this.opening.delete(id));
    this.opening.set(id, promise); return promise;
  }
  observe(page) {
    if (this.pageState.has(page)) return this.pageState.get(page);
    const state = { messages: [], dropped: 0, dialog: null, busy: null, wake: null };
    this.pageState.set(page, state);
    const append = (type, value) => {
      if (state.messages.length === 100) { state.messages.shift(); state.dropped++; }
      state.messages.push({ type, text: browserText(value), time: Date.now() });
    };
    page.on('console', msg => append(msg.type(), msg.text()));
    page.on('pageerror', error => append('pageerror', error.message));
    page.on('dialog', dialog => {
      state.dialog = { id: randomUUID(), type: dialog.type(), message: browserText(dialog.message()), handle: dialog };
      state.wake?.();
    });
    page.once('close', () => {
      state.messages.length = 0; state.dialog = null; state.wake?.();
      this.pageState.delete(page);
    });
    return state;
  }
  pending(state) {
    return state.dialog ? [{ id: state.dialog.id, type: state.dialog.type, message: state.dialog.message }] : [];
  }
  async pageTask(page, task) {
    const state = this.observe(page);
    if (task) {
      if (state.busy) throw new Error('Previous browser action is pending; inspect or resolve its dialog before retrying');
      state.busy = Promise.resolve().then(task).then(value => ({ value }), error => ({ error }));
    }
    let wake;
    const changed = new Promise(resolve => { wake = resolve; state.wake = resolve; });
    try {
      if (state.dialog) return { status: 'dialog_pending', pending_dialogs: this.pending(state) };
      if (!state.busy) return { pending_dialogs: [] };
      const result = await Promise.race([state.busy, changed.then(() => null)]);
      if (result === null) {
        if (page.isClosed()) throw new UncertainAction('Tab closed while action pending. Do not replay.');
        return { status: 'dialog_pending', pending_dialogs: this.pending(state) };
      }
      state.busy = null;
      if (result.error) throw result.error;
      return result.value;
    } finally { if (state.wake === wake) state.wake = null; }
  }
  async persist(group) {
    if ([...group.tabs.values()].some(page => this.observe(page).dialog)) throw new UncertainAction('Browser state save deferred by a pending dialog; inspect before retrying the action.');
    const state = await group.context.storageState({ indexedDB: true });
    try{
      const encoded = await this.protectState(JSON.stringify(state));
      fs.writeFileSync(group.stateFile + '.part', encoded, { mode: 0o600 });
      fs.renameSync(group.stateFile + '.part', group.stateFile);
    }catch(e){throw new UncertainAction('Browser action finished but its sign-in state could not be saved. Inspect the page before retrying: '+e.message);}
  }
  async perform(botId, input, { signal } = {}) {
    if (!config().browser.enabled) throw new Error('Browser access is disabled');
    signal?.throwIfAborted();
    if (input.expression !== undefined || input.method !== undefined || ['cdp','exec','evaluate'].includes(input.action)) throw new Error('Arbitrary browser CDP/evaluation is not enabled');
    const group = await this.group(botId);
    return group.slots.use(signal, async () => {
      signal?.throwIfAborted();
      const { action, tabId } = input;
      for (const [id, page] of group.tabs) if (page.isClosed()) group.tabs.delete(id);
      if (action === 'tabs') return { group: group.id, tabs: await Promise.all([...group.tabs].map(async ([id, page]) => ({ id, url: page.url(), title: (this.observe(page).dialog || this.observe(page).busy) ? '(action pending)' : await page.title(), pending_dialogs: this.pending(this.observe(page)) }))) };
      if ([...group.tabs].some(([id, p]) => id !== tabId && this.observe(p).busy) && !['tabs','console','dialog','close','snapshot'].includes(action)) throw new Error('Another tab has an unfinished browser action; resolve it before starting another action');
      if (action === 'open') {
        if (group.tabs.size >= config().browser.maxTabsPerGroup) throw new Error('This worker has reached its tab limit');
        validateUrl(input.url || 'about:blank');
        const page = await group.context.newPage();
        const id = [...group.tabs].find(([, p]) => p === page)?.[0] || randomUUID();
        group.tabs.set(id, page);
        this.observe(page);
        const abortOpen = () => { page.close().catch(() => {}); };
        signal?.addEventListener('abort', abortOpen, { once: true });
        try {
          signal?.throwIfAborted();
          return { group: group.id, tabId: id, ...await this.pageTask(page, async () => {
            await page.goto(input.url || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 45000 });
            await this.persist(group);
            return { url: page.url(), snapshot: (await page.locator('body').ariaSnapshot()).slice(0, 24000) };
          }) };
        } catch (error) {
          if (signal?.aborted) { await page.close().catch(() => {}); throw new UncertainAction('Browser open canceled; tab closed. Do not replay without inspection.'); }
          throw error;
        } finally { signal?.removeEventListener('abort', abortOpen); }
      }
      const page = group.tabs.get(tabId);
      if (!page) throw new Error('That tab does not belong to this worker browser group');
      const abort = () => { page.close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        signal?.throwIfAborted();
        const state = this.observe(page);
        const envelope = result => ({ group: group.id, tabId, ...result });
        if (action === 'console') {
          if (input.clear !== undefined && typeof input.clear !== 'boolean') throw new Error('clear must be boolean');
          const result = { messages: [...state.messages], dropped: state.dropped };
          if (input.clear) { state.messages.length = 0; state.dropped = 0; }
          return envelope(result);
        }
        if (action === 'dialog') {
          if (!['accept','dismiss'].includes(input.dialogAction)) throw new Error('dialogAction must be accept or dismiss');
          if (!state.dialog || input.dialogId !== state.dialog.id) throw new Error('Missing or stale dialogId; inspect pending_dialogs first');
          if (input.promptText !== undefined && (typeof input.promptText !== 'string' || input.promptText.length > 4096)) throw new Error('promptText must be at most 4096 characters');
          const pending = state.dialog; state.dialog = null;
          try {
            if (input.dialogAction === 'accept') await pending.handle.accept(input.promptText || '');
            else await pending.handle.dismiss();
          } catch { throw new UncertainAction('Dialog response outcome unknown; inspect, never replay the response.'); }
          return envelope({ responded: pending.id, ...await this.pageTask(page) });
        }
        if (action === 'snapshot' && (state.dialog || state.busy)) return envelope(await this.pageTask(page));
        if (action === 'close') {
          await page.close(); group.tabs.delete(tabId); await this.persist(group);
          return envelope({ closed: tabId });
        }
        if (state.dialog || state.busy) throw new Error('Resolve pending browser dialog/action before another action');
        return envelope(await this.pageTask(page, async () => {
        const locator = input.role ? page.getByRole(input.role, { name: input.name || '', exact: true })
          : input.text ? page.getByText(input.text, { exact: true }) : page.locator(input.selector || 'body');
        if (action === 'images') {
          const images = await page.locator('img').evaluateAll(elements => elements.slice(0, 500).map(img => ({
            src: (img.currentSrc || img.src || '').slice(0, 4096), alt: (img.alt || '').slice(0, 2048),
            width: img.naturalWidth, height: img.naturalHeight
          })));
          return { images: images.filter(img => /^https?:/i.test(img.src)).map(img => {
            try { const u = new URL(img.src); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return { ...img, src: browserText(u.href), alt: browserText(img.alt) }; }
            catch { return null; }
          }).filter(Boolean), truncated: await page.locator('img').count() > 500, urlPolicy: 'HTTP(S) only; credentials, query and fragment omitted' };
        }
        if (action === 'scroll') {
          if (!['up','down'].includes(input.direction)) throw new Error('direction must be up or down');
          const pixels = input.pixels ?? 500;
          if (!Number.isInteger(pixels) || pixels < 1 || pixels > 2000) throw new Error('pixels must be an integer from 1 to 2000');
          const position = await page.evaluate(delta => {
            window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
            return { x: window.scrollX, y: window.scrollY };
          }, input.direction === 'up' ? -pixels : pixels);
          return { scrolled: input.direction, pixels, position };
        }
        if (action === 'navigate') { validateUrl(input.url); await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
        else if (action === 'click') await locator.click({ timeout: 15000 });
        else if (action === 'fill') await locator.fill(String(input.value ?? ''), { timeout: 15000 });
        else if (action === 'press') await locator.press(input.key, { timeout: 15000 });
        else if (action === 'select') await locator.selectOption(String(input.value), { timeout: 15000 });
        else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
        else if (action === 'screenshot') {
          const dir = path.join(this.root, 'bots', String(botId), 'artifacts'); fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `browser-${Date.now()}.png`); await page.screenshot({ path: file, fullPage: true });
          return { group: group.id, file, tabId };
        } else if (action !== 'snapshot') throw new Error('Unknown browser action');
        await this.persist(group);
        return { group: group.id, tabId, url: page.url(), snapshot: (await page.locator('body').ariaSnapshot()).slice(0, 24000) };
        }));
      } catch (error) {
        if (signal?.aborted) { await page.close().catch(() => {}); throw new UncertainAction('Browser action canceled; tab closed. Effects may have occurred; do not replay.'); }
        throw error;
      } finally { signal?.removeEventListener('abort', abort); }
    });
  }
  snapshot() { return [...this.groups.values()].map(g => ({ owner: Number(g.id), tabs: [...g.tabs].map(([id, page]) => ({ id, url: page.url() })), ...g.slots.snapshot() })); }
  async close() {
    for (const group of this.groups.values()) {
      // Do not ask a modal-blocked renderer to export storage during shutdown.
      if (![...group.tabs.values()].some(page => this.observe(page).dialog || this.observe(page).busy)) {
        try { await this.persist(group); } catch {}
      }
      await group.context.close();
    }
    this.groups.clear();
    if (this.browserPromise) await (await this.browserPromise).close(); this.browserPromise = null;
  }
}
// Defense in depth, not a guarantee that arbitrary page-authored text is secret-free.
function browserText(value) {
  return redact(String(value).slice(0, 16000))
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*:[^\r\n]*/gi, '[sensitive header omitted]')
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, '[sensitive assignment omitted]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
      try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.href; }
      catch { return '[URL omitted]'; }
    }).slice(0, 2048);
}
function validateUrl(url) {
  if (url === 'about:blank') return;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Browser navigation requires an HTTP(S) URL without embedded credentials');
}
