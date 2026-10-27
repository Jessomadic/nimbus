import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import * as realWebAuthn from '@simplewebauthn/server';
import {PasskeyStore} from '../runtime/passkeys.js';
import {PasskeyAuthenticator} from './helpers/passkey-authenticator.mjs';

const ORIGIN='https://nimbus.example.test',USERNAME='Jessomadic';
const opaque=()=>randomBytes(32).toString('hex');
const rejected=status=>error=>Number.isInteger(error.statusCode)&&(status===undefined||error.statusCode===status);

function fixture(t,{webAuthn={}}={}){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  let clock=1900000000000,binding='synthetic-password-version-1';
  const configuration={db,rpOrigin:ORIGIN,username:USERNAME,binding:()=>binding,now:()=>clock,webAuthn};
  const store=new PasskeyStore(configuration);
  return{db,store,configuration,browser:opaque(),advance:milliseconds=>clock+=milliseconds,rotate:value=>binding=value,now:()=>clock};
}

function snapshot(db){return{owner:db.prepare('SELECT * FROM passkey_owner ORDER BY id').all(),credentials:db.prepare('SELECT * FROM passkey_credentials ORDER BY id').all()};}

async function registration(f,{device=new PasskeyAuthenticator(),browser=f.browser,label='Fixture device',authorized}={}){
  const ticket=f.store.begin({kind:'register',browserToken:browser,label,...(authorized?{authorized}:{})});
  const options=await f.store.registrationOptions(ticket,browser);
  return{device,ticket,options,browser,response:device.register(options,{origin:ORIGIN})};
}

async function enroll(f,settings={}){
  const value=await registration(f,settings);
  assert.deepEqual(await f.store.verifyRegistration(value.ticket,value.browser,value.response),{verified:true});return value.device;
}

async function authentication(f,device,overrides={}){
  const ticket=f.store.begin({kind:'authenticate',browserToken:f.browser});
  const options=await f.store.authenticationOptions(ticket,f.browser);
  return{ticket,options,response:device.authenticate(options,{origin:ORIGIN,...overrides})};
}

function pausedVerification(method){
  let arrived,release;
  const reached=new Promise(resolve=>arrived=resolve),resume=new Promise(resolve=>release=resolve);
  return{reached,release,webAuthn:{[method]:async options=>{const result=await realWebAuthn[method](options);arrived();await resume;return result;}}};
}

test('RP configuration accepts only a fixed canonical HTTPS origin and exact hostname',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  for(const rpOrigin of ['http://nimbus.example.test','https://nimbus.example.test/','https://nimbus.example.test/path','https://user:password@nimbus.example.test','https://nimbus.example.test?query=1','https://nimbus.example.test#fragment','https://NIMBUS.example.test',null,'not a URL']){
    assert.throws(()=>new PasskeyStore({db,rpOrigin,username:USERNAME,binding:()=>opaque()}),/HTTPS passkey origin/);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n,0,'Invalid configuration must not initialize persistence');
  const store=new PasskeyStore({db,rpOrigin:'https://nimbus.example.test:444',username:USERNAME,binding:()=>opaque()});
  assert.equal(store.rpOrigin,'https://nimbus.example.test:444');assert.equal(store.rpID,'nimbus.example.test');
});

test('a single random opaque owner handle persists across store recreation',t=>{
  const f=fixture(t),owner=f.db.prepare('SELECT * FROM passkey_owner').get();
  assert.equal(owner.user_handle.length,32);assert.notDeepEqual(Buffer.from(owner.user_handle),Buffer.alloc(32));assert.equal(f.store.version(),0);
  const recreated=new PasskeyStore(f.configuration);
  assert.deepEqual(f.db.prepare('SELECT * FROM passkey_owner').get(),owner);assert.equal(recreated.count(),0);
  assert.throws(()=>f.db.prepare('INSERT INTO passkey_owner VALUES(2,?,0)').run(randomBytes(32)),/CHECK constraint/);
});

