import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {SessionStore,LoginThrottle} from '../runtime/auth.js';
import {addClient,broadcast,revokeClients,revalidateClients} from '../events.js';

const hash=value=>createHash('sha256').update(value).digest('hex');

function fixture(t,{absoluteSeconds=100,idleSeconds=30}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  let clock=10000;
  const identities=new Map([
    ['',{passwordVersion:'shared-fixture-v1',mfaVersion:'disabled'}],
    ['fixture@example.invalid',{passwordVersion:'account-fixture-v1',mfaVersion:'enrollment-v1'}],
  ]);
  const binding=email=>{
    const identity=identities.get(email);
    return identity?hash(JSON.stringify([identity.passwordVersion,identity.mfaVersion])):null;
  };
  const now=()=>clock;
  const store=new SessionStore({db,binding,now,absoluteSeconds,idleSeconds});
  return{db,store,identities,binding,now,advance:seconds=>clock+=seconds};
}

class Response extends EventEmitter{
  writes=[];ended=false;endCount=0;
  write(line){assert.equal(this.ended,false,'An ended response must never receive a broadcast');this.writes.push(line);return true;}
  end(){this.ended=true;this.endCount++;this.emit('close');}
}

function response(t){const res=new Response();t.after(()=>{if(!res.ended)res.end();});return res;}

test('session cookies contain random bearer tokens while SQLite stores only their digests',t=>{
  const {db,store}=fixture(t);
  const token=store.issue(),second=store.issue();
  assert.match(token,/^[a-f0-9]{64}$/);assert.notEqual(token,second);
  const rows=db.prepare('SELECT * FROM auth_sessions').all();
  assert.equal(rows.length,2);
  assert.deepEqual(new Set(rows.map(row=>row.token)),new Set([hash(token),hash(second)]));
  assert.equal(JSON.stringify(rows).includes(token),false);
  assert.equal(JSON.stringify(rows).includes(second),false);
  assert.equal(store.authenticate(token).email,'');
});

test('missing, malformed, unknown and tampered cookies never authenticate',t=>{
  const {db,store}=fixture(t);const token=store.issue();
  const tampered=(token[0]==='0'?'1':'0')+token.slice(1);
  for(const invalid of [undefined,null,'',0,{},[],token.slice(1),token+'0','g'.repeat(64),'0'.repeat(64),tampered]){
    assert.equal(store.authenticate(invalid),null);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,1);
  assert.ok(store.authenticate(token));
});

test('absolute expiry ends even an actively refreshed session at the exact boundary',t=>{
  const {db,store,advance}=fixture(t,{absoluteSeconds:100,idleSeconds:40});const token=store.issue();
  advance(35);assert.ok(store.authenticate(token));
  advance(35);assert.ok(store.authenticate(token));
  advance(29);assert.ok(store.authenticate(token));
  advance(1);assert.equal(store.authenticate(token),null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,0);
});

test('normal requests renew idle expiry while read-only session checks do not',t=>{
  const {db,store,advance}=fixture(t);const token=store.issue();
  advance(20);assert.ok(store.authenticate(token));
  advance(29);assert.ok(store.authenticate(token,{touch:false}));
  assert.equal(db.prepare('SELECT last_seen FROM auth_sessions').get().last_seen,10020);
  advance(1);assert.equal(store.authenticate(token,{touch:false}),null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,0);
});

for(const [name,email,change] of [
  ['shared password rotation','',identity=>identity.passwordVersion='shared-fixture-v2'],
  ['account password rotation','fixture@example.invalid',identity=>identity.passwordVersion='account-fixture-v2'],
  ['MFA enrollment version change','fixture@example.invalid',identity=>identity.mfaVersion='enrollment-v2'],
  ['MFA removal','fixture@example.invalid',identity=>identity.mfaVersion='disabled'],
]){
  test(`${name} revokes previously issued sessions`,t=>{
    const {db,store,identities}=fixture(t);const token=store.issue(email);
    const previous={...identities.get(email)};
    assert.ok(store.authenticate(token));change(identities.get(email));
    assert.equal(store.authenticate(token),null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,0);
    identities.set(email,previous);assert.equal(store.authenticate(token),null,'Restoring settings must not restore a revoked token');
    assert.ok(store.authenticate(store.issue(email)));
  });
}

test('removing account membership revokes sessions and prevents issuance',t=>{
  const {db,store,identities}=fixture(t);const email='fixture@example.invalid',token=store.issue(email);
  identities.delete(email);assert.equal(store.authenticate(token),null);
  assert.throws(()=>store.issue(email),/no longer enabled/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,0);
});

test('explicit logout revokes exactly its bearer token',t=>{
  const {store}=fixture(t);const first=store.issue(),second=store.issue();
  store.revoke(first);store.revoke(first);store.revoke(undefined);
  assert.equal(store.authenticate(first),null);assert.ok(store.authenticate(second));
});

test('legacy raw-token rows are invalidated once and new-format sessions survive recreation',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const legacy='a'.repeat(64),binding=()=>hash('fixture-credential'),now=()=>10000;
  db.exec("CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,created_at INTEGER,email TEXT DEFAULT '')");
  db.prepare('INSERT INTO auth_sessions VALUES(?,?,?)').run(legacy,9999,'');
  const first=new SessionStore({db,binding,now});
  assert.equal(first.authenticate(legacy),null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,0);
  const token=first.issue();
  const recreated=new SessionStore({db,binding,now});
  assert.ok(recreated.authenticate(token));
  assert.notEqual(db.prepare('SELECT token FROM auth_sessions').get().token,token);
});

