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

test('real HTTP boundary protects APIs, app pages, browsers, files and execution surfaces', async t => {
  const server = await fixture(t);
  const protectedAPIs = [
    '/api/state', '/api/events', '/api/runtime', '/api/runtime/config', '/api/tasks',
    '/api/updates', '/api/capabilities', '/api/questions', '/api/browser-groups',
    '/api/browser/1/fixture/screenshot', '/api/files/' + 'a'.repeat(24) + '/fixture.txt',
    '/api/bots/1/files', '/api/bots/1/memory', '/api/terminals', '/api/terminal',
  ];
  for (const route of protectedAPIs) {
    assertDenied(await server.request(route, { headers: remoteHeaders }), `anonymous GET ${route}`);
    assertDenied(await server.request(route, { headers: { ...remoteHeaders, cookie: 'nimbus_session=' + 'a'.repeat(64) } }), `forged session GET ${route}`);
  }
  for (const route of ['/api/tasks', '/api/updates', '/api/uploads', '/api/admin/restart', '/api/terminals']) {
    assertDenied(await server.request(route, { method: 'POST', headers: remoteHeaders, body: {} }), `anonymous POST ${route}`);
  }
  for (const route of ['/', '/app.js', '/runtime.js', '/computer/1/']) {
    const response = await server.request(route, { headers: remoteHeaders });
    assert.equal(response.status, 302, `anonymous GET ${route}`);
    assert.equal(response.headers.location, '/login');
  }
  const login = await server.request('/api/login', { method: 'POST', headers: remoteHeaders, body: { password } });
  assert.equal(login.status, 200, 'The same real server must accept the correct fixture password');
  const cookie = sessionCookie(login);
  assert.ok(cookie, 'A correct password must issue a session');
  const attributes = login.headers['set-cookie'].find(value => value.startsWith(cookie));
  assert.match(attributes, /;\s*HttpOnly(?:;|$)/i);
  assert.match(attributes, /;\s*Secure(?:;|$)/i);
  assert.match(attributes, /;\s*SameSite=Lax(?:;|$)/i);
  assert.equal((await server.request('/api/state', { headers: { ...remoteHeaders, cookie } })).status, 200);
  const html = '<!doctype html><script>globalThis.fixtureMustNotRun=true</script>';
  const upload = await server.request('/api/uploads', {
    method: 'POST', headers: { ...remoteHeaders, cookie },
    body: { name: 'security-fixture.html', type: 'text/html', data: Buffer.from(html).toString('base64') },
  });
  assert.equal(upload.status, 200);
  const downloadPath = `/api/files/${upload.json.id}/${encodeURIComponent(upload.json.name)}`;
  const download = await server.request(downloadPath, { headers: { ...remoteHeaders, cookie } });
  assert.equal(download.status, 200);
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.match(download.headers['content-disposition'], /^attachment;/i);
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.match(download.headers['content-security-policy'], /(?:^|;)\s*default-src\s+'none'(?:;|$)/);
  assert.match(download.headers['content-security-policy'], /(?:^|;)\s*sandbox\s*(?:;|$)/);
  assert.doesNotMatch(download.headers['content-security-policy'], /allow-scripts|script-src\s+(?!'none')/);
  assert.equal(download.text, html, 'The security headers must protect the actual uploaded content');
  assertDenied(await server.request(downloadPath, { headers: remoteHeaders }), 'anonymous download of an existing uploaded HTML file');
  assertDenied(await server.request('/api/state', {
    headers: { ...remoteHeaders, 'x-forwarded-proto': 'http', origin: 'http://nimbus.fixture.invalid', cookie },
  }), 'authenticated forwarded request without HTTPS');
  const crossOrigin = await server.request('/api/logout', {
    method: 'POST', headers: { ...remoteHeaders, origin: 'https://unrelated.example.invalid', cookie }, body: {},
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await server.request('/api/state', { headers: { ...remoteHeaders, cookie } })).status, 200, 'Rejected cross-origin logout must leave the session active');
  const stream = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.port, path: '/api/events', agent: false,
      headers: { ...remoteHeaders, cookie },
    }, res => {
      const connection = { request: req, response: res, ended: false };
      connection.closed = new Promise(done => res.once('end', () => { connection.ended = true; done(); }));
      res.on('error', () => {});
      res.resume();
      resolve(connection);
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal(stream.response.statusCode, 200, 'A valid session must open its event stream');
    assert.equal((await server.request('/api/logout', { method: 'POST', headers: { ...remoteHeaders, cookie }, body: {} })).status, 200);
    await Promise.race([stream.closed, wait(1500)]);
    assert.equal(stream.ended, true, 'Logout must immediately close an existing authenticated event stream');
    assertDenied(await server.request('/api/state', { headers: { ...remoteHeaders, cookie } }), 'session after logout');
  } finally {
    stream.response.destroy();
    stream.request.destroy();
  }
});

