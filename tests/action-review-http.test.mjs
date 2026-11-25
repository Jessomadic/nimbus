import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {PasskeyAuthenticator} from './helpers/passkey-authenticator.mjs';

// These fixtures start the real HTTP entry point, but never load inference,
// browser groups, production data, or the repository's .env file.
const repository = fileURLToPath(new URL('../', import.meta.url));
const password = 'Nimbus-HTTP-fixture-only!' + randomBytes(18).toString('hex');
const accountEmail = 'security-owner@example.invalid';
const accountPassword = 'Nimbus-account-fixture-only!' + randomBytes(18).toString('hex');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const remoteHeaders = {
  host: 'nimbus.fixture.invalid',
  origin: 'https://nimbus.fixture.invalid',
  'x-forwarded-proto': 'https',
  'cf-connecting-ip': '198.51.100.42',
  'cf-ray': 'security-http-fixture',
};

async function unusedLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function request(port, route, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: route, method, agent: false,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('Fixture HTTP request timed out')));
    req.on('error', reject);
    req.end(payload);
  });
}

function sessionCookie(response) {
  return response.headers['set-cookie']?.find(value => /^(?:__Host-)?nimbus_session=/.test(value))?.split(';')[0];
}

function assertDenied(response, context) {
  assert.ok([401, 403].includes(response.status), `${context}: expected an authentication denial, got HTTP ${response.status}`);
  assert.equal(sessionCookie(response), undefined, `${context}: a denied response must not issue a session`);
}

function withDatabase(fixture, operation) {
  const database = new DatabaseSync(path.join(fixture.data, 'nimbus.db'));
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    return operation(database);
  } finally {
    database.close();
  }
}

const enrollmentSecret = 'JBSWY3DPEHPK3PXP';
const existingRecovery = JSON.stringify([createHash('sha256').update('fixture-existing-recovery').digest('hex')]);

