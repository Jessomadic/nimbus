import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {artifactDirectory} from './helpers/artifact-directory.mjs';
import {chromium, webkit} from 'playwright';

const publicRoot = new URL('../public/', import.meta.url);
const action = (tool, input, state = 'done') => ({id: tool, tool, text: `${tool}(${JSON.stringify(input).slice(0, 120)})`, state});
const body = {
  status: 'running', started: Date.now() - 50000, model: 'gpt-6.1-sol',
  plan: {steps: [{step: 'Recover complete owner work order and milestone evidence', status: 'in_progress'}, {step: 'Review compatibility and validate the result', status: 'pending'}]},
  steps: [action('team_status', {includeRecent: true, limit: 30, runLimit: 3}), action('task_history', {runId: 344, limit: 15, maxChars: 26000}), action('tool_catalog', {query: 'read_file', details: true, limit: 5}), action('ask_worker', {to: '3', task: 'Retrieve the complete work order and canonical milestone evidence without changing project files. '.repeat(3)}), action('self_update', {action: 'status'}), action('worker_result', {runId: 353}), action('update_plan', {steps: [{step: 'Review compatibility', status: 'in_progress'}]}), action('read_file', {path: 'F:\\Nimbus\\README.md'}), action('run_checks', {runner: 'node_test'}, 'running')]
};
const bot = (id, name, template, display_group = '') => ({id, name, template, display_group, parent_bot_id: id === 1 ? null : 1, is_orchestrator: id === 1, role: 'Fixture worker', plugins: [], status: {state: 'idle'}, color: '#b39dff', effort: 'high'});
const history = id => [...Array.from({length: 38}, (_, index) => ({id: id * 1000 + index, thread: 'bot:' + id, author: index % 2 ? id : 'user', kind: 'text', body: `Earlier message ${index}: ` + 'Retained project context for this conversation. '.repeat(6), created_at: 1793210000 + index})), ...(id === 1 ? [{id: 1100, thread: 'bot:1', author: 1, kind: 'trace', run_id: 344, body: JSON.stringify(body), created_at: 1793210040}] : []), {id: id * 1000 + 200, thread: 'bot:' + id, author: id, kind: 'text', body: 'Newest message for worker ' + id, created_at: 1793210041}];
const atBottom = page => page.waitForFunction(() => { const el = document.querySelector('#thread'); return el && el.scrollHeight > el.clientHeight + 500 && el.scrollHeight - el.scrollTop - el.clientHeight <= 2; });
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