const ownerOrigin='https://nimbus.fixture.invalid';
const ownerLogin={username:'Jessomadic',password};
const browserCookie=response=>response.headers['set-cookie']?.find(value=>value.startsWith('__Host-nimbus_preauth='))?.split(';')[0];
async function bootstrapOwner(server,device=new PasskeyAuthenticator()){
  const token=fs.readFileSync(path.join(server.data,'admin.token'),'utf8').trim();
  const bootstrap=await server.request('/api/admin/passkeys/enrollment-ticket',{method:'POST',headers:{'x-nimbus-admin':token},body:{}});
  assert.equal(bootstrap.status,200);
  const enrollmentToken=new URL(bootstrap.json.url).searchParams.get('enroll');
  const login=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:{...ownerLogin,enrollmentToken}});
  assert.equal(login.status,200);assert.equal(login.json.enrollmentRequired,true);assert.equal(sessionCookie(login),undefined);
  const preauth=browserCookie(login);assert.ok(preauth);
  const headers={...remoteHeaders,cookie:preauth},ticket=login.json.ticket;
  const options=await server.request('/api/passkeys/registration/options',{method:'POST',headers,body:{ticket}});
  assert.equal(options.status,200);
  const response=device.register(options.json,{origin:ownerOrigin});
  const result=await server.request('/api/passkeys/registration/verify',{method:'POST',headers,body:{ticket,response}});
  assert.equal(result.status,200,JSON.stringify(result.json));
  const cookie=sessionCookie(result);assert.ok(cookie);
  return{device,cookie,enrollmentToken,ticket,response,preauth};
}
async function beginOwnerLogin(server){
  const login=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:ownerLogin});
  assert.equal(login.status,200);assert.equal(login.json.passkeyRequired,true);assert.equal(login.json.enrollmentRequired,false);assert.equal(sessionCookie(login),undefined);
  const preauth=browserCookie(login);assert.ok(preauth);
  const headers={...remoteHeaders,cookie:preauth},ticket=login.json.ticket;
  const options=await server.request('/api/passkeys/authentication/options',{method:'POST',headers,body:{ticket}});
  assert.equal(options.status,200);return{ticket,headers,options:options.json};
}

async function beginFirstOwnerEnrollment(server){
  const login=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:ownerLogin});
  assert.equal(login.status,200);assert.equal(login.json.passkeyRequired,true);assert.equal(login.json.enrollmentRequired,true);
  assert.equal(sessionCookie(login),undefined,'Correct initial credentials must grant only a ceremony, never an app session');
  const preauth=browserCookie(login);assert.ok(preauth);
  const attributes=login.headers['set-cookie'].find(value=>value.startsWith(preauth));
  assert.match(attributes,/;\s*HttpOnly(?:;|$)/i);assert.match(attributes,/;\s*Secure(?:;|$)/i);assert.match(attributes,/;\s*SameSite=Strict(?:;|$)/i);
  const headers={...remoteHeaders,cookie:preauth},ticket=login.json.ticket;
  const options=await server.request('/api/passkeys/registration/options',{method:'POST',headers,body:{ticket}});
  assert.equal(options.status,200);assert.equal(sessionCookie(options),undefined);
  return{ticket,headers,preauth,options:options.json};
}

test('named owner requires correct username/password and completed passkey enrollment before app access',async t=>{
  const server=await fixture(t,{username:true});
  const methods=await server.request('/api/auth-methods',{headers:remoteHeaders});
  assert.equal(methods.json.username,true);assert.equal(methods.json.passkeyRequired,true);assert.equal(methods.json.passkeyOrigin,ownerOrigin);assert.equal(methods.json.signup,false);
  for(const credentials of [{password},{username:'somebodyelse',password},{username:'Jessomadic',password:'wrong'}]){
    assertDenied(await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:credentials}),'invalid named credentials');
  }
  const valid=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:ownerLogin});
  assert.equal(valid.status,200);assert.equal(valid.json.passkeyRequired,true);assert.equal(valid.json.enrollmentRequired,true);assert.equal(sessionCookie(valid),undefined);
  assert.ok(browserCookie(valid));
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),0);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),0);
  assertDenied(await server.request('/api/state',{headers:remoteHeaders}),'password alone');
  assertDenied(await server.request('/api/state',{headers:{...remoteHeaders,cookie:browserCookie(valid)}}),'initial registration ticket alone');
  const token=fs.readFileSync(path.join(server.data,'admin.token'),'utf8').trim();
  const localLink=await server.request('/api/admin/login-ticket',{method:'POST',headers:{'x-nimbus-admin':token},body:{}});
  assert.equal(localLink.status,403);
  assertDenied(await server.request('/api/admin/passkeys/enrollment-ticket',{method:'POST',headers:{...remoteHeaders,'x-nimbus-admin':token},body:{}}),'remote bootstrap even with local token');
});

