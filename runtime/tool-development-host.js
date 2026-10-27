import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {capture} from './process.js';

export function developmentHost({root,dataDir}){
  async function probe(mode,name,verification,signal){
    signal?.throwIfAborted();
    if(!/^[a-z][a-z0-9_]{1,63}$/.test(String(name)))throw new Error('Invalid requested native tool name');
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-tool-probe-'));
    const env={};for(const key of ['PATH','Path','SYSTEMROOT','SystemRoot','TEMP','TMP','COMSPEC','APPDATA','LOCALAPPDATA','PROGRAMFILES'])if(process.env[key])env[key]=process.env[key];
    env.NIMBUS_DATA=path.join(directory,'data');env.NIMBUS_CONFIG=path.join(directory,'config.json');
    try{
      const output=await capture(process.execPath,['--no-warnings',path.join(root,'runtime','tool-development-probe.mjs'),mode,name],{cwd:root,env,signal,timeout:45000,input:JSON.stringify(verification||{})});
      return JSON.parse(output.trim());
    }finally{
      const absolute=path.resolve(directory);if(path.dirname(absolute)!==path.resolve(os.tmpdir())||!path.basename(absolute).startsWith('nimbus-tool-probe-'))throw new Error('Unexpected probe cleanup path');
      fs.rmSync(absolute,{recursive:true,force:true});
    }
  }
  async function verifyRequest(request,signal,outputName){
      signal=signal||request?.signal;signal?.throwIfAborted();
      if(!['read','local_write'].includes(request.effects||'read'))throw new Error('The built tool needs explicit execution authorization before an automatic representative probe; effects are '+request.effects);
      if(!/^[a-zA-Z0-9_-]{1,64}$/.test(String(request.id)))throw new Error('Invalid tool request ID');
      const directory=path.join(dataDir,'tool-development',String(request.id)),file=path.join(directory,'testing.json');
      if(fs.statSync(file).size>262144)throw new Error('QA receipt exceeds 256 KiB');
      const bytes=fs.readFileSync(file),receipt=JSON.parse(bytes.toString('utf8')),stage=request.stages?.find(stage=>stage.phase==='testing');
      if(stage?.artifact_hash&&createHash('sha256').update(bytes).digest('hex')!==stage.artifact_hash)throw new Error('QA verification changed after its approved receipt was recorded');
      const result=await probe('verify',request.tool_name,request.verification||receipt.verification,signal);
      const proof={verifiedAt:new Date().toISOString(),sourceHash:receipt.sourceHash,snapshotId:request.snapshot_id,...result},target=path.join(directory,outputName);
      if(fs.existsSync(target))fs.copyFileSync(target,path.join(directory,outputName.replace('.json','-'+randomUUID()+'.json')));
      fs.writeFileSync(target,JSON.stringify(proof,null,2));return result;
  }
  return{
    inspectCandidate:(name,request,signal)=>probe('inspect',name,null,signal||request?.signal),
    verifyCandidateTool:(request,signal)=>verifyRequest(request,signal,'host-candidate-smoke.json'),
    verifyInstalledTool:(request,signal)=>verifyRequest(request,signal,'host-smoke.json')
  };
}