test('bootstrap authorization is single-use, expires in fifteen minutes and follows the current binding',t=>{
  const f=fixture(t),before=snapshot(f.db),value=f.store.createBootstrap();assert.match(value,/^[a-f0-9]{64}$/);
  assert.equal(f.store.consumeBootstrap(opaque()),false);assert.equal(f.store.consumeBootstrap(value),true);assert.equal(f.store.consumeBootstrap(value),false);
  const expired=f.store.createBootstrap();f.advance(15*60_000);assert.equal(f.store.consumeBootstrap(expired),false);
  const rotated=f.store.createBootstrap();f.rotate('synthetic-password-version-2');assert.equal(f.store.consumeBootstrap(rotated),false);
  assert.deepEqual(snapshot(f.db),before,'Bootstrap capabilities must never persist bearer tokens or create credentials');
  f.rotate(null);assert.throws(()=>f.store.createBootstrap(),rejected(401));
});

test('adding a passkey invalidates older bootstrap capabilities',async t=>{
  const f=fixture(t),bootstrap=f.store.createBootstrap();await enroll(f);
  assert.equal(f.store.consumeBootstrap(bootstrap),false);assert.equal(f.store.version(),1);
});

test('ticket input, kind, browser and issuance state are enforced before verification',async t=>{
  const f=fixture(t);
  for(const settings of [{kind:'unknown',browserToken:f.browser},{kind:'register',browserToken:''},{kind:'register',browserToken:f.browser,label:'x'.repeat(81)},{kind:'register',browserToken:f.browser,label:'unsafe\nlabel'}])assert.throws(()=>f.store.begin(settings),rejected(400));
  assert.throws(()=>f.store.begin({kind:'authenticate',browserToken:f.browser}),rejected(401),'There is no passkey-free authentication fallback');
  const ticket=f.store.begin({kind:'register',browserToken:f.browser});
  await assert.rejects(f.store.authenticationOptions(ticket,f.browser),rejected(401));
  await assert.rejects(f.store.registrationOptions(ticket,opaque()),rejected(401));
  await assert.rejects(f.store.verifyRegistration(ticket,f.browser,{}),rejected(401),'Verification before a challenge consumes the ticket');
  await assert.rejects(f.store.registrationOptions(ticket,f.browser),rejected(401));
  assert.equal(f.store.count(),0);assert.equal(f.store.version(),0);
});

test('concurrent options requests generate exactly one challenge and return independent JSON copies',async t=>{
  let generations=0;
  const f=fixture(t,{webAuthn:{generateRegistrationOptions:async options=>{generations++;return realWebAuthn.generateRegistrationOptions(options);}}});
  const ticket=f.store.begin({kind:'register',browserToken:f.browser});
  const [first,second]=await Promise.all([f.store.registrationOptions(ticket,f.browser),f.store.registrationOptions(ticket,f.browser)]);
  assert.equal(generations,1);assert.equal(first.challenge,second.challenge);assert.notEqual(first,second);
  assert.equal(first.rp.id,'nimbus.example.test');assert.equal(first.user.name,USERNAME);assert.equal(Buffer.from(first.user.id,'base64url').length,32);
  assert.equal(first.authenticatorSelection.userVerification,'required');assert.equal(first.authenticatorSelection.residentKey,'required');
  first.challenge='caller-mutation';first.user.id='caller-mutation';
  assert.deepEqual(await f.store.registrationOptions(ticket,f.browser),second);assert.equal(generations,1);
});