function totpCode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...secret].map(character => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map(byte => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}

function seedMfaAccount(server, enabled) {
  const salt = randomBytes(16).toString('hex');
  const hashPassword = value => scryptSync(value, salt, 64).toString('hex');
  withDatabase(server, database => database.prepare('INSERT INTO users (email,salt,pw_hash,totp_enabled,totp_secret,recovery) VALUES (?,?,?,?,?,?)')
    .run(accountEmail, salt, hashPassword(accountPassword), enabled ? 1 : 0, enrollmentSecret, enabled ? existingRecovery : '[]'));
  return { hashPassword };
}

function mfaState(server) {
  return withDatabase(server, database => database.prepare('SELECT totp_enabled,totp_secret,recovery FROM users WHERE email=?').get(accountEmail));
}

async function signInAccount(server) {
  let response = await server.request('/api/login', { method: 'POST', headers: remoteHeaders, body: { email: accountEmail, password: accountPassword } });
  assert.equal(response.status, 200, 'Synthetic account password login must succeed');
  if (response.json?.mfa) {
    response = await server.request('/api/login/mfa', { method: 'POST', headers: remoteHeaders, body: { ticket: response.json.ticket, code: totpCode(enrollmentSecret) } });
    assert.equal(response.status, 200, 'Synthetic account second factor must succeed');
  }
  const cookie = sessionCookie(response);
  assert.ok(cookie, 'Synthetic account login must issue a session');
  return cookie;
}

async function delayedAuthenticatedBody(server, route, cookie, body) {
  const tokenHash = createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('hex');
  const oldSeen = Math.floor(Date.now() / 1000) - 120;
  assert.equal(withDatabase(server, database => database.prepare('UPDATE auth_sessions SET last_seen=? WHERE token=?').run(oldSeen, tokenHash).changes), 1);
  const payload = JSON.stringify(body);
  let req;
  const response = new Promise((resolve, reject) => {
    req = http.request({
      hostname: '127.0.0.1', port: server.port, path: route, method: 'POST', agent: false,
      headers: { ...remoteHeaders, cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Delayed MFA body fixture timed out')));
    req.on('error', reject);
    req.write(payload.slice(0, -1));
  });
  response.catch(() => {});
  try {
    // Observe the real server's initial session check rather than guessing when
    // it has reached the incomplete body. The post-body check is still pending.
    for (let attempt = 0; attempt < 150; attempt++) {
      const row = withDatabase(server, database => database.prepare('SELECT last_seen FROM auth_sessions WHERE token=?').get(tokenHash));
      if (row?.last_seen > oldSeen) return { response, finish: () => req.end(payload.slice(-1)), cancel: () => req.destroy() };
      await wait(20);
    }
    assert.fail('The delayed MFA request did not reach its initial authenticated boundary');
  } catch (error) {
    req.destroy();
    throw error;
  }
}

async function fixture(t, { accounts = false, noPassword = false, startupMayRefuse = false, username = false, passkeyVersion } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nimbus-security-http-'));
  const data = path.join(directory, 'data');
  const configFile = path.join(directory, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({
    cloud: { enabled: false },
    local: { enabled: false, managed: { enabled: false } },
    browser: { enabled: false },
    mcpServers: {},
  }));
  if(passkeyVersion!==undefined){
    // Persist an enrollment history before starting the real entry point. An
    // empty key table after recovery/data loss must not look like first use.
    fs.mkdirSync(data,{recursive:true});const seed=new DatabaseSync(path.join(data,'nimbus.db'));
    try{
      seed.exec('CREATE TABLE passkey_owner(id INTEGER PRIMARY KEY CHECK(id=1),user_handle BLOB NOT NULL CHECK(length(user_handle)=32),version INTEGER NOT NULL DEFAULT 0)');
      seed.prepare('INSERT INTO passkey_owner VALUES(1,?,?)').run(randomBytes(32),passkeyVersion);
    }finally{seed.close();}
  }
  const port = await unusedLoopbackPort();
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^NIMBUS_/i.test(name) || /^(HOST|PORT)$/i.test(name)) delete env[name];
  Object.assign(env, {
    HOST: '127.0.0.1', PORT: String(port), NIMBUS_HTTPS_PORT: '0',
    NIMBUS_DATA: data, NIMBUS_CONFIG: configFile,
    NIMBUS_PASSWORD: noPassword ? '' : password,
    NIMBUS_ALLOWED_EMAILS: accounts ? accountEmail : '',
    NIMBUS_ALLOW_NO_PASSWORD: noPassword ? '1' : '0',
    NIMBUS_PUBLIC_ORIGIN: 'https://nimbus.fixture.invalid',
    NIMBUS_USERNAME: username?'Jessomadic':'',
  });
  const child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: repository, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', exited = false, exitCode;
  const retain = bytes => { output = (output + bytes.toString()).slice(-12000); };
  child.stdout.on('data', retain);
  child.stderr.on('data', retain);
  const closed = new Promise(resolve => {
    child.once('exit', code => { exited = true; exitCode = code; resolve(); });
    child.once('error', error => { exited = true; output += '\n' + error.message; resolve(); });
  });
  const result = { directory, data, port, child, request: (route, options) => request(port, route, options) };
  t.after(async () => {
    if (!exited) {
      try {
        const token = fs.readFileSync(path.join(data, 'admin.token'), 'utf8').trim();
        await result.request('/api/admin/shutdown', { method: 'POST', headers: { 'x-nimbus-admin': token }, body: {} });
      } catch {}
      await Promise.race([closed, wait(5000)]);
    }
    if (!exited) {
      // Only this fixture's owned Node child can reach this fallback.
      child.kill();
      await Promise.race([closed, wait(5000)]);
    }
    assert.equal(exited, true, 'The fixture server must exit before its temporary data is removed');
    const resolved = path.resolve(directory), temporaryRoot = path.resolve(os.tmpdir());
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('nimbus-security-http-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (let attempt = 0; attempt < 100 && !exited; attempt++) {
    try {
      if ((await result.request('/health')).status === 200) return { ...result, ready: true };
    } catch {}
    await wait(100);
  }
  if (startupMayRefuse && exited) {
    assert.notEqual(exitCode, 0, 'Refusing an insecure startup must produce a nonzero exit status');
    return { ...result, ready: false };
  }
  assert.fail(`Isolated HTTP fixture did not start (exit ${exitCode ?? 'pending'}): ${output}`);
}


import {revision} from '../runtime/action-review.js';
test('trusted real host auth, CSRF, CAS, duplicate and atomic rollback',async t=>{
 const server=await fixture(t);
 const route='/api/tool-calls/991%3Asynthetic/resolve';
 withDatabase(server,d=>{
 d.prepare("INSERT INTO runs(id,status) VALUES(991,'needs_review')").run();
 d.prepare("INSERT INTO tool_calls(id,run_id,name,args,state,result,ended_at) VALUES('991:synthetic',991,'fixture','{}','uncertain','original',123)").run();
 });
 const original=withDatabase(server,d=>[d.prepare("SELECT * FROM tool_calls WHERE id='991:synthetic'").get(),d.prepare('SELECT * FROM runs WHERE id=991').get()]);
 const token=fs.readFileSync(path.join(server.data,'admin.token'),'utf8').trim();
 const headers={'x-nimbus-admin':token};
 const health=await server.request('/health');
 const updates=await server.request('/api/updates',{headers});
 const body={callId:'991:synthetic',revision:revision(...original),sourceOwner:health.json.sourceHash+':'+updates.json.sourceHash,disposition:'unknown',observedResult:'Historical exit unknown'};
 assertDenied(await server.request(route,{method:'POST',headers:remoteHeaders,body}),'anonymous');
 assert.equal((await server.request(route,{method:'POST',headers:{...headers,origin:'https://evil.invalid'},body})).status,403);
 assert.equal((await server.request(route,{method:'POST',headers:{...headers,'content-type':'text/plain'},body})).status,415);
 for(const patch of [{revision:'stale'},{callId:'wrong'},{sourceOwner:'wrong'}])assert.ok([403,409].includes((await server.request(route,{method:'POST',headers,body:{...body,...patch}})).status));
 withDatabase(server,d=>d.exec("CREATE TRIGGER review_fault BEFORE INSERT ON task_events WHEN NEW.type='action.review.disposition' BEGIN SELECT RAISE(ABORT,'fixture fault'); END"));
 assert.equal((await server.request(route,{method:'POST',headers,body})).status,500);
 assert.equal(withDatabase(server,d=>d.prepare("SELECT count(*) n FROM task_events WHERE run_id=991").get().n),0);
 withDatabase(server,d=>d.exec('DROP TRIGGER review_fault'));
 const replies=await Promise.all([server.request(route,{method:'POST',headers,body}),server.request(route,{method:'POST',headers,body})]);
 assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
 assert.deepEqual(withDatabase(server,d=>[d.prepare("SELECT * FROM tool_calls WHERE id='991:synthetic'").get(),d.prepare('SELECT * FROM runs WHERE id=991').get()]),original);
 const audit=withDatabase(server,d=>JSON.parse(d.prepare("SELECT body FROM task_events WHERE run_id=991").get().body));
 assert.equal(audit.principal,'local-admin');assert.equal(audit.userVerified,false);assert.equal(audit.workflowAuthorization,false);
});
