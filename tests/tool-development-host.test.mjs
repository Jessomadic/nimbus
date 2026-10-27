import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {developmentHost} from '../runtime/tool-development-host.js';

const repository=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-development-host-test-')),dataDir=path.join(directory,'state');
  fs.mkdirSync(dataDir,{recursive:true});
  t.after(()=>{const absolute=path.resolve(directory);assert.equal(path.dirname(absolute),path.resolve(os.tmpdir()));assert.match(path.basename(absolute),/^nimbus-development-host-test-/);fs.rmSync(absolute,{recursive:true,force:true});});
  const host=developmentHost({root:repository,dataDir}),request={id:randomUUID(),tool_name:'capabilities',effects:'read'};
  const receiptDirectory=path.join(dataDir,'tool-development',request.id),writeQA=(verification,metadata={})=>{fs.mkdirSync(receiptDirectory,{recursive:true});const file=path.join(receiptDirectory,'testing.json'),bytes=Buffer.from(JSON.stringify({...metadata,verification}));fs.writeFileSync(file,bytes);return{file,bytes,hash:createHash('sha256').update(bytes).digest('hex')};};
  return{directory,dataDir,host,request,receiptDirectory,writeQA};
}
const validVerification=()=>({args:{},assertions:[{path:'fullCodexParity',equals:false}]});

test('fresh subprocess inspection finds the installed native tool and ignores parent state/config paths',async t=>{
  const {directory,host,request}=fixture(t),unexpectedData=path.join(directory,'unexpected-parent-state'),invalidConfig=path.join(directory,'invalid-parent-config.json');
  fs.writeFileSync(invalidConfig,'{not valid JSON');
  const previousData=process.env.NIMBUS_DATA,previousConfig=process.env.NIMBUS_CONFIG;
  process.env.NIMBUS_DATA=unexpectedData;process.env.NIMBUS_CONFIG=invalidConfig;
  try{
    const inspected=await host.inspectCandidate('capabilities',request);
    assert.equal(inspected.found,true);assert.equal(inspected.spec.name,'capabilities');assert.equal(inspected.spec.parameters.type,'object');assert.equal(inspected.spec.parameters.additionalProperties,false);
    assert.equal(fs.existsSync(unexpectedData),false,'Probe must not initialize the parent data directory');
  }finally{
    if(previousData===undefined)delete process.env.NIMBUS_DATA;else process.env.NIMBUS_DATA=previousData;
    if(previousConfig===undefined)delete process.env.NIMBUS_CONFIG;else process.env.NIMBUS_CONFIG=previousConfig;
  }
});

test('metadata inspection returns found:false for an unknown but valid native tool name',async t=>{
  const {host,request}=fixture(t),result=await host.inspectCandidate('uninstalled_native_fixture',request);
  assert.deepEqual(result,{found:false,spec:null});
});

test('representative read-tool assertions execute in a fresh process and save an observed host receipt',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t);writeQA(validVerification());
  const verified=await host.verifyInstalledTool(request);
  assert.equal(verified.pass,true);assert.equal(verified.tool,'capabilities');assert.equal(verified.assertions,1);assert.equal(verified.result.fullCodexParity,false);
  const receipt=JSON.parse(fs.readFileSync(path.join(receiptDirectory,'host-smoke.json'),'utf8'));
  assert.equal(receipt.pass,true);assert.equal(receipt.result.fullCodexParity,false);assert.ok(Number.isFinite(Date.parse(receipt.verifiedAt)));
});

test('a wrong representative assertion rejects and cannot create a passing smoke receipt',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t);writeQA({args:{},assertions:[{path:'fullCodexParity',equals:true}]});
  await assert.rejects(host.verifyInstalledTool(request),/Representative result differs|AssertionError|failed/);
  assert.equal(fs.existsSync(path.join(receiptDirectory,'host-smoke.json')),false);
});

test('missing QA files, missing verification, empty assertions and invalid result paths are rejected',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t);
  await assert.rejects(host.verifyInstalledTool(request),/ENOENT/);
  fs.mkdirSync(receiptDirectory,{recursive:true});fs.writeFileSync(path.join(receiptDirectory,'testing.json'),'{}');
  await assert.rejects(host.verifyInstalledTool(request),/QA must supply|representative assertions|failed/);
  for(const verification of [{args:{},assertions:[]},{args:{},assertions:[{path:'fullCodexParity'}]},{args:{},assertions:[{path:'constructor.prototype',equals:null}]},{args:{},assertions:[{path:'absent.result',equals:false}]}]){
    writeQA(verification);await assert.rejects(host.verifyInstalledTool(request),/QA must supply|Each assertion|Unknown representative result field|failed/);
    assert.equal(fs.existsSync(path.join(receiptDirectory,'host-smoke.json')),false);
  }
});

test('host_execute and external_write requests refuse automatic probing before reading QA or running a tool',async t=>{
  const {host,request,receiptDirectory}=fixture(t);
  for(const effects of ['host_execute','external_write']){
    await assert.rejects(host.verifyInstalledTool({...request,effects}),/explicit execution authorization/);
    await assert.rejects(host.verifyCandidateTool({...request,effects}),/explicit execution authorization/);
  }
  assert.equal(fs.existsSync(receiptDirectory),false,'Refused probes must not create a receipt directory');
});