test('first ordinary username/password login offers real passkey enrollment without an owner link',async t=>{
  const server=await fixture(t,{username:true}),pending=await beginFirstOwnerEnrollment(server),device=new PasskeyAuthenticator();
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),0);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT version FROM passkey_owner WHERE id=1').get().version),0);
  assertDenied(await server.request('/api/state',{headers:pending.headers}),'ordinary first-login ceremony before device verification');
  assert.equal(pending.options.user.name,'Jessomadic');assert.equal(pending.options.authenticatorSelection.userVerification,'required');
  const response=device.register(pending.options,{origin:ownerOrigin});
  const result=await server.request('/api/passkeys/registration/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response,label:'First ordinary device'}});
  assert.equal(result.status,200,JSON.stringify(result.json));const cookie=sessionCookie(result);assert.ok(cookie);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),1);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT version FROM passkey_owner WHERE id=1').get().version),1);
  assert.equal((await server.request('/api/state',{headers:{...remoteHeaders,cookie}})).status,200);
  const next=await beginOwnerLogin(server);
  assert.deepEqual(next.options.allowCredentials.map(value=>value.id),[device.id]);
  assertDenied(await server.request('/api/state',{headers:next.headers}),'subsequent password login still requires its enrolled device');
});

test('repeated correct passwords and cancelled setup prompts do not exhaust the password budget',async t=>{
  const server=await fixture(t,{username:true});let pending;
  // Every attempt uses the same client IP. Cancelling the native device prompt
  // sends no verification response; the next password should remain usable.
  for(let attempt=0;attempt<10;attempt++)pending=await beginFirstOwnerEnrollment(server);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),0);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),0);
  assertDenied(await server.request('/api/state',{headers:pending.headers}),'ten successful password phases are not a completed sign-in');
  const device=new PasskeyAuthenticator(),response=device.register(pending.options,{origin:ownerOrigin});
  const finish=await server.request('/api/passkeys/registration/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response}});
  assert.equal(finish.status,200,JSON.stringify(finish.json));const cookie=sessionCookie(finish);assert.ok(cookie);
  assert.equal((await server.request('/api/state',{headers:{...remoteHeaders,cookie}})).status,200);
});

test('options-only prompt retries preserve the challenge and do not block a new password or device proof',async t=>{
  const server=await fixture(t,{username:true}),pending=await beginFirstOwnerEnrollment(server);
  for(let retry=0;retry<12;retry++){
    const options=await server.request('/api/passkeys/registration/options',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket}});
    assert.equal(options.status,200,`Same-IP cancelled prompt retry ${retry+1} must not spend a password or factor attempt`);
    assert.equal(options.json.challenge,pending.options.challenge);assert.equal(sessionCookie(options),undefined);
  }
  const next=await beginFirstOwnerEnrollment(server);
  assert.notEqual(next.ticket,pending.ticket);assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),0);
  const device=new PasskeyAuthenticator(),response=device.register(next.options,{origin:ownerOrigin});
  const finish=await server.request('/api/passkeys/registration/verify',{method:'POST',headers:next.headers,body:{ticket:next.ticket,response}});
  assert.equal(finish.status,200,JSON.stringify(finish.json));assert.ok(sessionCookie(finish));
});

test('failed passkey proofs have a separate eight-attempt budget that only complete sign-in resets',async t=>{
  const server=await fixture(t,{username:true}),owner=await bootstrapOwner(server);
  async function wrongProof(counter){
    const pending=await beginOwnerLogin(server);
    const response=owner.device.authenticate(pending.options,{origin:ownerOrigin,counter,badSignature:true});
    const result=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response}});
    assert.equal(result.status,400,'Invalid real signatures must spend factor attempts without issuing a session');assert.equal(sessionCookie(result),undefined);
  }
  for(let attempt=0;attempt<3;attempt++)await wrongProof(1);
  const successful=await beginOwnerLogin(server),proof=owner.device.authenticate(successful.options,{origin:ownerOrigin,counter:1});
  const complete=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:successful.headers,body:{ticket:successful.ticket,response:proof}});
  assert.equal(complete.status,200);assert.ok(sessionCookie(complete));
  // Correct password and new challenge on every iteration must not replenish
  // the cryptographic proof budget established after the complete sign-in.
  for(let attempt=0;attempt<8;attempt++)await wrongProof(2);
  const stillAllowedPassword=await beginOwnerLogin(server);
  const validProof=owner.device.authenticate(stillAllowedPassword.options,{origin:ownerOrigin,counter:2});
  const blocked=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:stillAllowedPassword.headers,body:{ticket:stillAllowedPassword.ticket,response:validProof}});
  assert.equal(blocked.status,429,'A ninth factor must remain limited even after another correct username/password');assert.equal(sessionCookie(blocked),undefined);
  assert.ok(Number(blocked.headers['retry-after'])>0);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT counter FROM passkey_credentials WHERE id=?').get(owner.device.id).counter),1);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),2,'Only the initial enrollment and completed proof may create sessions');
});

