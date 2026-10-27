import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual login module's event handlers against the IDs and controls
// in the actual login HTML. Only browser plumbing and HTTP responses are fake;
// no server, network, production data or device credential APIs are used.
const loginHTML = fs.readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const loginSource = fs.readFileSync(new URL('../public/passkeys.js', import.meta.url), 'utf8');
const origin = 'https://nimbus-ui.example.invalid';
const ticket = 'a'.repeat(64);
const password = 'synthetic-ui-password-only';
const credential = { id: 'synthetic-device-credential', type: 'public-key', response: { clientDataJSON: 'synthetic-response' } };
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(condition, description) {
  for (let turn = 0; turn < 100; turn++) {
    if (condition()) return;
    await tick();
  }
  assert.fail(description);
}

class Element {
  constructor(tag, attributes = {}) {
    this.tagName = tag.toLowerCase();
    this.attributes = { ...attributes };
    this.id = attributes.id;
    this.type = attributes.type || '';
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.disabled = Object.hasOwn(attributes, 'disabled');
    this.value = attributes.value || '';
    this.textContent = '';
    this.dataset = Object.fromEntries(Object.entries(attributes).filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, character) => character.toUpperCase()), value]));
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { this.focused = true; }
  async dispatch(type) {
    // Dispatch can intentionally bypass a disabled control, checking the JS busy
    // guard as well as the disabled state a real browser would enforce.
    const event = { type, target: this, preventDefault() { this.defaultPrevented = true; } };
    await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
  }
  async click() { if (!this.disabled) await this.dispatch('click'); }
}

