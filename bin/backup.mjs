#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createBackup, restoreBackup, recoveryKey } from '../runtime/backup.js';
const ROOT=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA=path.resolve(process.env.NIMBUS_DATA||path.join(ROOT,'data'));
try {
  let result;
  if(process.argv[2]==='--export-key'){
    const target=process.argv[3];if(!target)throw new Error('Provide a new recovery-key output file');
    fs.writeFileSync(path.resolve(target),(await recoveryKey(DATA)).toString('base64')+'\n',{flag:'wx',mode:0o600});result={ok:true,file:path.resolve(target)};
  }else if(process.argv[2]==='--restore'){
    const [file,destination,keyFile]=process.argv.slice(3);if(!file||!destination||!keyFile)throw new Error('Usage: backup.mjs --restore <backup.nbak> <empty destination> <recovery-key file>');
    result=await restoreBackup({file:path.resolve(file),destination:path.resolve(destination),key:Buffer.from(fs.readFileSync(keyFile,'utf8').trim(),'base64')});
  }else{
    const db=new DatabaseSync(path.join(DATA,'nimbus.db'),{readOnly:true});
    const target=db.prepare("SELECT value FROM settings WHERE key='backup_target'").get()?.value||'';db.close();
    result=await createBackup({dataDir:DATA,extraCopy:target});
  }
  console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({ok:false,error:e.message,at:Date.now()}));process.exitCode=1;}