test('startup removes expired rows while retaining a current session',t=>{
  const {db,store,binding,now,advance}=fixture(t);
  const idleExpired=store.issue();advance(20);const active=store.issue();advance(10);
  const recreated=new SessionStore({db,binding,now,absoluteSeconds:100,idleSeconds:30});
  assert.equal(recreated.authenticate(idleExpired),null);assert.ok(recreated.authenticate(active));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auth_sessions').get().n,1);
});

test('parallel callers reserve attempts before awaiting body or credential verification',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const throttle=new LoginThrottle({db,now:()=>10000});
  let finishBodies;const bodiesPending=new Promise(resolve=>finishBodies=resolve);
  const admitted=[];
  const requests=Array.from({length:40},(_,index)=>(async()=>{
    const decision=throttle.reserve('synthetic-client',{limit:8,windowSeconds:900});
    if(!decision.allowed)return{index,allowed:false};
    admitted.push(index);await bodiesPending;return{index,allowed:true};
  })());
  assert.equal(admitted.length,8,'Pending bodies must not permit another reservation');
  assert.deepEqual(throttle.reserve('synthetic-client'),{allowed:false,retryAfter:900});
  finishBodies();const results=await Promise.all(requests);
  assert.equal(results.filter(row=>row.allowed).length,8);
  assert.equal(results.filter(row=>!row.allowed).length,32);
});

test('attempt limits persist across closing and reopening their SQLite database',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-security-auth-'));
  const file=path.join(root,'attempts.sqlite');let db;
  t.after(()=>{
    db?.close();
    const target=path.resolve(root),parent=path.resolve(os.tmpdir());
    assert.equal(path.dirname(target),parent);assert.ok(path.basename(target).startsWith('nimbus-security-auth-'));
    fs.rmSync(target,{recursive:true,force:true});
  });
  db=new DatabaseSync(file);let throttle=new LoginThrottle({db,now:()=>10000});
  for(let i=0;i<8;i++)assert.equal(throttle.reserve('synthetic-client').allowed,true);
  db.close();db=new DatabaseSync(file);throttle=new LoginThrottle({db,now:()=>10030});
  assert.deepEqual(throttle.reserve('synthetic-client'),{allowed:false,retryAfter:870});
  assert.equal(db.prepare('SELECT bucket FROM auth_attempts').get().bucket,hash('synthetic-client'));
});

test('successful sign-in reset affects only its bucket and expired limits reset at the boundary',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());let clock=10000;
  const throttle=new LoginThrottle({db,now:()=>clock}),options={limit:2,windowSeconds:60};
  for(const bucket of ['synthetic-client','synthetic-account']){
    assert.equal(throttle.reserve(bucket,options).allowed,true);
    assert.equal(throttle.reserve(bucket,options).allowed,true);
    assert.deepEqual(throttle.reserve(bucket,options),{allowed:false,retryAfter:60});
  }
  throttle.clear('synthetic-client');
  assert.equal(throttle.reserve('synthetic-client',options).allowed,true);
  assert.deepEqual(throttle.reserve('synthetic-account',options),{allowed:false,retryAfter:60});
  clock=10059;assert.deepEqual(throttle.reserve('synthetic-account',options),{allowed:false,retryAfter:1});
  clock=10060;assert.equal(throttle.reserve('synthetic-account',options).allowed,true);
  assert.equal(throttle.reserve('synthetic-account',options).allowed,true);
  assert.deepEqual(throttle.reserve('synthetic-account',options),{allowed:false,retryAfter:60});
});

test('revoking a session ends every matching SSE tab and prevents subsequent broadcasts',t=>{
  const first=response(t),second=response(t),other=response(t);
  addClient(first,{sessionToken:'synthetic-session-a'});addClient(second,{sessionToken:'synthetic-session-a'});
  addClient(other,{sessionToken:'synthetic-session-b'});
  broadcast('fixture',{sequence:1});assert.equal(first.writes.length,1);assert.equal(second.writes.length,1);
  revokeClients('synthetic-session-a');revokeClients('synthetic-session-a');
  assert.equal(first.endCount,1);assert.equal(second.endCount,1);assert.equal(other.ended,false);
  broadcast('fixture',{sequence:2});
  assert.equal(first.writes.length,1);assert.equal(second.writes.length,1);assert.equal(other.writes.length,2);
});

test('SSE revalidation expires idle sessions without receiving another HTTP request',t=>{
  const {store,advance}=fixture(t);const token=store.issue(),res=response(t);
  addClient(res,{sessionToken:token,authorized:()=>!!store.authenticate(token,{touch:false})});
  advance(29);broadcast('fixture',{sequence:1});assert.equal(res.writes.length,1);
  advance(1);revalidateClients();assert.equal(res.endCount,1);
  broadcast('fixture',{sequence:2});assert.equal(res.writes.length,1);
});

test('broadcast revalidates account credentials before writing private SSE data',t=>{
  const {store,identities}=fixture(t);const email='fixture@example.invalid',token=store.issue(email),res=response(t);
  addClient(res,{sessionToken:token,authorized:()=>!!store.authenticate(token,{touch:false})});
  identities.delete(email);broadcast('private_fixture',{mustNotArrive:true});
  assert.equal(res.endCount,1);assert.equal(res.writes.length,0);
});

test('closed SSE connections are removed even when their authorization callback is valid',t=>{
  const res=response(t);addClient(res,{authorized:()=>true,sessionToken:'synthetic-closed-session'});
  res.end();broadcast('fixture',{mustNotArrive:true});revalidateClients();revokeClients('synthetic-closed-session');
  assert.equal(res.endCount,1);assert.equal(res.writes.length,0);
});
