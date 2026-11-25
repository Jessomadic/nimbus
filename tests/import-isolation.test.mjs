import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

test('connector and operations imports do not open a task database before fixture setup',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-import-isolation-'));
  try{
    const mcp=new URL('../runtime/mcp.js',import.meta.url).href,operations=new URL('../runtime/toolsets/operations.js',import.meta.url).href;
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(mcp)});await import(${JSON.stringify(operations)});`],{env:{...process.env,NIMBUS_DATA:path.join(directory,'unexpected-database')},encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(result.status,0,result.stderr);assert.equal(fs.existsSync(path.join(directory,'unexpected-database')),false,'Read-only module import created database state');
  }finally{assert.equal(path.dirname(directory),os.tmpdir());fs.rmSync(directory,{recursive:true,force:true});}
});