function exhaustGlobalBurst(server){
  const bucket=createHash('sha256').update('global-login').digest('hex');
  withDatabase(server,database=>database.prepare('INSERT INTO auth_attempts(bucket,attempts,until_at) VALUES(?,?,?) ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts,until_at=excluded.until_at').run(bucket,60,Math.floor(Date.now()/1000)+60));
  return()=>assert.equal(withDatabase(server,database=>database.prepare('DELETE FROM auth_attempts WHERE bucket=?').run(bucket).changes),1,'The fixture must clear only its global burst bucket');
}

test('global burst denials do not create a downstream fifteen-minute password lockout',async t=>{
  const server=await fixture(t,{username:true}),owner=await bootstrapOwner(server),clearGlobal=exhaustGlobalBurst(server);
  for(let attempt=0;attempt<8;attempt++){
    const blocked=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:ownerLogin});
    assert.equal(blocked.status,429);assert.equal(sessionCookie(blocked),undefined);assert.equal(browserCookie(blocked),undefined);
  }
  clearGlobal();
  // Keep the same client IP and every other persisted bucket intact. Admission
  // at an earlier limit must not have spent the later password reservation.
  const pending=await beginOwnerLogin(server),response=owner.device.authenticate(pending.options,{origin:ownerOrigin,counter:1});
  const finish=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response}});
  assert.equal(finish.status,200,JSON.stringify(finish.json));const cookie=sessionCookie(finish);assert.ok(cookie);
  assert.equal((await server.request('/api/state',{headers:{...remoteHeaders,cookie}})).status,200);
});

test('global burst denials do not consume a pending challenge or downstream passkey verification budget',async t=>{
  const server=await fixture(t,{username:true}),owner=await bootstrapOwner(server),pending=await beginOwnerLogin(server);
  const response=owner.device.authenticate(pending.options,{origin:ownerOrigin,counter:1}),clearGlobal=exhaustGlobalBurst(server);
  for(let attempt=0;attempt<8;attempt++){
    const blocked=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response}});
    assert.equal(blocked.status,429);assert.equal(sessionCookie(blocked),undefined);
  }
  assert.equal(withDatabase(server,database=>database.prepare('SELECT counter FROM passkey_credentials WHERE id=?').get(owner.device.id).counter),0);
  clearGlobal();
  // Do not refresh the password, challenge, IP, or factor bucket: the exact
  // proof refused by the burst gate must still be usable when that gate opens.
  const finish=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response}});
  assert.equal(finish.status,200,JSON.stringify(finish.json));assert.ok(sessionCookie(finish));
  assert.equal(withDatabase(server,database=>database.prepare('SELECT counter FROM passkey_credentials WHERE id=?').get(owner.device.id).counter),1);
});

test('parallel first-enrollment tickets cannot enroll two devices or issue a losing session',async t=>{
  const server=await fixture(t,{username:true});
  const pending=await Promise.all([beginFirstOwnerEnrollment(server),beginFirstOwnerEnrollment(server)]);
  const devices=[new PasskeyAuthenticator(),new PasskeyAuthenticator()];
  assert.notEqual(pending[0].ticket,pending[1].ticket);assert.notEqual(pending[0].preauth,pending[1].preauth);
  const responses=devices.map((device,index)=>device.register(pending[index].options,{origin:ownerOrigin}));
  const results=await Promise.all(pending.map((ceremony,index)=>server.request('/api/passkeys/registration/verify',{method:'POST',headers:ceremony.headers,body:{ticket:ceremony.ticket,response:responses[index]}})));
  assert.equal(results.filter(value=>value.status===200).length,1,'Only one initial credential may win');
  const winner=results.findIndex(value=>value.status===200),loser=winner===0?1:0;
  assert.ok([400,401,409].includes(results[loser].status));assert.equal(sessionCookie(results[loser]),undefined);
  const stored=withDatabase(server,database=>database.prepare('SELECT id FROM passkey_credentials').all());
  assert.deepEqual(stored.map(value=>value.id),[devices[winner].id]);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT version FROM passkey_owner WHERE id=1').get().version),1);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),1);
  const cookie=sessionCookie(results[winner]);assert.ok(cookie);
  assert.equal((await server.request('/api/state',{headers:{...remoteHeaders,cookie}})).status,200);
});

test('persisted prior enrollment history prevents automatic enrollment when no keys remain',async t=>{
  const server=await fixture(t,{username:true,passkeyVersion:7});
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),0);
  const login=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:ownerLogin});
  assert.equal(login.status,403);assert.equal(sessionCookie(login),undefined);assert.equal(browserCookie(login),undefined);
  assert.equal(login.json?.ticket,undefined,'Earlier enrollment history must not grant a public registration ceremony');
  assert.equal(withDatabase(server,database=>database.prepare('SELECT version FROM passkey_owner WHERE id=1').get().version),7);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),0);
  assertDenied(await server.request('/api/state',{headers:remoteHeaders}),'lost credentials must require local recovery authorization');
});