for (const [name, engine] of Object.entries({chromium, webkit})) test(name + ' activity details and asynchronous chat scrolling work on desktop and mobile without moving a reader in history', {timeout: 60000}, async () => {
  const browser = await engine.launch({headless: true});
  try {
    const artifacts = process.env.NIMBUS_CHAT_ARTIFACTS ? artifactDirectory('chat-presentation',{exportRoot:process.env.NIMBUS_CHAT_ARTIFACTS}) : null;
    for (const [width, height] of [[1280, 900], [390, 844], [320, 568]]) {
      const page = await browser.newPage({viewport: {width, height}, isMobile: width <= 760, hasTouch: width <= 760, serviceWorkers: 'block'});
      page.setDefaultTimeout(7000);
      const errors = [], mutations = [], reads = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.EventSource = class extends EventTarget {
          constructor() { super(); window.nimbusTestEvents = this; }
          close() {}
        };
      });
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      const histories = {1: history(1), 2: history(2), 3: history(3)};
      const state = {bots: [bot(1, 'Orchestrator', 'orchestrator'), bot(2, 'Builder', 'builder', 'engineering'), bot(3, 'Knowledge Curator', 'knowledge-curator', 'research')], rooms: [], last: {}, routines: [], upNext: [], learned: [], approvals: [], computers: [], usage: {}, settings: {}};
      await page.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.hostname !== 'nimbus.test') return route.abort();
        if (url.pathname.startsWith('/api/')) {
          if (request.method() !== 'GET') mutations.push(url.pathname);
          reads.push(url.pathname);
          const thread = decodeURIComponent(url.pathname).match(/^\/api\/threads\/bot:(\d+)\/messages$/);
          if (thread) { await gate; return route.fulfill({json: histories[thread[1]]}); }
          return route.fulfill({json: url.pathname === '/api/state' ? state : url.pathname === '/api/runs/353' ? {id: 353, bot_id: 3} : {}});
        }
        try {
          const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1), data = await readFile(new URL(file, publicRoot));
          return route.fulfill({body: data, contentType: ({html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp'})[file.split('.').at(-1)] || 'application/octet-stream'});
        } catch { return route.fulfill({status: 404, body: 'Not found'}); }
      });
      await page.goto('http://nimbus.test/#bot:1');
      await page.getByText('Loading…', {exact: true}).waitFor();
      release();
      await page.getByText('Newest message for worker 1', {exact: true}).waitFor();
      await atBottom(page);
      const summaries = page.locator('.trace-call > summary');
      assert.match(await summaries.nth(0).innerText(), /Checking team progress and recent work/);
      assert.match(await summaries.nth(1).innerText(), /Reviewing task #344’s history/);
      assert.match(await summaries.nth(3).innerText(), /Handing off work: Retrieve the complete work order/);
      await page.waitForFunction(() => [...document.querySelectorAll('.trace-worker')].filter(el => el.textContent.includes('Knowledge Curator')).length === 2);
      assert.doesNotMatch(await summaries.allInnerTexts().then(text => text.join('\n')), /task_history\(|maxChars|runLimit/);
      assert.equal(await page.locator('.trace .mark.done').count(), 8);
      assert.equal(await page.locator('.trace .mark.running').count(), 1);
      assert.equal(await page.locator('.task-plan li').count(), 2);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (artifacts) await page.locator('.trace').screenshot({path: artifacts + '/activity-' + name + '-' + width + '.png'});
      const retainedTrace = histories[1].find(row => row.kind === 'trace');
      const hostileBody = structuredClone(body);
      hostileBody.steps[7] = action('read_file', {path: '<img src=x onerror="window.traceInjected=true">'});
      await page.evaluate(message => window.nimbusTestEvents.dispatchEvent(new MessageEvent('message_update', {data: JSON.stringify(message)})), {...retainedTrace, body: JSON.stringify(hostileBody)});
      assert.match(await summaries.nth(7).innerText(), /<img src=x/);
      assert.equal(await page.locator('.trace-call img').count(), 0);
      assert.equal(await page.evaluate(() => !!window.traceInjected), false);
      await page.evaluate(message => window.nimbusTestEvents.dispatchEvent(new MessageEvent('message_update', {data: JSON.stringify(message)})), retainedTrace);
      const details = page.locator('.trace-call').nth(1);
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      await details.locator('pre').waitFor({state: 'visible'});
      assert.equal(await details.locator('pre').innerText(), 'task_history({"runId":344,"limit":15,"maxChars":26000})');
      await settled(page);
      await page.evaluate(message => window.nimbusTestEvents.dispatchEvent(new MessageEvent('message_update', {data: JSON.stringify(message)})), histories[1].find(row => row.kind === 'trace'));
      assert.equal(await details.getAttribute('open'), '');
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      await page.locator('#thread').evaluate(el => { el.scrollTop = el.scrollHeight; });
      await settled(page);
      // Simulate an attachment taking its final size after the first render.
      await page.locator('.thread-inner > .msg').last().evaluate(el => { el.style.minHeight = '440px'; });
      await atBottom(page);
      await page.locator('#thread').evaluate(el => { el.scrollTop = 450; });
      await settled(page);
      const readerTop = await page.locator('#thread').evaluate(el => el.scrollTop);
      const next = {id: 1400, thread: 'bot:1', author: 1, kind: 'text', body: 'Another live progress update', created_at: 1793210042};
      histories[1].push(next);
      await page.evaluate(message => window.nimbusTestEvents.dispatchEvent(new MessageEvent('message', {data: JSON.stringify(message)})), next);
      await settled(page);
      assert.ok(Math.abs(await page.locator('#thread').evaluate(el => el.scrollTop) - readerTop) < 2, 'live update preserves the reader position');
      histories[1].push({id: 1401, thread: 'bot:1', author: 1, kind: 'text', body: 'History refreshed after reconnect', created_at: 1793210043});
      await page.evaluate(() => window.nimbusTestEvents.onopen?.());
      await page.getByText('History refreshed after reconnect', {exact: true}).waitFor({state: 'attached'});
      await settled(page);
      assert.ok(Math.abs(await page.locator('#thread').evaluate(el => el.scrollTop) - readerTop) < 2, 'reconnect preserves the reader position');
      for (const id of [2, 1]) {
        await page.evaluate(id => { location.hash = 'bot:' + id; }, id);
        await page.getByText('Newest message for worker ' + id, {exact: true}).waitFor({state: 'attached'});
        await atBottom(page);
      }
      if (artifacts) await page.screenshot({path: artifacts + '/chat-bottom-' + name + '-' + width + '.png'});
      assert.equal(reads.filter(path => path === '/api/runs/353').length, 1, 'worker lookup remains deduplicated');
      assert.deepEqual(mutations, []);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});
