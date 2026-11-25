import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {capture} from '../runtime/process.js';

test('startup installer preserves hidden execution and recovery behavior',{skip:process.platform!=='win32'},async t=>{
  const legacy=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const core=(process.env.PSModulePath||'').split(path.delimiter).find(dir=>{
    try{return /CompatiblePSEditions\s*=\s*@\("Core"\)/.test(fs.readFileSync(path.join(dir,'Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1'),'utf8'));}catch{return false;}
  });
  const pwsh=core&&path.join(path.dirname(core),'pwsh.exe');
  const script=fileURLToPath(new URL('./windowless-installer.ps1',import.meta.url));
  for(const [name,exe] of [['Windows PowerShell',legacy],['PowerShell Core',pwsh]]){
    await t.test(name,{skip:!exe||!fs.existsSync(exe)},async()=>{
      const output=fs.mkdtempSync(path.join(os.tmpdir(),'w-'));
      const env={...process.env};
      if(core)env.NIMBUS_TEST_CORE_MODULES=core;
      // Reproduce the invoking host's environment. The installer must work in
      // both editions; its launcher normalizes only the legacy child.
      if(exe===legacy)delete env.PSModulePath;
      await capture(exe,['-NoProfile','-NonInteractive','-File',script,'-OutputRoot',output],{env,timeout:60000});
      const report=JSON.parse(fs.readFileSync(path.join(output,'tests.json'),'utf8').replace(/^\uFEFF/,''));
      assert.equal(report.error,null,JSON.stringify(report));
      assert.equal(report.failed,0);assert.equal(report.passed,14);
      // Preserve the owned compile/launch evidence for failed future regressions.
      t.diagnostic(name+' evidence: '+output);
    });
  }
});