function controls() {
  const markup = loginHTML.match(/<form\b[^>]*>[\s\S]*?<\/form>/i)?.[0];
  assert.ok(markup, 'The real login HTML must contain its form');
  const elements = [...markup.matchAll(/<([a-z][\w-]*)\b([^<>]*)>/gi)].map(([, tag, text]) => {
    const attributes = {};
    for (const [, name, quoted, single, bare] of text.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attributes[name] = quoted ?? single ?? bare ?? '';
    return new Element(tag, attributes);
  });
  const byID = new Map(elements.filter(element => element.id).map(element => [element.id, element]));
  const form = elements.find(element => Object.hasOwn(element.attributes, 'data-nimbus-login'));
  assert.ok(form, 'The real login form must declare its module entry point');
  const match = (element, selector) => {
    if (selector === 'button') return element.tagName === 'button';
    if (selector === '[data-mode]') return Object.hasOwn(element.attributes, 'data-mode');
    if (selector === 'input[type="password"]') return element.tagName === 'input' && element.type === 'password';
    const mode = selector.match(/^\[data-mode="([^"]+)"\]$/);
    if (mode) return element.dataset.mode === mode[1];
    throw new Error('Unsupported fake-DOM selector: ' + selector);
  };
  form.querySelectorAll = selector => elements.filter(element => match(element, selector));
  form.querySelector = selector => form.querySelectorAll(selector)[0] || null;
  return { form, byID, elements };
}

function harness({ registration = true, href = origin + '/login', login, browser, verify, options } = {}) {
  const { form, byID, elements } = controls();
  const requests = [], ceremonies = [], navigations = [], scripts = [], historyChanges = [];
  const location = { href, origin: new URL(href).origin, hostname: new URL(href).hostname, assign(value) { navigations.push(value); } };
  const document = {
    querySelector(selector) {
      assert.equal(selector, '[data-nimbus-login]');
      return form;
    },
    getElementById(id) {
      assert.ok(byID.has(id), `The real login markup must provide #${id}`);
      return byID.get(id);
    },
    createElement(tag) { return new Element(tag); },
    head: { append(element) { scripts.push(element); throw new Error('A browser library must be stubbed; no script may load in UI tests'); } },
  };
  const methods = { username: true, password: true, accounts: false, signup: false, passkeyRequired: true, passkeyOrigin: origin };
  const browserOptions = { challenge: 'synthetic-server-challenge', rpId: 'nimbus-ui.example.invalid' };
  const fetch = async (url, configuration = {}) => {
    const request = { url, method: configuration.method || 'GET', body: configuration.body ? JSON.parse(configuration.body) : undefined, configuration };
    requests.push(request);
    let result;
    if (url === '/api/auth-methods') result = methods;
    else if (url === '/api/login') result = login ? await login(request) : { passkeyRequired: true, ticket, enrollmentRequired: registration };
    else if (/^\/api\/passkeys\/(?:registration|authentication)\/options$/.test(url)) result = options ? await options(request) : browserOptions;
    else if (/^\/api\/passkeys\/(?:registration|authentication)\/verify$/.test(url)) result = verify ? await verify(request) : { ok: true };
    else assert.fail('The login UI attempted an unexpected or fallback endpoint: ' + url);
    const status = result?.httpStatus || 200;
    const data = result?.httpStatus ? result.data : result;
    return { ok: status >= 200 && status < 300, status, json: async () => clone(data) };
  };
  const invoke = kind => async args => {
    ceremonies.push({ kind, args: clone(args) });
    return browser ? browser(kind, args, ceremonies.length) : clone(credential);
  };
  const context = {
    URL, document, location, fetch,
    history: { state: null, replaceState(state, unused, value) { historyChanges.push(value); location.href = new URL(value, location.href).href; } },
    navigator: { credentials: { create() { assert.fail('Native credential creation is forbidden in UI tests'); }, get() { assert.fail('Native credential authentication is forbidden in UI tests'); } } },
    isSecureContext: true, PublicKeyCredential: function SyntheticPublicKeyCredential() {},
    SimpleWebAuthnBrowser: { startRegistration: invoke('registration'), startAuthentication: invoke('authentication') },
    localStorage: { getItem() { assert.fail('Enrollment data must not enter storage'); }, setItem() { assert.fail('Enrollment data must not enter storage'); } },
    sessionStorage: { getItem() { assert.fail('Enrollment data must not enter storage'); }, setItem() { assert.fail('Enrollment data must not enter storage'); } },
  };
  // Removing declaration-only export keywords lets Node's standard VM evaluate
  // the unchanged module body without enabling experimental VM module support.
  vm.runInNewContext(loginSource.replace(/^export\s+/gm, ''), context, { filename: 'public/passkeys.js', timeout: 1000 });
  return {
    form, elements, nodes: Object.fromEntries(byID), requests, ceremonies, navigations, scripts, historyChanges, location, browserOptions,
    ready: async () => until(() => form.getAttribute('aria-busy') === 'false', 'The login UI did not finish loading its methods'),
    submit() {
      byID.get('username').value = 'SyntheticOwner';
      byID.get('upw').value = password;
      return form.dispatch('submit');
    },
  };
}

test('anonymous page load and retry clicks cannot start a passkey ceremony', async () => {
  const ui = harness();
  await ui.ready();
  assert.deepEqual(ui.requests.map(request => request.url), ['/api/auth-methods']);
  assert.equal(ui.nodes.userbox.hidden, false);
  assert.equal(ui.nodes.passkeybox.hidden, true);
  assert.equal(ui.nodes.username.value, '', 'The configured username must not appear as a public hint');
  assert.equal(ui.nodes.username.attributes.autocomplete, 'username');
  await ui.nodes['passkey-go'].dispatch('click');
  assert.deepEqual(ui.ceremonies, []);
  assert.deepEqual(ui.navigations, []);
  assert.deepEqual(ui.scripts, []);
  assert.deepEqual(ui.requests.map(request => request.url), ['/api/auth-methods']);
});

for (const registration of [true, false]) {
  test(`${registration ? 'registration' : 'authentication'} starts automatically after credential submission and clears passwords`, async () => {
    const prompt = deferred();
    const ui = harness({ registration, browser: () => prompt.promise });
    await ui.ready();
    const signingIn = ui.submit();
    await until(() => ui.ceremonies.length === 1, 'Submitting credentials did not automatically start the device step');
    const ceremony = registration ? 'registration' : 'authentication';
    assert.equal(ui.ceremonies[0].kind, ceremony);
    assert.deepEqual(ui.ceremonies[0].args, { optionsJSON: ui.browserOptions });
    assert.deepEqual(ui.requests.find(request => request.url === '/api/login').body, { username: 'SyntheticOwner', password });
    assert.deepEqual(ui.requests.find(request => request.url.endsWith('/options')).body, { ticket });
    assert.equal(ui.nodes.passkeybox.hidden, false);
    assert.equal(ui.nodes.userbox.hidden, true);
    for (const field of ui.elements.filter(element => element.type === 'password')) assert.equal(field.value, '', 'Password fields must be cleared before the device prompt completes');
    assert.equal(ui.nodes['passkey-go'].disabled, true);
    assert.equal(ui.form.getAttribute('aria-busy'), 'true');
    assert.deepEqual(ui.navigations, [], 'A pending device prompt cannot complete sign-in');
    assert.equal(ui.requests.filter(request => request.url.endsWith('/verify')).length, 0);
    prompt.resolve(clone(credential));
    await signingIn;
    assert.deepEqual(ui.requests.find(request => request.url.endsWith('/verify')).body, { ticket, response: credential });
    assert.deepEqual(ui.navigations, ['/']);
    assert.equal(ui.form.getAttribute('aria-busy'), 'false');
  });
}

test('cancelling the automatic prompt keeps sign-in incomplete and retries the same ticket without a fallback', async () => {
  const ui = harness({
    browser(kind, args, attempt) {
      if (attempt === 1) throw Object.assign(new Error('Synthetic device cancellation'), { name: 'NotAllowedError' });
      return clone(credential);
    },
  });
  await ui.ready();
  await ui.submit();
  assert.match(ui.nodes.err.textContent, /cancelled|timed out/i);
  assert.match(ui.nodes.err.textContent, /incomplete/i);
  assert.equal(ui.nodes['passkey-go'].disabled, false, 'The explicit retry must remain available after a native cancellation');
  assert.equal(ui.nodes['passkey-restart'].disabled, false);
  assert.equal(ui.nodes.upw.value, '');
  assert.deepEqual(ui.navigations, []);
  assert.equal(ui.requests.filter(request => request.url.endsWith('/verify')).length, 0);
  await ui.nodes['passkey-go'].click();
  assert.equal(ui.ceremonies.length, 2);
  assert.deepEqual(ui.requests.filter(request => request.url.endsWith('/options')).map(request => request.body), [{ ticket }, { ticket }]);
  assert.equal(ui.requests.filter(request => request.url === '/api/login').length, 1, 'A ceremony retry must not silently resubmit credentials');
  assert.deepEqual(ui.requests.filter(request => request.url.endsWith('/verify')).map(request => request.body), [{ ticket, response: credential }]);
  assert.deepEqual(ui.navigations, ['/']);
});

test('busy controls and JS guards prevent duplicate password, prompt and verification requests', async () => {
  const credentials = deferred(), prompt = deferred(), verification = deferred();
  const ui = harness({ login: () => credentials.promise, browser: () => prompt.promise, verify: () => verification.promise });
  await ui.ready();
  const signingIn = ui.submit();
  await ui.form.dispatch('submit');
  await ui.nodes['passkey-go'].dispatch('click');
  assert.equal(ui.requests.filter(request => request.url === '/api/login').length, 1);
  assert.equal(ui.ceremonies.length, 0);
  assert.ok(ui.elements.filter(element => element.tagName === 'button').every(button => button.disabled));
  credentials.resolve({ passkeyRequired: true, ticket, enrollmentRequired: true });
  await until(() => ui.ceremonies.length === 1, 'The automatic prompt did not start');
  await ui.form.dispatch('submit');
  await ui.nodes['passkey-go'].dispatch('click');
  assert.equal(ui.ceremonies.length, 1);
  assert.equal(ui.requests.filter(request => request.url.endsWith('/options')).length, 1);
  prompt.resolve(clone(credential));
  await until(() => ui.requests.some(request => request.url.endsWith('/verify')), 'The device response was not sent for verification');
  await ui.form.dispatch('submit');
  await ui.nodes['passkey-go'].dispatch('click');
  assert.equal(ui.requests.filter(request => request.url.endsWith('/verify')).length, 1);
  assert.equal(ui.form.getAttribute('aria-busy'), 'true');
  assert.deepEqual(ui.navigations, []);
  verification.resolve({ ok: true });
  await signingIn;
  assert.deepEqual(ui.navigations, ['/']);
});

test('rejected credentials never request passkeys and owner enrollment secrets stay out of URL and storage', async () => {
  const bootstrap = 'synthetic-owner-enrollment-secret';
  const ui = harness({ href: origin + '/login?keep=visible&enroll=' + bootstrap + '#step', login: () => ({ httpStatus: 401, data: { error: 'Incorrect sign-in details' } }) });
  assert.equal(new URL(ui.location.href).searchParams.has('enroll'), false, 'The bootstrap secret must leave the address before asynchronous loading');
  assert.deepEqual(ui.historyChanges, ['/login?keep=visible#step']);
  await ui.ready();
  assert.deepEqual(ui.requests.map(request => request.url), ['/api/auth-methods']);
  await ui.submit();
  assert.equal(ui.requests.find(request => request.url === '/api/login').body.enrollmentToken, bootstrap);
  assert.match(ui.nodes.err.textContent, /Incorrect sign-in details/);
  assert.deepEqual(ui.ceremonies, []);
  assert.deepEqual(ui.navigations, []);
  assert.equal(ui.nodes['passkey-go'].disabled, false);
  assert.equal(ui.requests.filter(request => request.url.includes('/passkeys/')).length, 0);
});

test('a rejected verification requires restart and cannot retry a consumed ticket or bypass the device step', async () => {
  const ui = harness({ verify: () => ({ httpStatus: 400, data: { error: 'Invalid passkey response' } }) });
  await ui.ready();
  await ui.submit();
  assert.match(ui.nodes.err.textContent, /Invalid passkey response.*Restart sign-in/);
  assert.equal(ui.nodes['passkey-go'].disabled, true);
  assert.equal(ui.nodes['passkey-restart'].disabled, false);
  assert.deepEqual(ui.navigations, []);
  await ui.nodes['passkey-go'].dispatch('click');
  assert.equal(ui.ceremonies.length, 1);
  assert.equal(ui.requests.filter(request => request.url.endsWith('/verify')).length, 1);
  await ui.nodes['passkey-restart'].click();
  assert.equal(ui.nodes.userbox.hidden, false);
  assert.equal(ui.nodes.passkeybox.hidden, true);
  assert.equal(ui.nodes.upw.value, '');
  assert.equal(ui.requests.filter(request => request.url === '/api/login').length, 1, 'Restart must wait for a new explicit credential submission');
});

test('a wrong-origin page shows the canonical link and never attempts a localhost device ceremony', async () => {
  const ui = harness({ href: 'http://localhost:8787/login' });
  await ui.ready();
  assert.equal(ui.nodes['origin-notice'].hidden, false);
  assert.equal(ui.nodes['origin-link'].href, origin);
  assert.equal(ui.nodes.userbox.hidden, true);
  // Even a synthetic form dispatch must stop before reaching the device API.
  await ui.submit();
  assert.deepEqual(ui.ceremonies, []);
  assert.deepEqual(ui.navigations, []);
  assert.equal(ui.requests.filter(request => request.url.includes('/passkeys/')).length, 0);
  assert.equal(ui.nodes['passkey-go'].disabled, true);
});
