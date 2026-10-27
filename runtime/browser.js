import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { config } from './config.js';
import { protect, unprotect } from './credentials.js';
import { Slots } from './slots.js';
import { UncertainAction } from './journal.js';

export class BrowserGroups {
  constructor({ dataDir, browserType = chromium, protectState = protect, unprotectState = unprotect } = {}) {
    this.root = dataDir; this.browserType = browserType; this.protectState = protectState; this.unprotectState = unprotectState;
    this.groups = new Map(); this.opening = new Map(); this.browserPromise = null;
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
        group.tabs.set(randomUUID(), page);
      } });
      this.groups.set(id, group); return group;
    })().finally(() => this.opening.delete(id));
    this.opening.set(id, promise); return promise;
  }
  async persist(group) {
    const state = await group.context.storageState({ indexedDB: true });
    try{
      const encoded = await this.protectState(JSON.stringify(state));
      fs.writeFileSync(group.stateFile + '.part', encoded, { mode: 0o600 });
      fs.renameSync(group.stateFile + '.part', group.stateFile);
    }catch(e){throw new UncertainAction('Browser action finished but its sign-in state could not be saved. Inspect the page before retrying: '+e.message);}
  }
  async perform(botId, input, { signal } = {}) {
    if (!config().browser.enabled) throw new Error('Browser access is disabled');
    const group = await this.group(botId);
    return group.slots.use(signal, async () => {
      signal?.throwIfAborted();
      const { action, tabId } = input;
      for (const [id, page] of group.tabs) if (page.isClosed()) group.tabs.delete(id);
      if (action === 'tabs') return { group: group.id, tabs: await Promise.all([...group.tabs].map(async ([id, page]) => ({ id, url: page.url(), title: await page.title() }))) };
      if (action === 'open') {
        if (group.tabs.size >= config().browser.maxTabsPerGroup) throw new Error('This worker has reached its tab limit');
        validateUrl(input.url || 'about:blank');
        const page = await group.context.newPage();
        const id = [...group.tabs].find(([, p]) => p === page)?.[0] || randomUUID();
        group.tabs.set(id, page);
        await page.goto(input.url || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await this.persist(group);
        return { group: group.id, tabId: id, url: page.url(), snapshot: (await page.locator('body').ariaSnapshot()).slice(0, 24000) };
      }
      const page = group.tabs.get(tabId);
      if (!page) throw new Error('That tab does not belong to this worker browser group');
      const abort = () => { page.close().catch(() => {}); };
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const locator = input.role ? page.getByRole(input.role, { name: input.name || '', exact: true })
          : input.text ? page.getByText(input.text, { exact: true }) : page.locator(input.selector || 'body');
        if (action === 'navigate') { validateUrl(input.url); await page.goto(input.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
        else if (action === 'click') await locator.click({ timeout: 15000 });
        else if (action === 'fill') await locator.fill(String(input.value ?? ''), { timeout: 15000 });
        else if (action === 'press') await locator.press(input.key, { timeout: 15000 });
        else if (action === 'select') await locator.selectOption(String(input.value), { timeout: 15000 });
        else if (action === 'back') await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
        else if (action === 'close') { await page.close(); group.tabs.delete(tabId); await this.persist(group); return { closed: tabId, group: group.id }; }
        else if (action === 'screenshot') {
          const dir = path.join(this.root, 'bots', String(botId), 'artifacts'); fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, `browser-${Date.now()}.png`); await page.screenshot({ path: file, fullPage: true });
          return { group: group.id, file, tabId };
        } else if (action !== 'snapshot') throw new Error('Unknown browser action');
        await this.persist(group);
        return { group: group.id, tabId, url: page.url(), snapshot: (await page.locator('body').ariaSnapshot()).slice(0, 24000) };
      } finally { signal?.removeEventListener('abort', abort); }
    });
  }
  snapshot() { return [...this.groups.values()].map(g => ({ owner: Number(g.id), tabs: [...g.tabs].map(([id, page]) => ({ id, url: page.url() })), ...g.slots.snapshot() })); }
  async close() {
    for (const group of this.groups.values()) { try { await this.persist(group); } catch {} await group.context.close(); }
    this.groups.clear();
    if (this.browserPromise) await (await this.browserPromise).close(); this.browserPromise = null;
  }
}
function validateUrl(url) {
  if (url === 'about:blank') return;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Browser navigation requires an HTTP(S) URL without embedded credentials');
}