test('real none-attestation enrollment and P256 authentication persist only public credential metadata',async t=>{
  const f=fixture(t),device=await enroll(f,{label:'Personal fixture'});
  assert.equal(f.store.count(),1);assert.equal(f.store.version(),1);
  assert.deepEqual(f.store.list(),[{id:device.id,label:'Personal fixture',createdAt:f.now(),lastUsedAt:null}]);
  let row=f.db.prepare('SELECT * FROM passkey_credentials').get();
  assert.deepEqual(Buffer.from(row.public_key),device.publicKey);assert.equal(row.counter,0);assert.equal(row.device_type,'singleDevice');assert.equal(row.backed_up,0);assert.deepEqual(JSON.parse(row.transports),['internal']);
  f.advance(2000);const attempt=await authentication(f,device);
  assert.equal(attempt.options.rpId,'nimbus.example.test');assert.equal(attempt.options.userVerification,'required');assert.deepEqual(attempt.options.allowCredentials.map(value=>value.id),[device.id]);
  assert.deepEqual(await f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),{verified:true});
  row=f.db.prepare('SELECT * FROM passkey_credentials').get();assert.equal(row.counter,1);assert.equal(row.last_used_at,f.now());assert.equal(f.store.version(),1);
  assert.deepEqual(Object.keys(f.store.list()[0]).sort(),['createdAt','id','label','lastUsedAt']);
  assert.equal(Object.keys(row).some(key=>/private|secret|password/i.test(key)),false);
});

test('a verified registration can assign a friendly label without changing credential ownership or authentication',async t=>{
  const f=fixture(t),attempt=await registration(f,{label:'Initial fixture label'}),owner=f.db.prepare('SELECT user_handle FROM passkey_owner').get();
  assert.deepEqual(await f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response,{label:'  Phone <fixture>  '}),{verified:true});
  assert.equal(f.store.list()[0].label,'Phone <fixture>');assert.deepEqual(f.db.prepare('SELECT user_handle FROM passkey_owner').get(),owner);
  const proof=await authentication(f,attempt.device);assert.deepEqual(proof.options.allowCredentials.map(value=>value.id),[attempt.device.id]);
  assert.deepEqual(await f.store.verifyAuthentication(proof.ticket,f.browser,proof.response),{verified:true});
  const fallback=await registration(f,{label:'Kept fixture label'});
  await f.store.verifyRegistration(fallback.ticket,f.browser,fallback.response,{label:'   '});
  assert.equal(f.store.list().find(value=>value.id===fallback.device.id).label,'Kept fixture label');
});

test('invalid registration display labels cannot create a credential or change owner version',async t=>{
  const f=fixture(t);
  for(const label of [null,42,'x'.repeat(81),'unsafe\nlabel']){
    const attempt=await registration(f),before=snapshot(f.db);
    await assert.rejects(f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response,{label}),rejected(400));
    assert.deepEqual(snapshot(f.db),before);
  }
});

const badRegistrations=[
  ['wrong origin',{origin:'https://other.example.test'}],
  ['parent origin',{origin:'https://example.test'}],
  ['wrong RP ID',{rpID:'example.test'}],
  ['wrong challenge',{challenge:opaque()}],
  ['missing user verification',{flags:0x41}],
  ['missing user presence',{flags:0x44}],
  ['wrong ceremony type',{clientDataOverrides:{type:'webauthn.get'}}],
  ['outer credential ownership mismatch',{idOverride:randomBytes(32)}],
];
for(const [name,overrides] of badRegistrations){
  test(`real registration rejects ${name} without database changes`,async t=>{
    const f=fixture(t),attempt=await registration(f),before=snapshot(f.db);
    const response=attempt.device.register(attempt.options,{origin:ORIGIN,...overrides});
    await assert.rejects(f.store.verifyRegistration(attempt.ticket,f.browser,response),rejected());
    assert.deepEqual(snapshot(f.db),before);
    await assert.rejects(f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response),rejected(401),'A failed proof cannot reuse its challenge');
  });
}

test('duplicate credential registration fails atomically and keeps the owner version unchanged',async t=>{
  const f=fixture(t),device=await enroll(f),attempt=await registration(f,{device}),before=snapshot(f.db);
  assert.deepEqual(attempt.options.excludeCredentials.map(value=>value.id),[device.id]);
  await assert.rejects(f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response),rejected(409));
  assert.deepEqual(snapshot(f.db),before);
});

