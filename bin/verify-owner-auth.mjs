#!/usr/bin/env node
// Public checks never enroll a credential or substitute a synthetic device for
// the owner's actual passkey. Real signatures are exercised by isolated tests.
import fs from 'node:fs';import path from 'node:path';import https from 'node:https';import assert from 'node:assert/strict';
import {unprotect} from '../runtime/credentials.js';
const origin=new URL(process.env.NIMBUS_PUBLIC_ORIGIN||'https://nimbus.jessecopas.com');
assert.equal(origin.protocol,'https:');assert.ok(!origin.username&&!origin.password);
const data=path.resolve(process.env.NIMBUS_DATA||'data'),file=path.join(data,'verification',`owner-auth-${Date.now()}.json`),receipt={origin:origin.origin,at:new Date().toISOString(),checks:[]};
fs.mkdirSync(path.dirname(file),{recursive:true});const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2)+'\n');
const dns=await(await fetch('https://cloudflare-dns.com/dns-query?name='+origin.hostname+'&type=A',{headers:{accept:'application/dns-json'}})).json();
const address=dns.Answer?.find(row=>row.type===1)?.data;assert.ok(address);
function request(route,body,headers={}){return new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=https.request({hostname:origin.hostname,port:origin.port||443,path:route,method:payload===undefined?'GET':'POST',lookup:(_h,o,cb)=>o.all?cb(null,[{address,family:4}]):cb(null,address,4),headers:{...(payload===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(payload),origin:origin.origin}),...headers}},res=>{
    let text='';res.on('data',part=>text+=part);res.on('error',reject);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,json,text});});
  });req.setTimeout(20000,()=>req.destroy(new Error('Public authentication check timed out')));req.on('error',reject);req.end(payload);
});}
const fullSession=r=>(r.headers['set-cookie']||[]).some(value=>/^(?:__Host-)?nimbus_session=[a-f0-9]{64}/.test(value));
async function check(name,fn){const row={name};receipt.checks.push(row);save();try{row.result=await fn();row.pass=true;}catch(e){row.error=e.message;row.pass=false;process.exitCode=1;}save();console.log(`${row.pass?'PASS':'FAIL'} ${name}${row.error?': '+row.error:''}`);}
await check('public login advertises required username, password and passkey',async()=>{
  const r=await request('/api/auth-methods');assert.equal(r.status,200);assert.equal(r.json.username,true);assert.equal(r.json.passkeyRequired,true);assert.equal(r.json.passkeyOrigin,origin.origin);assert.equal(r.json.signup,false);
  const page=await request('/login');assert.equal(page.status,200);assert.ok(page.text.includes('id="username"'));assert.ok(page.text.includes('/passkeys.js'));assert.equal(page.headers['cache-control'],'no-store');return{username:true,passkeyRequired:true,signup:false};
});
await check('private APIs and passkey administration remain protected',async()=>{
  const statuses={};for(const route of ['/api/state','/api/events','/api/tasks','/api/passkeys','/api/terminals','/api/updates']){const r=await request(route);assert.equal(r.status,401);statuses[route]=r.status;}
  const admin=await request('/api/admin/passkeys/enrollment-ticket',{});assert.ok([401,403].includes(admin.status));statuses.enrollmentTicket=admin.status;return statuses;
});
const password=process.env.NIMBUS_PASSWORD||await unprotect(fs.readFileSync(path.resolve(process.env.NIMBUS_PASSWORD_DPAPI),'utf8'));
await check('the correct password without a username cannot authenticate',async()=>{const r=await request('/api/login',{password});assert.equal(r.status,401);assert.equal(fullSession(r),false);return{status:r.status,session:false};});
await check('the correct username and password never bypass the passkey',async()=>{
  const r=await request('/api/login',{username:process.env.NIMBUS_USERNAME,password});assert.equal(fullSession(r),false);
  if(r.status===200){
    assert.equal(r.json.passkeyRequired,true);assert.ok(r.json.ticket);assert.equal(typeof r.json.enrollmentRequired,'boolean');
    const preauth=r.headers['set-cookie']?.find(value=>value.startsWith('__Host-nimbus_preauth='))?.split(';')[0];assert.ok(preauth);
    const cookie={cookie:preauth},ceremony=r.json.enrollmentRequired?'registration':'authentication';
    const options=await request('/api/passkeys/'+ceremony+'/options',{ticket:r.json.ticket},cookie);assert.equal(options.status,200);assert.ok(options.json.challenge);
    if(r.json.enrollmentRequired){assert.equal(options.json.rp.id,origin.hostname);assert.equal(options.json.authenticatorSelection.userVerification,'required');}
    else{assert.equal(options.json.rpId,origin.hostname);assert.equal(options.json.userVerification,'required');}
    assert.equal((await request('/api/state',undefined,cookie)).status,401);
  }
  else{assert.equal(r.status,403);assert.match(r.json.error,/recovery/i);}
  return{status:r.status,session:false,firstDeviceEnrollmentOffered:r.json.enrollmentRequired===true};
});
await check('fake passkey responses cannot issue a session',async()=>{const r=await request('/api/passkeys/authentication/verify',{ticket:'0'.repeat(64),response:{id:'fake',rawId:'fake',type:'public-key',response:{}}});assert.ok([400,401].includes(r.status));assert.equal(fullSession(r),false);return{status:r.status,session:false};});
const old=path.join(data,'verification','pre-hardening-session.dpapi');
if(fs.existsSync(old))await check('sessions from password-only mode are revoked',async()=>{const raw=(await unprotect(fs.readFileSync(old,'utf8'))).split('=')[1];const r=await request('/api/state',undefined,{cookie:'__Host-nimbus_session='+raw});assert.equal(r.status,401);fs.unlinkSync(old);return{status:r.status};});
receipt.passed=receipt.checks.filter(row=>row.pass).length;receipt.total=receipt.checks.length;receipt.physicalPasskeyEnrollment='Requires the owner on their own device';save();console.log(JSON.stringify({receipt:file,passed:receipt.passed,total:receipt.total}));