test('real WebAuthn enrollment, password-plus-passkey login, logout and replay boundaries',async t=>{
  const server=await fixture(t,{username:true});
  const owner=await bootstrapOwner(server);
  assert.equal((await server.request('/api/state',{headers:{...remoteHeaders,cookie:owner.cookie}})).status,200);
  const keys=await server.request('/api/passkeys',{headers:{...remoteHeaders,cookie:owner.cookie}});
  assert.equal(keys.json.passkeys.length,1);assert.equal(keys.json.passkeys[0].id,owner.device.id);assert.equal(keys.json.username,'Jessomadic');
  assert.ok(!keys.text.includes('public_key'));
  const bootstrapReplay=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:{...ownerLogin,enrollmentToken:owner.enrollmentToken}});
  assert.equal(bootstrapReplay.status,401);assert.equal(sessionCookie(bootstrapReplay),undefined);
  const registrationReplay=await server.request('/api/passkeys/registration/verify',{method:'POST',headers:{...remoteHeaders,cookie:owner.preauth},body:{ticket:owner.ticket,response:owner.response}});
  assert.ok([400,401].includes(registrationReplay.status));assert.equal(sessionCookie(registrationReplay),undefined);
  const pending=await beginOwnerLogin(server),assertion=owner.device.authenticate(pending.options,{origin:ownerOrigin,counter:1});
  assertDenied(await server.request('/api/state',{headers:pending.headers}),'pending ceremony is not a session');
  const login=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response:assertion}});
  assert.equal(login.status,200,JSON.stringify(login.json));const cookie=sessionCookie(login);assert.ok(cookie);
  const replay=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response:assertion}});
  assert.ok([400,401].includes(replay.status));assert.equal(sessionCookie(replay),undefined);
  assert.equal((await server.request('/api/state',{headers:{...remoteHeaders,cookie}})).status,200);
  assert.equal((await server.request('/api/logout',{method:'POST',headers:{...remoteHeaders,cookie},body:{}})).status,200);
  assertDenied(await server.request('/api/state',{headers:{...remoteHeaders,cookie}}),'revoked second-factor session');
});

test('passkey challenges bind to browser and fixed origin and require valid user verification',async t=>{
  const server=await fixture(t,{username:true});
  const {device}=await bootstrapOwner(server);
  const pending=await beginOwnerLogin(server);
  const wrongBrowser=await server.request('/api/passkeys/authentication/options',{method:'POST',headers:remoteHeaders,body:{ticket:pending.ticket}});
  assert.equal(wrongBrowser.status,401);
  const wrongHTTPOrigin=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:{...pending.headers,origin:'https://elsewhere.invalid'},body:{ticket:pending.ticket,response:device.authenticate(pending.options,{origin:ownerOrigin})}});
  assert.equal(wrongHTTPOrigin.status,403);assert.equal(sessionCookie(wrongHTTPOrigin),undefined);
  const wrongSignedOrigin=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:pending.headers,body:{ticket:pending.ticket,response:device.authenticate(pending.options,{origin:'https://elsewhere.invalid'})}});
  assert.equal(wrongSignedOrigin.status,400);assert.equal(sessionCookie(wrongSignedOrigin),undefined);
  const next=await beginOwnerLogin(server);
  const noUV=await server.request('/api/passkeys/authentication/verify',{method:'POST',headers:next.headers,body:{ticket:next.ticket,response:device.authenticate(next.options,{origin:ownerOrigin,flags:1})}});
  assert.equal(noUV.status,400);assert.equal(sessionCookie(noUV),undefined);
});