const badAuthentications=[
  ['wrong origin',{origin:'https://other.example.test'}],
  ['wrong RP ID',{rpID:'example.test'}],
  ['wrong challenge',{challenge:opaque()}],
  ['wrong signature',{badSignature:true}],
  ['missing user verification',{flags:0x01}],
  ['missing user presence',{flags:0x04}],
  ['wrong user handle',{userHandle:randomBytes(32)}],
  ['unknown credential',{idOverride:randomBytes(32)}],
  ['wrong ceremony type',{clientDataOverrides:{type:'webauthn.create'}}],
];
for(const [name,overrides] of badAuthentications){
  test(`real authentication rejects ${name} without database changes`,async t=>{
    const f=fixture(t),device=await enroll(f),attempt=await authentication(f,device,overrides),before=snapshot(f.db);
    await assert.rejects(f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),rejected());
    assert.deepEqual(snapshot(f.db),before);
    await assert.rejects(f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),rejected(401));
  });
}

test('a signature from another key cannot authenticate an existing credential ID',async t=>{
  const f=fixture(t),device=await enroll(f),imposter=new PasskeyAuthenticator(Buffer.from(device.id,'base64url'));
  imposter.userHandle=device.userHandle;const attempt=await authentication(f,imposter),before=snapshot(f.db);
  await assert.rejects(f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),rejected(400));assert.deepEqual(snapshot(f.db),before);
});

test('optional absent or null assertion user handles are allowed only for an owned credential',async t=>{
  const f=fixture(t),device=await enroll(f);
  const absent=await authentication(f,device);delete absent.response.response.userHandle;
  assert.deepEqual(await f.store.verifyAuthentication(absent.ticket,f.browser,absent.response),{verified:true});
  const nullable=await authentication(f,device,{counter:2,userHandle:null});
  assert.deepEqual(await f.store.verifyAuthentication(nullable.ticket,f.browser,nullable.response),{verified:true});
});

test('counter rollback and equal nonzero counters fail while counterless synced authenticators remain usable',async t=>{
  const f=fixture(t),device=await enroll(f);
  for(let i=0;i<2;i++){const attempt=await authentication(f,device,{counter:0});assert.deepEqual(await f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),{verified:true});}
  const first=await authentication(f,device,{counter:3});await f.store.verifyAuthentication(first.ticket,f.browser,first.response);
  for(const counter of [3,2,0]){
    const attempt=await authentication(f,device,{counter}),before=snapshot(f.db);
    await assert.rejects(f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),rejected(400));assert.deepEqual(snapshot(f.db),before);
  }
});

test('one authentication ticket can authorize only one concurrent verification',async t=>{
  const f=fixture(t),device=await enroll(f),attempt=await authentication(f,device);
  const results=await Promise.allSettled([f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response),f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response)]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(results.filter(value=>value.status==='rejected'&&value.reason.statusCode===401).length,1);
  assert.equal(f.db.prepare('SELECT counter FROM passkey_credentials').get().counter,1);
});

test('wrong-browser, expired and password-rotated tickets cannot verify or mutate credentials',async t=>{
  const f=fixture(t),device=await enroll(f);
  const wrongBrowser=await authentication(f,device),before=snapshot(f.db);
  await assert.rejects(f.store.verifyAuthentication(wrongBrowser.ticket,opaque(),wrongBrowser.response),rejected(401));
  await assert.rejects(f.store.verifyAuthentication(wrongBrowser.ticket,f.browser,wrongBrowser.response),rejected(401));
  const expired=await authentication(f,device);f.advance(5*60_000);
  await assert.rejects(f.store.verifyAuthentication(expired.ticket,f.browser,expired.response),rejected(401));
  const rotated=await authentication(f,device);f.rotate('synthetic-password-version-2');
  await assert.rejects(f.store.verifyAuthentication(rotated.ticket,f.browser,rotated.response),rejected(401));
  assert.deepEqual(snapshot(f.db),before);
});

