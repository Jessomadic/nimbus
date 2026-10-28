import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {randomBytes,scryptSync} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
test('real server documents and workspace downloads: authentication, isolation, guards and headers',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-document-http-')),data=path.join(dir,'data'),config=path.join(dir,'config.json');
 fs.writeFileSync(config,JSON.stringify({cloud:{enabled:false},local:{enabled:false,managed:{enabled:false}},browser:{enabled:false},mcpServers:{}}));
 const listener=http.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const env={...process.env};for(const k of Object.keys(env))if(/^NIMBUS_|^(HOST|PORT)$/i.test(k))delete env[k];
 Object.assign(env,{HOST:'127.0.0.1',PORT:String(port),NIMBUS_HTTPS_PORT:'0',NIMBUS_DATA:data,NIMBUS_CONFIG:config,NIMBUS_ALLOWED_EMAILS:'alice@example.invalid,bob@example.invalid',NIMBUS_PASSWORD:'',NIMBUS_ALLOW_NO_PASSWORD:'0',NIMBUS_PUBLIC_ORIGIN:'https://nimbus.fixture.invalid'});
 const child=spawn(process.execPath,['--no-warnings','server.js'],{cwd:fileURLToPath(new URL('../',import.meta.url)),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 let exited=false;const closed=new Promise(r=>child.on('exit',()=>{exited=true;r();}));
 t.after(async()=>{if(!exited)child.kill();await closed;fs.rmSync(dir,{recursive:true,force:true});});
 const headers={host:'nimbus.fixture.invalid',origin:'https://nimbus.fixture.invalid','x-forwarded-proto':'https','cf-connecting-ip':'198.51.100.42','cf-ray':'document-fixture'};
 const request=(route,{method='GET',cookie,body,extra={}}={})=>new Promise((resolve,reject)=>{
 const payload=body===undefined?undefined:JSON.stringify(body);
 const req=http.request({hostname:'127.0.0.1',port,path:route,method,headers:{...headers,...(cookie?{cookie}:{}),...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload)}:{}),...extra}},res=>{
 let text='';res.on('data',b=>text+=b);res.on('end',()=>{let json;try{json=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,json});});});
 req.on('error',reject);req.setTimeout(10000,()=>req.destroy(new Error('timeout')));req.end(payload);});
 let ready=false;for(let n=0;n<150;n++){try{await request('/health');ready=true;break;}catch{}if(exited)break;await new Promise(r=>setTimeout(r,100));}assert.ok(ready,output);
 const db=new DatabaseSync(path.join(data,'nimbus.db'));const password=randomBytes(24).toString('hex');
 for(const email of ['alice@example.invalid','bob@example.invalid']){const salt=randomBytes(16).toString('hex');db.prepare('INSERT INTO users(email,salt,pw_hash) VALUES(?,?,?)').run(email,salt,scryptSync(password,salt,64).toString('hex'));}
 db.prepare('INSERT INTO bots(id,name) VALUES(9001,?)').run('download fixture');db.close();
 const root=path.join(data,'bots','9001');fs.mkdirSync(root,{recursive:true});fs.writeFileSync(path.join(root,'report ü.html'),'fixture bytes');
 fs.writeFileSync(path.join(data,'secret'),'outside');fs.symlinkSync(data,path.join(root,'escape'),'junction');
 const login=async email=>{const r=await request('/api/login',{method:'POST',body:{email,password}});assert.equal(r.status,200,r.text);return r.headers['set-cookie'].find(v=>/^(?:__Host-)?nimbus_session=/.test(v)).split(';')[0];};
 const alice=await login('alice@example.invalid'),bob=await login('bob@example.invalid');
 const download='/api/bots/9001/download?path='+encodeURIComponent('report ü.html');
 for(const route of ['/api/documents/absent',download])assert.equal((await request(route)).status,401);
 assert.equal((await request('/api/documents',{method:'POST',body:{}})).status,401);
 const created=await request('/api/documents',{method:'POST',cookie:alice,body:{title:'CON\r\n/Report',markdown:'original'}});
 assert.equal(created.status,200,created.text);const d=created.json,base='/api/documents/'+d.id;
 for(const route of [base,base+'/versions',base+'/export'])assert.equal((await request(route,{cookie:bob})).status,404);
 assert.equal((await request(base+'/ops',{method:'POST',cookie:bob,body:{ifRev:1,ops:[]}})).status,404);
 const b=d.blocks[0],op={op:'replace',id:b.id,ifHash:b.hash,markdown:'updated'};
 assert.equal((await request(base+'/ops',{method:'POST',cookie:alice,body:{ifRev:1,ops:[op]}})).status,200);
 assert.equal((await request(base+'/ops',{method:'POST',cookie:alice,body:{ifRev:1,ops:[]}})).status,409);
 assert.equal((await request(base+'/ops',{method:'POST',cookie:alice,body:{ifRev:2,ops:[op]}})).status,409);
 assert.equal((await request(base+'/versions',{cookie:alice})).json.length,2);
 const exported=await request(base+'/export',{cookie:alice});assert.equal(exported.status,200);assert.match(exported.text,/updated/);assert.match(exported.headers['content-type'],/^text\/markdown/);assert.equal(decodeURIComponent(exported.headers['content-disposition'].split("''")[1]),'CONReport.md');
 assert.equal((await request(base+'/export?format=pdf',{cookie:alice})).status,503);
 assert.equal((await request(base+'/export?format=exe',{cookie:alice})).status,400);
 for(const title of ['a'.repeat(79)+String.fromCodePoint(0x1f600),'lone'+String.fromCharCode(0xd800)]){
  const made=await request('/api/documents',{method:'POST',cookie:alice,body:{title,markdown:'unicode'}});assert.equal(made.status,200);
  const out=await request('/api/documents/'+made.json.id+'/export',{cookie:alice});assert.equal(out.status,200,out.text);
  const name=decodeURIComponent(out.headers['content-disposition'].split("''")[1]);assert.equal(name,title.toWellFormed()+'.md');
 }
 const got=await request(download,{cookie:alice});assert.equal(got.status,200);assert.equal(got.text,'fixture bytes');assert.equal(got.headers['content-type'],'application/octet-stream');assert.equal(Number(got.headers['content-length']),13);
 for(const r of [got,exported]){assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['x-content-type-options'],'nosniff');assert.match(r.headers['content-disposition'],/^attachment;/);}
 for(const p of ['../secret','escape/secret','missing','.',root,'report ü.html:stream'])assert.equal((await request('/api/bots/9001/download?path='+encodeURIComponent(p),{cookie:alice})).status,404,p);
 assert.equal((await request('/api/bots/999999/download?path=x',{cookie:alice})).status,404);
 assert.equal((await request('/api/documents',{method:'POST',cookie:alice,extra:{origin:'https://evil.invalid'},body:{}})).status,403);
});
