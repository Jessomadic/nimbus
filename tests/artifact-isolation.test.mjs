import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {artifactDirectory} from './helpers/artifact-directory.mjs';
const helper=new URL('./helpers/artifact-directory.mjs',import.meta.url).href;
test('production cwd and NIMBUS_DATA do not redirect default artifacts',()=>{
 const prior=process.env.NIMBUS_DATA;process.env.NIMBUS_DATA=process.cwd();
 try {const d=artifactDirectory('default',{exportRoot:''});assert.equal(path.dirname(d),fs.realpathSync(os.tmpdir()));}
 finally {if(prior===undefined)delete process.env.NIMBUS_DATA;else process.env.NIMBUS_DATA=prior;}
});
test('explicit export retains prior evidence, confines suites and separates concurrent processes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-export-'));
 const first=artifactDirectory('same',{exportRoot:root});fs.writeFileSync(path.join(first,'sentinel'),'original');
 const jobs=Array.from({length:4},()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`import {artifactDirectory} from ${JSON.stringify(helper)};artifactDirectory('same');`],{cwd:process.cwd(),env:{...process.env,NIMBUS_TEST_ARTIFACTS:root}});
  let output='';child.stdout.on('data',b=>output+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve(output.trim().split(': ').at(-1)):reject(new Error('child '+code)));
 }));
 const dirs=await Promise.all(jobs);assert.equal(new Set([first,...dirs]).size,5);
 for(const d of dirs)assert.equal(path.dirname(fs.realpathSync(d)),fs.realpathSync(root));
 assert.equal(fs.readFileSync(path.join(first,'sentinel'),'utf8'),'original');
 assert.throws(()=>artifactDirectory('../escape',{exportRoot:root}),/Invalid/);
});
test('all affected screenshot suites use unique allocation with no historical fallback',()=>{
 for(const name of ['panel-gestures','sidebar-drag','repair-diagnostic','run-context-http','chat-presentation','ios-pwa']){
 const text=fs.readFileSync(new URL('./'+name+'.test.mjs',import.meta.url),'utf8');
 assert.match(text,/artifactDirectory\('/);assert.doesNotMatch(text,/F:\/Nimbus|data\/verification\/context|sidebar-verification|gesture-regressions/);
 assert.match(text,/page.screenshot|mobile.screenshot/);
 }
});

test('boot log sink is retained outside disposable fixture and never resolves historical URL',()=>{
 const source=fs.readFileSync(new URL('./handoff-boot-http.test.mjs',import.meta.url),'utf8');
 assert.match(source,/artifactDirectory\('handoff-boot-http'\)/);
 assert.ok(source.includes("fs.writeFileSync(path.join(artifacts,'boot-host-output.log'),output)"));
 assert.ok(!source.includes("new URL('../../boot-host-output.log'"));
 assert.equal(path.basename(new URL('../../boot-host-output.log',import.meta.url).pathname),'boot-host-output.log');
});
test('actual opt-in allocation expressions separate repeated and concurrent mixed-suite sinks',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-sinks-'));
 const sentinel=path.join(root,'keyboard-390x400.png');fs.writeFileSync(sentinel,'historical');
 const run=(suite,variable,file)=>new Promise((resolve,reject)=>{
  const source=fs.readFileSync(new URL('./'+suite+'.test.mjs',import.meta.url),'utf8');
  const allocation=source.split('\n').find(l=>l.includes('const artifacts')&&l.includes('artifactDirectory'));
  assert.ok(allocation);
  const script=`import fs from 'node:fs';import path from 'node:path';import {artifactDirectory} from ${JSON.stringify(helper)};${allocation};fs.writeFileSync(path.join(artifacts,${JSON.stringify(file)}),'new');console.log(JSON.stringify(artifacts));`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:{...process.env,[variable]:path.relative(process.cwd(),root)}});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(out.trim().split('\n').at(-1))):reject(Error(err)));
 });
 const jobs=[['chat-presentation','NIMBUS_CHAT_ARTIFACTS','activity-chromium-320.png'],['ios-pwa','NIMBUS_PWA_ARTIFACTS','keyboard-390x400.png']];
 const dirs=[];for(const j of jobs)dirs.push(await run(...j));
 dirs.push(...await Promise.all([...jobs,...jobs].map(j=>run(...j))));
 assert.equal(new Set(dirs).size,6);
 for(const d of dirs)assert.equal(path.dirname(fs.realpathSync(d)),fs.realpathSync(root));
 assert.equal(fs.readFileSync(sentinel,'utf8'),'historical');
 for(const bad of ['../x','/absolute','C:ads','\\\\server','x'.repeat(81)])assert.throws(()=>artifactDirectory(bad,{exportRoot:root}));
 const file=path.join(root,'not-directory');fs.writeFileSync(file,'original');
 assert.throws(()=>artifactDirectory('failure',{exportRoot:file}));
 assert.equal(fs.readFileSync(file,'utf8'),'original');
});