test('passkey management needs fresh complete authentication and password and cannot remove the last key',async t=>{
  const server=await fixture(t,{username:true});
  const owner=await bootstrapOwner(server),headers={...remoteHeaders,cookie:owner.cookie};
  assert.equal((await server.request('/api/passkeys/'+owner.device.id,{method:'DELETE',headers,body:{password}})).status,409);
  const wrong=await server.request('/api/passkeys/enrollment/start',{method:'POST',headers,body:{password:'wrong'}});assert.equal(wrong.status,401);assert.equal(sessionCookie(wrong),undefined);
  const start=await server.request('/api/passkeys/enrollment/start',{method:'POST',headers,body:{password,label:'Second device'}});assert.equal(start.status,200);
  const manageHeaders={...remoteHeaders,cookie:owner.cookie+'; '+browserCookie(start)},ticket=start.json.ticket;
  const options=await server.request('/api/passkeys/registration/options',{method:'POST',headers:manageHeaders,body:{ticket}});assert.equal(options.status,200);
  const second=new PasskeyAuthenticator(),result=await server.request('/api/passkeys/registration/verify',{method:'POST',headers:manageHeaders,body:{ticket,response:second.register(options.json,{origin:ownerOrigin})}});
  assert.equal(result.status,200,JSON.stringify(result.json));const newCookie=sessionCookie(result);assert.ok(newCookie);
  assertDenied(await server.request('/api/state',{headers}),'other session after credential addition');
  const rotatedHeaders={...remoteHeaders,cookie:newCookie};
  const remove=await server.request('/api/passkeys/'+owner.device.id,{method:'DELETE',headers:rotatedHeaders,body:{password}});assert.equal(remove.status,200);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),1);
  const afterRemove=sessionCookie(remove);assert.ok(afterRemove);
  withDatabase(server,database=>database.prepare('UPDATE auth_sessions SET created_at=unixepoch()-600').run());
  const expired=await server.request('/api/passkeys/enrollment/start',{method:'POST',headers:{...remoteHeaders,cookie:afterRemove},body:{password}});assert.equal(expired.status,401);assert.equal(sessionCookie(expired),undefined);
});

test('passkey enrollment and removal share the strict management password attempt budget',async t=>{
  const server=await fixture(t,{username:true}),owner=await bootstrapOwner(server),headers={...remoteHeaders,cookie:owner.cookie};
  for(let attempt=0;attempt<8;attempt++){
    const removal=attempt%2===1,route=removal?'/api/passkeys/'+owner.device.id:'/api/passkeys/enrollment/start';
    const response=await server.request(route,{method:removal?'DELETE':'POST',headers,body:{password:'wrong-management-fixture-password'}});
    assert.equal(response.status,401,`Management password guess ${attempt+1} must use the password gate`);assert.equal(sessionCookie(response),undefined);
  }
  const blocked=await server.request('/api/passkeys/enrollment/start',{method:'POST',headers,body:{password}});
  assert.equal(blocked.status,429,'Switching management routes must not bypass eight failed password attempts');assert.equal(blocked.json?.ticket,undefined);assert.equal(sessionCookie(blocked),undefined);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),1);
  assert.equal((await server.request('/api/state',{headers})).status,200,'A management password limit must not revoke the existing complete session');
});

test('logout invalidates a pending management enrollment before any new key is saved',async t=>{
  const server=await fixture(t,{username:true}),owner=await bootstrapOwner(server);
  const headers={...remoteHeaders,cookie:owner.cookie};
  const start=await server.request('/api/passkeys/enrollment/start',{method:'POST',headers,body:{password,label:'Must not be saved'}});assert.equal(start.status,200);
  const pendingHeaders={...remoteHeaders,cookie:owner.cookie+'; '+browserCookie(start)},ticket=start.json.ticket;
  const options=await server.request('/api/passkeys/registration/options',{method:'POST',headers:pendingHeaders,body:{ticket}});assert.equal(options.status,200);
  const response=new PasskeyAuthenticator().register(options.json,{origin:ownerOrigin});
  assert.equal((await server.request('/api/logout',{method:'POST',headers,body:{}})).status,200);
  const rejected=await server.request('/api/passkeys/registration/verify',{method:'POST',headers:pendingHeaders,body:{ticket,response}});
  assert.equal(rejected.status,401);assert.equal(sessionCookie(rejected),undefined);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM passkey_credentials').get().n),1);
});

test('forwarded requests cannot use a real local-admin token or local-login ticket', async t => {
  const server = await fixture(t);
  const token = fs.readFileSync(path.join(server.data, 'admin.token'), 'utf8').trim();
  assert.equal((await server.request('/api/state', { headers: { 'x-nimbus-admin': token } })).status, 200);
  assertDenied(await server.request('/api/state', { headers: { ...remoteHeaders, 'x-nimbus-admin': token } }), 'forwarded local-admin token');
  const ticket = await server.request('/api/admin/login-ticket', { method: 'POST', headers: { 'x-nimbus-admin': token }, body: {} });
  assert.equal(ticket.status, 200);
  const ticketURL = new URL(ticket.json.url);
  const target = ticketURL.pathname + ticketURL.search;
  const forwarded = await server.request(target, { headers: remoteHeaders });
  assert.equal(forwarded.status, 403);
  assert.equal(sessionCookie(forwarded), undefined);
  const local = await server.request(target);
  assert.equal(local.status, 302, 'A rejected forwarded attempt must not consume the valid local ticket');
  assert.ok(sessionCookie(local));
});

