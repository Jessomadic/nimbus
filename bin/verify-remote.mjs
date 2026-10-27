#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import https from 'node:https';import {randomUUID} from 'node:crypto';
import {unprotect} from '../runtime/credentials.js';
const origin=new URL(process.argv[2]||'https://nimbus.jessecopas.com');if(origin.protocol!=='https:'||origin.username||origin.password)throw new Error('An HTTPS application origin is required');
const data=path.resolve(process.env.NIMBUS_DATA||'data'),file=path.join(data,'verification',`remote-${Date.now()}.json`),receipt={origin:origin.origin,checks:[]};
fs.mkdirSync(path.dirname(file),{recursive:true});const save=()=>fs.writeFileSync(file,JSON.stringify(receipt,null,2));
// Public resolver avoids a stale local negative DNS cache, retaining the real
// hostname for SNI and normal certificate verification on every HTTPS request.
const dns=await(await fetch('https://cloudflare-dns.com/dns-query?name='+origin.hostname+'&type=A',{headers:{accept:'application/dns-json'}})).json();
const address=dns.Answer?.find(a=>a.type===1)?.data;if(!address)throw new Error('Public DNS did not return an IPv4 address');
let session='';
async function request(route,method='GET',body,extra={}){return new Promise((resolve,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=https.request({hostname:origin.hostname,port:origin.port||443,path:route,method,lookup:(_h,o,cb)=>o.all?cb(null,[{address,family:4}]):cb(null,address,4),
    headers:{...(session?{cookie:session}:{}),...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload),origin:origin.origin}:{}),...extra},timeout:25000},res=>{
    if(route==='/api/events'){resolve({status:res.statusCode,headers:res.headers});res.destroy();return;}
    let text='';res.on('data',c=>text+=c);res.on('end',()=>{let value;try{value=JSON.parse(text);}catch{value=text;}resolve({status:res.statusCode,headers:res.headers,value});});
  });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('HTTPS verification timeout')));req.end(payload);
});}
async function check(name,fn){const row={name};receipt.checks.push(row);save();try{row.result=await fn();row.pass=true;}catch(e){row.pass=false;row.error=e.message;process.exitCode=1;}save();console.log(`${row.pass?'PASS':'FAIL'} ${name}${row.error?': '+row.error:''}`);}
await check('public HTTPS health and unauthenticated access boundary',async()=>{const health=await request('/health'),state=await request('/api/state');if(health.status!==200||state.status!==401)throw new Error('Unexpected authentication boundary');return{health:health.status,anonymousState:state.status,edge:health.headers.server};});
await check('remote login issues a protected session and loads live team state',async()=>{
  const password=process.env.NIMBUS_PASSWORD||(process.env.NIMBUS_PASSWORD_DPAPI?await unprotect(fs.readFileSync(path.resolve(process.env.NIMBUS_PASSWORD_DPAPI),'utf8')):'');if(!password)throw new Error('No configured local dashboard password');
  const r=await request('/api/login','POST',{password}),cookies=r.headers['set-cookie']||[];
  if(r.status!==200||!cookies[0]||!['Secure','HttpOnly','SameSite=Lax'].every(flag=>cookies[0].includes(flag)))throw new Error('Protected remote login failed');session=cookies[0].split(';')[0];
  const state=await request('/api/state');if(state.status!==200||!state.value.bots)throw new Error('Authenticated state unavailable');return{status:state.status,workers:state.value.bots.length,secureCookie:true,httpOnly:true};
});
if(session){
  await check('remote stream, cross-origin rejection and local-admin isolation',async()=>{const stream=await request('/api/events'),cross=await request('/api/tasks','POST',{task:'must not run'},{origin:'https://unrelated.example'}),admin=await request('/api/admin/login-ticket','POST',{});if(stream.status!==200||cross.status!==403||admin.status!==403)throw new Error('Remote request boundary differs');return{stream:stream.status,crossOrigin:cross.status,localAdmin:admin.status};});
  await check('iPhone web-app manifest and public offline assets are available',async()=>{
    const manifest=await request('/manifest.webmanifest');if(manifest.status!==200||manifest.value.display!=='standalone')throw new Error('Installable manifest missing');
    const statuses={};for(const p of ['/sw.js','/offline.html','/apple-touch-icon.png','/icon-192.png','/icon-512.png']){const r=await request(p);statuses[p]=r.status;if(r.status!==200)throw new Error('Asset missing '+p);}return statuses;
  });
  await check('remote instructions are accepted once and produce an observed worker result',async()=>{
    const state=(await request('/api/state')).value,worker=state.bots.find(b=>b.template==='office-assistant'),before=(await request('/api/tasks')).value.map(t=>t.id);
    const body={text:'Remote-access verification only: reply exactly NIMBUS_REMOTE_OK. Do not use tools or contact anyone.',requestId:randomUUID()};
    const route='/api/threads/'+encodeURIComponent('bot:'+worker.id)+'/messages',first=await request(route,'POST',body),retry=await request(route,'POST',body);
    if(first.status!==200||retry.value.id!==first.value.id||!retry.value.replayed)throw new Error('Instruction retry created another message');
    const jobs=(await request('/api/tasks')).value.filter(t=>t.bot_id===worker.id&&!before.includes(t.id));if(jobs.length!==1)throw new Error('Instruction retry created duplicate tasks');
    let result;const end=Date.now()+180000;
    while(Date.now()<end){result=(await request('/api/runs/'+jobs[0].id)).value;if(['done','paused','error','needs_review'].includes(result.status))break;await new Promise(r=>setTimeout(r,500));}
    if(result.status!=='done'||!result.reply?.includes('NIMBUS_REMOTE_OK'))throw new Error(result.last_error||'Remote instruction did not complete');
    return{runId:result.id,actualModel:result.actual_model,idempotentRetry:true,reply:result.reply};
  });
}
receipt.finished=true;receipt.passed=receipt.checks.filter(c=>c.pass).length;receipt.total=receipt.checks.length;save();console.log(JSON.stringify({receipt:file,passed:receipt.passed,total:receipt.total}));
