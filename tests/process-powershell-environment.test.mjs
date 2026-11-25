import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {capture,launch} from '../runtime/process.js';

const windows=process.platform==='win32';
const legacy=windows?path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'):null;
const psArgs=command=>['-NoProfile','-NonInteractive','-Command',command];
const quote=value=>"'"+value.replaceAll("'","''")+"'";

test('legacy PowerShell rebuilds native modules after an incompatible inherited module path',{skip:!windows},async t=>{
  const core=(process.env.PSModulePath||'').split(path.delimiter).find(dir=>{
    try{return /CompatiblePSEditions\s*=\s*@\("Core"\)/.test(fs.readFileSync(path.join(dir,'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'),'utf8'));}catch{return false;}
  });
  if(!core){t.skip('PowerShell Core modules are unavailable for the real cross-edition regression');return;}
  const owned=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-module-path-'));
  const fixture=path.join(owned,'input.txt');fs.writeFileSync(fixture,'owned hash input\n');
  const inherited=process.env.PSModulePath;
  const command="$ErrorActionPreference='Stop';[Console]::Write((Get-FileHash -LiteralPath "+quote(fixture)+" -Algorithm SHA256).Hash)";
  try{
    process.env.PSModulePath=core+path.delimiter+path.join(path.dirname(legacy),'Modules');
    const before=process.env.PSModulePath;
    const original=spawnSync(legacy,psArgs(command),{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(original.status,1,'the original inherited environment must reproduce the defect');
    assert.match(original.stderr,/Get-FileHash|CommandNotFound/);
    for(const options of [{},{env:undefined},{env:null}]){
      const output=await capture(legacy,psArgs(command),{timeout:15000,...options});
      assert.equal(output.trim().toLowerCase(),crypto.createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'));
      assert.equal(process.env.PSModulePath,before,'child normalization must not mutate the parent');
    }
  }finally{
    if(inherited===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=inherited;
    fs.rmSync(owned,{recursive:true,force:true});
  }
});

test('legacy PowerShell preserves explicit caller environments',{skip:!windows},async()=>{
  const env={...process.env};
  // Windows environment names are case-insensitive. An inherited PSMODULEPATH
  // must not compete with the deliberately supplied PSModulePath fixture value.
  for(const key of Object.keys(env))if(key.toUpperCase()==='PSMODULEPATH')delete env[key];
  Object.assign(env,{PSModulePath:'Z:\\nimbus-explicit-test-modules',NIMBUS_ENV_FIXTURE:'explicit-owned-marker'});
  const before={...env};
  const output=await capture('powershell.exe',psArgs("[Console]::Write($env:PSModulePath+'|'+$env:NIMBUS_ENV_FIXTURE)"),{env});
  assert.equal(output,env.PSModulePath+'|'+env.NIMBUS_ENV_FIXTURE);
  assert.deepEqual(env,before);
});

test('other executables retain the inherited module path',async()=>{
  const output=await capture(process.execPath,['-e','process.stdout.write(JSON.stringify(process.env.PSModulePath??null))']);
  assert.equal(JSON.parse(output),process.env.PSModulePath??null);
});

test('legacy child exit and diagnostics remain accurate',{skip:!windows},async()=>{
  await assert.rejects(capture(legacy,psArgs("[Console]::WriteLine('owned-output');[Console]::Error.WriteLine('owned-error');exit 37")),error=>{
    assert.equal(error.evidence.exitCode,37);assert.equal(error.uncertain,false);
    assert.match(error.stdout,/owned-output/);assert.match(error.stderr,/owned-error/);return true;
  });
});

test('legacy launch preserves streamed input and working directory',{skip:!windows},async()=>{
  const child=launch(legacy,psArgs("$x=[Console]::ReadLine();[Console]::Write($x+'|'+[Environment]::CurrentDirectory)"),{cwd:process.cwd(),stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  child.stdin.end('owned-input\n');
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  assert.equal(code,0);assert.equal(err,'');assert.equal(out,'owned-input|'+process.cwd());
});