test('a no-password development fixture fails closed for forwarded access', async t => {
  const server = await fixture(t, { noPassword: true, startupMayRefuse: true });
  if (!server.ready) return;
  const remoteAPI = await server.request('/api/state', { headers: remoteHeaders });
  assert.ok([401, 403, 503].includes(remoteAPI.status), `The development API must refuse forwarded access without authentication (HTTP ${remoteAPI.status})`);
  assert.equal(sessionCookie(remoteAPI), undefined);
  const remotePage = await server.request('/', { headers: remoteHeaders });
  assert.ok([302, 401, 403, 503].includes(remotePage.status), `The unauthenticated development app must not be served remotely (HTTP ${remotePage.status})`);
});

test('concurrent delayed-body password guesses enforce the eight-attempt IP limit', async t => {
  const server = await fixture(t);
  const clients = Array.from({ length: 16 }, (_, index) => {
    const payload = JSON.stringify({ password: 'wrong-fixture-password-' + index });
    let finish;
    const response = new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.port, path: '/api/login', method: 'POST', agent: false,
        headers: { ...remoteHeaders, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); res.on('error', reject); });
      req.setTimeout(10000, () => req.destroy(new Error('Delayed-body login fixture timed out')));
      req.on('error', reject);
      req.flushHeaders();
      finish = () => req.end(payload);
    });
    return { response, finish };
  });
  // Send every header first, forcing overlapping body parsers instead of relying
  // on the operating system to schedule complete requests concurrently.
  await wait(200);
  for (const client of clients) client.finish();
  const statuses = await Promise.all(clients.map(client => client.response));
  assert.ok(statuses.every(status => [401, 429].includes(status)), 'Wrong passwords must receive only denial or rate-limit responses');
  assert.ok(statuses.filter(status => status === 401).length <= 8, 'At most eight concurrent guesses may reach password validation');
  assert.ok(statuses.filter(status => status === 429).length >= 8, 'Excess concurrent guesses must be rate limited');
  assert.equal((await server.request('/api/login', { method: 'POST', headers: remoteHeaders, body: { password } })).status, 429, 'A valid password must not bypass an active IP limit');
});

test('public callers cannot provision an allowed account or bypass account mode with the shared password', async t => {
  const server = await fixture(t, { accounts: true });
  const signup = await server.request('/api/signup', {
    method: 'POST', headers: remoteHeaders, body: { email: accountEmail, password: accountPassword },
  });
  assert.ok([401, 403, 404].includes(signup.status), `Public account provisioning must be unavailable (HTTP ${signup.status})`);
  assert.equal(sessionCookie(signup), undefined);
  assert.equal(withDatabase(server, database => database.prepare('SELECT count(*) AS n FROM users').get().n), 0);
  const shared = await server.request('/api/login', { method: 'POST', headers: remoteHeaders, body: { password } });
  assertDenied(shared, 'shared-password login while account mode is enabled');
});

test('account sessions revoke on credential changes and empty MFA secrets fail closed', async t => {
  const server = await fixture(t, { accounts: true });
  const salt = randomBytes(16).toString('hex');
  const hashPassword = value => scryptSync(value, salt, 64).toString('hex');
  withDatabase(server, database => database.prepare('INSERT INTO users (email,salt,pw_hash) VALUES (?,?,?)').run(accountEmail, salt, hashPassword(accountPassword)));
  const login = await server.request('/api/login', { method: 'POST', headers: remoteHeaders, body: { email: accountEmail, password: accountPassword } });
  assert.equal(login.status, 200);
  const cookie = sessionCookie(login);
  assert.ok(cookie);
  assert.equal((await server.request('/api/state', { headers: { ...remoteHeaders, cookie } })).status, 200);
  const changedPassword = accountPassword + '-changed';
  withDatabase(server, database => database.prepare('UPDATE users SET pw_hash=? WHERE email=?').run(hashPassword(changedPassword), accountEmail));
  assertDenied(await server.request('/api/state', { headers: { ...remoteHeaders, cookie } }), 'session after account password change');
  withDatabase(server, database => database.prepare("UPDATE users SET totp_enabled=1,totp_secret='' WHERE email=?").run(accountEmail));
  const mfaStart = await server.request('/api/login', { method: 'POST', headers: remoteHeaders, body: { email: accountEmail, password: changedPassword } });
  assert.equal(sessionCookie(mfaStart), undefined, 'Corrupt MFA configuration must never issue a session at password login');
  if (mfaStart.status === 200) {
    assert.equal(mfaStart.json?.mfa, true);
    assert.ok(mfaStart.json.ticket);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac('sha1', Buffer.alloc(0)).update(counter).digest();
    const offset = digest.at(-1) & 15;
    const code = String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
    assertDenied(await server.request('/api/login/mfa', { method: 'POST', headers: remoteHeaders, body: { ticket: mfaStart.json.ticket, code } }), 'predictable code derived from an empty MFA secret');
  } else {
    assert.ok([400, 401, 403, 409, 503].includes(mfaStart.status), `Corrupt MFA login must fail closed (HTTP ${mfaStart.status})`);
  }
});

