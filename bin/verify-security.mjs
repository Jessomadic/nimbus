#!/usr/bin/env node
// Verify only this owner's Nimbus deployment. No inference, task submission,
// remote account mutations, credentials in receipts, or TLS bypasses.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {protect,unprotect} from '../runtime/credentials.js';
const data=path.resolve(process.env.NIMBUS_DATA||'data'),folder=path.join(data,'verification');
fs.mkdirSync(folder,{recursive:true});
const legacyFile=path.join(folder,'pre-hardening-session.dpapi');
async function password(){return process.env.NIMBUS_PASSWORD||(process.env.NIMBUS_PASSWORD_DPAPI?await unprotect(fs.readFileSync(path.resolve(process.env.NIMBUS_PASSWORD_DPAPI),'utf8')):'');}
if(process.argv.includes('--prepare')){
  const response=await fetch(`http://127.0.0.1:${process.env.PORT||8787}/api/login`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:await password()})});
  assert.equal(response.status,200,'Pre-deployment owner sign-in');
  const cookie=response.headers.getSetCookie().find(value=>value.startsWith('nimbus_session='))?.split(';')[0];
  assert.ok(cookie);fs.writeFileSync(legacyFile,await protect(cookie),{mode:0o600});
  console.log('Pre-deployment test session saved with Windows DPAPI. No credential was printed.');process.exit(0);
}
const origin=new URL(process.argv[2]||'https://nimbus.jessecopas.com');
assert.equal(origin.protocol,'https:');assert.ok(!origin.username&&!origin.password);
const file=path.join(folder,'security-hardening-live.json'),receipt={origin:origin.origin,startedAt:new Date().toISOString(),checks:[]};
const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2)+'\n');
const dns=await(await fetch('https://cloudflare-dns.com/dns-query?name='+encodeURIComponent(origin.hostname)+'&type=A',{headers:{accept:'application/dns-json'}})).json();
const address=dns.Answer?.find(answer=>answer.type===1)?.data;assert.ok(address,'Public DNS must resolve');
// Keep the actual hostname for SNI and normal certificate/hostname validation.
const lookup=(_hostname,options,callback)=>options.all?callback(null,[{address,family:4}]):callback(null,address,4);
let session='';
function request(route,{method='GET',body,headers={},stream=false}={}){return new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=https.request({hostname:origin.hostname,port:origin.port||443,path:route,method,lookup,agent:false,headers:{...(session?{cookie:session}:{}),...(payload===undefined?{}:{origin:origin.origin,'content-type':'application/json','content-length':Buffer.byteLength(payload)}),...headers}},res=>{
    if(stream){res.resume();resolve({status:res.statusCode,response:res,closed:new Promise(done=>{res.once('end',done);res.once('close',done);})});return;}
    const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{
      const text=Buffer.concat(chunks).toString('utf8');let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:res.statusCode,headers:res.headers,value});
    });
  });req.setTimeout(20000,()=>req.destroy(new Error('HTTPS verification timeout')));req.on('error',reject);req.end(payload);
});}
async function check(name,fn){const row={name};receipt.checks.push(row);save();try{row.result=await fn();row.pass=true;}catch(error){row.pass=false;row.error=error.message;process.exitCode=1;}save();console.log(`${row.pass?'PASS':'FAIL'} ${name}${row.error?': '+row.error:''}`);}
await check('public health reveals no private runtime metadata',async()=>{const r=await request('/health');assert.equal(r.status,200);assert.deepEqual(r.value,{ok:true});return{status:r.status,fields:Object.keys(r.value)};});
await check('login is protected by TLS, CSP nonces, framing denial and no-store',async()=>{
  const r=await request('/login');assert.equal(r.status,200);
  const nonce=r.headers['content-security-policy']?.match(/'nonce-([^']+)'/)?.[1];assert.ok(nonce);assert.ok(r.value.includes(`<script nonce="${nonce}">`));
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(r.headers['content-security-policy']));assert.equal(r.headers['x-frame-options'],'DENY');assert.equal(r.headers['x-content-type-options'],'nosniff');
  assert.equal(r.headers['cache-control'],'no-store');assert.match(r.headers['strict-transport-security'],/max-age=31536000/);
  return{status:r.status,cspNonce:true,noStore:true,httpsEnforced:true};
});
await check('anonymous access to data, execution, browser, terminal and maintenance APIs is denied',async()=>{
  const routes=['/api/state','/api/events','/api/tasks','/api/runtime','/api/runtime/config','/api/bots/1/memory','/api/bots/1/files','/api/threads/bot%3A1/messages','/api/browser-groups','/api/browser/1/fixture/screenshot','/api/files/'+'a'.repeat(24)+'/fixture.txt','/api/terminals','/api/questions','/api/updates','/api/capabilities'];
  const statuses={};for(const route of routes){const r=await request(route);statuses[route]=r.status;assert.equal(r.status,401,route);}return statuses;
});
await check('anonymous commands and account creation are denied before execution',async()=>{
  const statuses={};for(const route of ['/api/tasks','/api/uploads','/api/updates','/api/terminals','/api/admin/restart','/api/signup','/api/threads/bot%3A1/messages']){
    const r=await request(route,{method:'POST',body:{}});statuses[route]=r.status;assert.ok([401,403].includes(r.status),route);
  }return statuses;
});
await check('forged cookies and pre-hardening sessions cannot authenticate',async()=>{
  for(const cookie of ['__Host-nimbus_session='+'0'.repeat(64),'nimbus_session='+'0'.repeat(64),'__Host-nimbus_session=invalid'])assert.equal((await request('/api/state',{headers:{cookie}})).status,401);
  let legacyRevoked=false;
  if(fs.existsSync(legacyFile)){
    const legacy=await unprotect(fs.readFileSync(legacyFile,'utf8')),token=legacy.split('=')[1];
    assert.equal((await request('/api/state',{headers:{cookie:'__Host-nimbus_session='+token}})).status,401);legacyRevoked=true;fs.unlinkSync(legacyFile);
  }
  assert.equal(legacyRevoked,true,'Prepare a pre-deployment session to verify migration revocation');return{forgedDenied:3,legacyRevoked};
});
await check('remote requests cannot redeem localhost sign-in links',async()=>{const r=await request('/local-login?ticket='+'0'.repeat(64));assert.equal(r.status,403);return{status:r.status};});
await check('an incorrect password receives no session',async()=>{const r=await request('/api/login',{method:'POST',body:{password:'intentionally-wrong-security-verification'}});assert.equal(r.status,401);assert.ok(!r.headers['set-cookie']);return{status:r.status};});
await check('the existing correct password issues a bounded protected session stored as a hash',async()=>{
  const r=await request('/api/login',{method:'POST',body:{password:await password()}});assert.equal(r.status,200);
  const cookie=r.headers['set-cookie']?.find(value=>value.startsWith('__Host-nimbus_session='));assert.ok(cookie);
  for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/','Max-Age=86400'])assert.ok(cookie.includes(flag));assert.ok(!cookie.includes('Domain='));session=cookie.split(';')[0];
  const raw=session.split('=')[1],database=new DatabaseSync(path.join(data,'nimbus.db'),{readOnly:true});
  try{assert.equal(database.prepare('SELECT token FROM auth_sessions WHERE token=?').get(raw),undefined);const row=database.prepare('SELECT * FROM auth_sessions WHERE token=?').get(createHash('sha256').update(raw).digest('hex'));assert.ok(row?.binding);assert.ok(row.last_seen);}finally{database.close();}
  return{status:r.status,hostOnly:true,secure:true,httpOnly:true,absoluteHours:24,idleHours:8,hashedStorage:true};
});
if(session){
  await check('authenticated app and private APIs load without cache storage',async()=>{
    const statuses={};for(const route of ['/','/app.js','/runtime.js','/team-tree.js','/vendor/qrcode.min.js','/api/state']){const r=await request(route);assert.equal(r.status,200,route);assert.equal(r.headers['cache-control'],'no-store',route);statuses[route]=r.status;}
    const js=await request('/app.js');assert.ok(!js.value.includes('cdnjs.cloudflare.com'));return statuses;
  });
  await check('a valid remote session cannot use local administration or cross-origin writes',async()=>{
    const admin=await request('/api/admin/login-ticket',{method:'POST',body:{}});assert.equal(admin.status,403);
    const cross=await request('/api/logout',{method:'POST',body:{},headers:{origin:'https://unrelated.example.invalid'}});assert.equal(cross.status,403);assert.equal((await request('/api/state')).status,200);
    return{localAdmin:admin.status,crossOrigin:cross.status,sessionStillValid:true};
  });
  await check('logout closes an open public event stream and rejects session replay',async()=>{
    const stream=await request('/api/events',{stream:true});assert.equal(stream.status,200);
    try{const logout=await request('/api/logout',{method:'POST',body:{}});assert.equal(logout.status,200);
      let closed=false;await Promise.race([stream.closed.then(()=>closed=true),new Promise(resolve=>setTimeout(resolve,5000))]);assert.equal(closed,true,'Event stream must close after logout');
      assert.equal((await request('/api/state')).status,401);return{logout:200,streamClosed:true,replayedSession:401};
    }finally{stream.response.destroy();}
  });
}
receipt.finishedAt=new Date().toISOString();receipt.passed=receipt.checks.filter(row=>row.pass).length;receipt.total=receipt.checks.length;save();
console.log(JSON.stringify({receipt:file,passed:receipt.passed,total:receipt.total}));