test('password rotation during a real authentication verification cannot resurrect access',async t=>{
  const gate=pausedVerification('verifyAuthenticationResponse'),f=fixture(t,{webAuthn:gate.webAuthn}),device=await enroll(f),attempt=await authentication(f,device),before=snapshot(f.db);
  const pending=f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response);await gate.reached;
  f.rotate('synthetic-password-version-2');gate.release();await assert.rejects(pending,rejected(401));assert.deepEqual(snapshot(f.db),before);
});

test('password rotation during a real registration verification cannot enroll a key',async t=>{
  const gate=pausedVerification('verifyRegistrationResponse'),f=fixture(t,{webAuthn:gate.webAuthn}),attempt=await registration(f),before=snapshot(f.db);
  const pending=f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response);await gate.reached;
  f.rotate('synthetic-password-version-2');gate.release();await assert.rejects(pending,rejected(401));assert.deepEqual(snapshot(f.db),before);
});

test('logout or session expiry during registration rejects the already verified attestation before persistence',async t=>{
  const gate=pausedVerification('verifyRegistrationResponse'),f=fixture(t,{webAuthn:gate.webAuthn});let authorized=true;
  const attempt=await registration(f,{authorized:()=>authorized}),before=snapshot(f.db);
  const pending=f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response);await gate.reached;
  authorized=false;gate.release();await assert.rejects(pending,rejected(401));assert.deepEqual(snapshot(f.db),before);
});

test('a registration that expires during crypto verification cannot be committed',async t=>{
  const gate=pausedVerification('verifyRegistrationResponse'),f=fixture(t,{webAuthn:gate.webAuthn}),attempt=await registration(f),before=snapshot(f.db);
  const pending=f.store.verifyRegistration(attempt.ticket,f.browser,attempt.response);await gate.reached;
  f.advance(5*60_000);gate.release();await assert.rejects(pending,rejected(401));assert.deepEqual(snapshot(f.db),before);
});

for(const [name,mutate] of [
  ['counter change',(db,id)=>db.prepare('UPDATE passkey_credentials SET counter=17 WHERE id=?').run(id)],
  ['public key replacement',(db,id)=>db.prepare('UPDATE passkey_credentials SET public_key=? WHERE id=?').run(randomBytes(77),id)],
  ['credential deletion',(db,id)=>db.prepare('DELETE FROM passkey_credentials WHERE id=?').run(id)],
]){
  test(`a concurrent ${name} invalidates an in-flight real signature verification`,async t=>{
    const gate=pausedVerification('verifyAuthenticationResponse'),f=fixture(t,{webAuthn:gate.webAuthn}),device=await enroll(f),attempt=await authentication(f,device);
    const pending=f.store.verifyAuthentication(attempt.ticket,f.browser,attempt.response);await gate.reached;
    mutate(f.db,device.id);const afterExternalChange=snapshot(f.db);gate.release();
    await assert.rejects(pending,rejected(401));assert.deepEqual(snapshot(f.db),afterExternalChange,'Rejected verification must not overwrite the intervening change');
  });
}

test('registration and removal bump the owner version, revoke pending ceremonies and never remove the last key',async t=>{
  const f=fixture(t),first=await enroll(f),pending=await authentication(f,first),before=snapshot(f.db);
  assert.throws(()=>f.store.remove(first.id),rejected(409));assert.deepEqual(snapshot(f.db),before);
  const second=await enroll(f);assert.equal(f.store.version(),2);assert.equal(f.store.count(),2);
  await assert.rejects(f.store.verifyAuthentication(pending.ticket,f.browser,pending.response),rejected(401));
  const obsolete=await authentication(f,first);
  assert.deepEqual(f.store.remove(second.id),{removed:true});assert.equal(f.store.version(),3);assert.equal(f.store.count(),1);
  await assert.rejects(f.store.verifyAuthentication(obsolete.ticket,f.browser,obsolete.response),rejected(401));
  const preserved=snapshot(f.db);assert.throws(()=>f.store.remove(opaque()),rejected(400));assert.deepEqual(snapshot(f.db),preserved);
});