test('fresh correct MFA passwords do not reset the independent eight-code verification budget',async t=>{
  const server=await fixture(t,{accounts:true});seedMfaAccount(server,true);
  async function beginPasswordPhase(){
    const login=await server.request('/api/login',{method:'POST',headers:remoteHeaders,body:{email:accountEmail,password:accountPassword}});
    assert.equal(login.status,200,'Correct account passwords must remain usable between factor attempts');assert.equal(login.json.mfa,true);assert.ok(login.json.ticket);assert.equal(sessionCookie(login),undefined);return login.json.ticket;
  }
  for(let attempt=0;attempt<8;attempt++){
    const ticket=await beginPasswordPhase();
    const failed=await server.request('/api/login/mfa',{method:'POST',headers:remoteHeaders,body:{ticket,code:'invalid-fixture-factor'}});
    assert.equal(failed.status,401,`MFA failure ${attempt+1} must consume its own factor attempt`);assert.equal(sessionCookie(failed),undefined);
  }
  const ticket=await beginPasswordPhase();
  const blocked=await server.request('/api/login/mfa',{method:'POST',headers:remoteHeaders,body:{ticket,code:totpCode(enrollmentSecret)}});
  assert.equal(blocked.status,429,'A fresh correct password must not bypass exhausted MFA factor attempts');assert.equal(sessionCookie(blocked),undefined);
  assert.ok(Number(blocked.headers['retry-after'])>0);
  assert.equal(withDatabase(server,database=>database.prepare('SELECT count(*) AS n FROM auth_sessions').get().n),0);
});

for (const action of ['enable', 'disable']) {
  test(`MFA ${action} rechecks a session revoked while its request body is incomplete`, async t => {
    const server = await fixture(t, { accounts: true });
    const { hashPassword } = seedMfaAccount(server, action === 'disable');
    const cookie = await signInAccount(server);
    const before = mfaState(server);
    const body = { code: totpCode(enrollmentSecret), ...(action === 'disable' ? { password: accountPassword } : {}) };
    const delayed = await delayedAuthenticatedBody(server, `/api/mfa/${action}`, cookie, body);
    try {
      if (action === 'enable') {
        // The held request still carries the factor from the old credentials.
        withDatabase(server, database => database.prepare('UPDATE users SET pw_hash=? WHERE email=?').run(hashPassword(accountPassword + '-revoked'), accountEmail));
      } else {
        // Its password and factor are correct; explicit logout must still win.
        assert.equal((await server.request('/api/logout', { method: 'POST', headers: { ...remoteHeaders, cookie }, body: {} })).status, 200);
      }
      delayed.finish();
      const response = await delayed.response;
      assert.equal(response.status, 401, `An in-flight MFA ${action} must reject its revoked session`);
      assert.equal(sessionCookie(response), undefined, 'A revoked session must not be resurrected by an MFA mutation');
      assert.deepEqual(mfaState(server), before, 'Rejected MFA mutation must preserve enrollment and recovery codes');
    } finally {
      delayed.cancel();
    }
  });
}

test('MFA enrollment requires recent authentication and cannot regenerate an enabled account recovery set', async t => {
  const server = await fixture(t, { accounts: true });
  seedMfaAccount(server, false);
  const oldCookie = await signInAccount(server);
  withDatabase(server, database => database.prepare('UPDATE auth_sessions SET created_at=unixepoch()-600 WHERE email=?').run(accountEmail));
  const pending = mfaState(server);
  const oldEnrollment = await server.request('/api/mfa/enable', { method: 'POST', headers: { ...remoteHeaders, cookie: oldCookie }, body: { code: totpCode(enrollmentSecret) } });
  assert.equal(oldEnrollment.status, 401, 'Enrollment must require authentication within the last five minutes');
  assert.equal(sessionCookie(oldEnrollment), undefined);
  assert.deepEqual(mfaState(server), pending);

  withDatabase(server, database => database.prepare('UPDATE users SET totp_enabled=1,recovery=? WHERE email=?').run(existingRecovery, accountEmail));
  const enabledCookie = await signInAccount(server);
  const enabled = mfaState(server);
  for (const oldSession of [false, true]) {
    if (oldSession) withDatabase(server, database => database.prepare('UPDATE auth_sessions SET created_at=unixepoch()-600 WHERE email=?').run(accountEmail));
    const regenerate = await server.request('/api/mfa/enable', { method: 'POST', headers: { ...remoteHeaders, cookie: enabledCookie }, body: { code: totpCode(enrollmentSecret) } });
    assert.ok([400, 401, 403, 409].includes(regenerate.status), `${oldSession ? 'Old' : 'Fresh'} enabled-account session must not use enrollment to regenerate recovery codes`);
    assert.equal(sessionCookie(regenerate), undefined);
    assert.deepEqual(mfaState(server), enabled, 'An already-enabled enrollment must preserve the existing recovery set');
  }
});