test('invalid tool names and request IDs are rejected before subprocess execution or receipt access',async t=>{
  const {host,request,writeQA}=fixture(t);writeQA(validVerification());
  for(const name of ['x','BadName','shell;echo injected','../capabilities','name/escape','name\\escape','a'.repeat(65),'']){
    await assert.rejects(host.inspectCandidate(name,request),/Invalid requested native tool name/);
    await assert.rejects(host.verifyInstalledTool({...request,tool_name:name}),/Invalid requested native tool name/);
  }
  for(const id of ['../escape','a/b','a\\b','.','..','a'.repeat(65),'']){
    await assert.rejects(host.verifyInstalledTool({...request,id}),/Invalid tool request ID/);
  }
});

test('a missing installed tool cannot satisfy representative verification',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t);writeQA(validVerification());
  await assert.rejects(host.verifyInstalledTool({...request,tool_name:'uninstalled_native_fixture'}),/not present in the native registry|failed/);
  assert.equal(fs.existsSync(path.join(receiptDirectory,'host-smoke.json')),false);
});

test('oversized QA files are rejected before parsing or starting a representative tool call',async t=>{
  const {host,request,receiptDirectory}=fixture(t);fs.mkdirSync(receiptDirectory,{recursive:true});fs.writeFileSync(path.join(receiptDirectory,'testing.json'),' '.repeat(262145));
  await assert.rejects(host.verifyInstalledTool(request),/QA receipt exceeds 256 KiB/);
  assert.equal(fs.existsSync(path.join(receiptDirectory,'host-smoke.json')),false);
});

test('candidate verification executes the approved assertions and saves its own source/snapshot proof',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t),sourceHash='a'.repeat(64),snapshotId=randomUUID(),qa=writeQA(validVerification(),{sourceHash});
  const candidate={...request,snapshot_id:snapshotId,stages:[{phase:'testing',artifact_hash:qa.hash}]};
  const verified=await host.verifyCandidateTool(candidate);assert.equal(verified.pass,true);assert.equal(verified.result.fullCodexParity,false);
  const proof=JSON.parse(fs.readFileSync(path.join(receiptDirectory,'host-candidate-smoke.json'),'utf8'));
  assert.equal(proof.sourceHash,sourceHash);assert.equal(proof.snapshotId,snapshotId);assert.equal(proof.assertions,1);assert.equal(proof.tool,'capabilities');
  assert.equal(fs.existsSync(path.join(receiptDirectory,'host-smoke.json')),false,'Candidate checks must not claim installed-tool verification');
  assert.ok(fs.readFileSync(qa.file).equals(qa.bytes),'Verification must not modify the approved QA receipt');
});

test('candidate and installed verification reject a changed immutable QA receipt before producing proof',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t),qa=writeQA(validVerification(),{sourceHash:'b'.repeat(64)}),approved={...request,stages:[{phase:'testing',artifact_hash:qa.hash}]};
  fs.appendFileSync(qa.file,'\n');
  for(const verify of [host.verifyCandidateTool,host.verifyInstalledTool])await assert.rejects(verify(approved),/QA verification changed after its approved receipt/);
  assert.equal(fs.existsSync(path.join(receiptDirectory,'host-candidate-smoke.json')),false);assert.equal(fs.existsSync(path.join(receiptDirectory,'host-smoke.json')),false);
});

test('already-aborted inspection and representative calls reject before launching or accessing missing QA files',async t=>{
  const {directory,dataDir,host,request,receiptDirectory}=fixture(t),controller=new AbortController();controller.abort(new Error('Cancelled before probe submission'));
  const missingRepository=developmentHost({root:path.join(directory,'repository-does-not-exist'),dataDir});
  await assert.rejects(missingRepository.inspectCandidate('capabilities',request,controller.signal),/Cancelled before probe submission/);
  await assert.rejects(host.inspectCandidate('capabilities',{...request,signal:controller.signal}),/Cancelled before probe submission/);
  for(const verify of [host.verifyCandidateTool,host.verifyInstalledTool]){
    await assert.rejects(verify(request,controller.signal),/Cancelled before probe submission/);
    await assert.rejects(verify({...request,signal:controller.signal}),/Cancelled before probe submission/);
  }
  assert.equal(fs.existsSync(receiptDirectory),false);
});

test('a failed retry preserves the old smoke and a later successful retry archives its exact bytes',async t=>{
  const {host,request,receiptDirectory,writeQA}=fixture(t);writeQA(validVerification(),{sourceHash:'c'.repeat(64)});
  await host.verifyInstalledTool(request);
  const smokePath=path.join(receiptDirectory,'host-smoke.json'),original=fs.readFileSync(smokePath);
  writeQA({args:{},assertions:[{path:'fullCodexParity',equals:true}]},{sourceHash:'d'.repeat(64)});
  await assert.rejects(host.verifyInstalledTool(request),/Representative result differs|AssertionError|failed/);
  assert.ok(fs.readFileSync(smokePath).equals(original),'A failed attempt must preserve prior observed evidence');
  assert.equal(fs.readdirSync(receiptDirectory).filter(name=>/^host-smoke-[a-f0-9-]+\.json$/.test(name)).length,0);
  writeQA(validVerification(),{sourceHash:'e'.repeat(64)});await host.verifyInstalledTool(request);
  const archives=fs.readdirSync(receiptDirectory).filter(name=>/^host-smoke-[a-f0-9-]+\.json$/.test(name));assert.equal(archives.length,1);assert.ok(fs.readFileSync(path.join(receiptDirectory,archives[0])).equals(original));
  assert.equal(JSON.parse(fs.readFileSync(smokePath,'utf8')).sourceHash,'e'.repeat(64));
});
