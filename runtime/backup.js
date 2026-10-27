import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import yauzl from 'yauzl';
import { DatabaseSync } from 'node:sqlite';
import { protect, unprotect, localToken } from './credentials.js';
import { config, CONFIG_FILE } from './config.js';

const MAGIC=Buffer.from('NIMBUS02');
export async function recoveryKey(dataDir) {
  const file=path.join(dataDir,'recovery-key.dpapi');
  if(fs.existsSync(file))return Buffer.from(await unprotect(fs.readFileSync(file,'utf8')),'base64');
  const key=randomBytes(32);fs.mkdirSync(dataDir,{recursive:true});fs.writeFileSync(file,await protect(key.toString('base64')),{mode:0o600});return key;
}
function disposeStage(stage) {
  const resolved=path.resolve(stage),parent=path.resolve(os.tmpdir());
  if(path.dirname(resolved)!==parent||!path.basename(resolved).startsWith('nimbus-backup-'))throw new Error('Unexpected backup staging path');
  fs.rmSync(resolved,{recursive:true,force:true});
}
function walk(root,visit,relative='') {
  for(const item of fs.readdirSync(path.join(root,relative),{withFileTypes:true})) {
    const rel=path.join(relative,item.name),abs=path.join(root,rel);
    if(item.isSymbolicLink())continue;
    if(item.isDirectory()) {if(item.name!=='backups')walk(root,visit,rel);}
    else if(item.isFile())visit(abs,rel);
  }
}
export async function createBackup({dataDir,outputDir=path.join(dataDir,'backups'),key,extraCopy='',includeCredentials=true}) {
  fs.mkdirSync(outputDir,{recursive:true});
  key=key||await recoveryKey(dataDir);
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-backup-'));
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const file=path.join(outputDir,`nimbus-${stamp}.nbak`),part=file+'.part';
  try {
    const source=new DatabaseSync(path.join(dataDir,'nimbus.db'));
    source.exec('PRAGMA busy_timeout=5000');
    source.exec(`VACUUM INTO '${path.join(stage,'nimbus.db').replaceAll("'","''")}'`);source.close();
    const archive=new ZipArchive({zlib:{level:6}});
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
    fs.writeFileSync(part,Buffer.concat([MAGIC,iv]),{mode:0o600});
    const stream=fs.createWriteStream(part,{flags:'a'});
    const written=pipeline(archive,cipher,stream);
    // Observe pipeline errors before asynchronous credential packaging completes.
    written.catch(()=>{});
    walk(dataDir,(abs,rel)=>{
      if(/^(nimbus\.db(?:-wal|-shm)?|admin\.token|auth-key\.dpapi|recovery-key\.dpapi)$/.test(rel)||rel.endsWith('state.dpapi')||rel.startsWith('credentials'+path.sep))return;
      archive.file(abs,{name:'data/'+rel.split(path.sep).join('/')});
    });
    archive.file(path.join(stage,'nimbus.db'),{name:'data/nimbus.db'});
    if(fs.existsSync(CONFIG_FILE))archive.file(CONFIG_FILE,{name:'nimbus.config.json'});
    const portable={connectors:{},browser:{},localToken:null};
    if(includeCredentials) {
      const snapshot=new DatabaseSync(path.join(stage,'nimbus.db'),{readOnly:true});
      for(const row of snapshot.prepare('SELECT id,secrets FROM plugins').all())portable.connectors[row.id]=await unprotect(row.secrets);
      snapshot.close();
      const browserRoot=path.join(dataDir,'browser');
      if(fs.existsSync(browserRoot))walk(browserRoot,(abs,rel)=>{if(path.basename(rel)==='state.dpapi')portable.browser[rel]=fs.readFileSync(abs,'utf8');});
      for(const rel of Object.keys(portable.browser))portable.browser[rel]=await unprotect(portable.browser[rel]);
      try{portable.localToken=await localToken(config().local);}catch{}
    }
    archive.append(JSON.stringify(portable),{name:'portable-credentials.json'});
    archive.append(JSON.stringify({format:2,createdAt:new Date().toISOString(),nativeCodexAuthIncluded:false}),{name:'manifest.json'});
    await archive.finalize();await written;
    fs.appendFileSync(part,cipher.getAuthTag());fs.renameSync(part,file);
    let copied=null;
    if(extraCopy){const target=path.resolve(extraCopy);fs.mkdirSync(target,{recursive:true});copied=path.join(target,path.basename(file));await fsp.copyFile(file,copied);}
    const all=fs.readdirSync(outputDir).filter(n=>/^nimbus-.*\.nbak$/.test(n)).sort().reverse();
    for(const old of all.slice(14))fs.rmSync(path.join(outputDir,old));
    return{ok:true,file,size:fs.statSync(file).size,remote:copied,at:Date.now()};
  } finally {if(fs.existsSync(part))fs.rmSync(part);disposeStage(stage);}
}
async function extract(zipFile,destination) {
  const zip=await new Promise((resolve,reject)=>yauzl.open(zipFile,{lazyEntries:true},(e,z)=>e?reject(e):resolve(z)));
  return new Promise((resolve,reject)=>{
    let count=0,total=0,portable='{}';
    zip.on('error',reject);zip.on('end',()=>resolve({portable}));
    zip.on('entry',entry=>{
      const file=path.resolve(destination,entry.fileName);
      if(!file.startsWith(path.resolve(destination)+path.sep)||entry.fileName.includes('\\')||++count>100000||(total+=entry.uncompressedSize)>20*1024**3){zip.close();reject(new Error('Invalid or oversized backup entry'));return;}
      const unixType=(entry.externalFileAttributes>>>16)&0xf000;
      if(unixType===0xa000){zip.close();reject(new Error('Backup symlinks are not supported'));return;}
      if(entry.fileName==='portable-credentials.json'){
        if(entry.uncompressedSize>64*1024*1024){zip.close();reject(new Error('Credential payload is too large'));return;}
        zip.openReadStream(entry,async(error,stream)=>{
          if(error){reject(error);return;}
          try{const chunks=[];for await(const chunk of stream)chunks.push(chunk);portable=Buffer.concat(chunks).toString('utf8');zip.readEntry();}catch(e){reject(e);}
        });return;
      }
      if(entry.fileName.endsWith('/')){fs.mkdirSync(file,{recursive:true});zip.readEntry();return;}
      fs.mkdirSync(path.dirname(file),{recursive:true});
      zip.openReadStream(entry,(error,stream)=>{
        if(error){reject(error);return;}
        pipeline(stream,fs.createWriteStream(file,{flags:'wx',mode:0o600})).then(()=>zip.readEntry(),reject);
      });
    });zip.readEntry();
  });
}
export async function restoreBackup({file,destination,key,protectCredential=protect}) {
  if(fs.existsSync(destination)&&fs.readdirSync(destination).length)throw new Error('Restore destination must be empty');
  const stage=fs.mkdtempSync(path.join(os.tmpdir(),'nimbus-backup-'));
  try {
    const stat=fs.statSync(file);if(stat.size<36)throw new Error('Backup is incomplete');
    const fd=fs.openSync(file,'r'),header=Buffer.alloc(20),tag=Buffer.alloc(16);
    fs.readSync(fd,header,0,20,0);fs.readSync(fd,tag,0,16,stat.size-16);fs.closeSync(fd);
    if(!header.subarray(0,8).equals(MAGIC))throw new Error('Unsupported backup format');
    const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAuthTag(tag);
    const zipFile=path.join(stage,'verified.zip');
    // Authenticate the complete archive before extracting any user data.
    await pipeline(fs.createReadStream(file,{start:20,end:stat.size-17}),decipher,fs.createWriteStream(zipFile,{mode:0o600}));
    const extracted=path.join(stage,'contents');fs.mkdirSync(extracted);const entries=await extract(zipFile,extracted);
    const manifest=JSON.parse(fs.readFileSync(path.join(extracted,'manifest.json'),'utf8'));
    if(manifest.format!==2)throw new Error('Unsupported backup manifest');
    const portable=JSON.parse(entries.portable);
    const data=path.join(extracted,'data');
    const restoredDb=new DatabaseSync(path.join(data,'nimbus.db'));
    for(const [id,plain] of Object.entries(portable.connectors||{}))restoredDb.prepare('UPDATE plugins SET secrets=? WHERE id=?').run(await protectCredential(plain),id);
    if(restoredDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='auth_sessions'").get())restoredDb.exec('DELETE FROM auth_sessions');
    restoredDb.close();
    for(const [relative,plain] of Object.entries(portable.browser||{})){
      const output=path.resolve(data,'browser',relative),browserRoot=path.resolve(data,'browser');
      if(!output.startsWith(browserRoot+path.sep))throw new Error('Invalid browser state path');
      fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,await protectCredential(plain),{mode:0o600});
    }
    let restoredConfig=fs.existsSync(path.join(extracted,'nimbus.config.json'))?JSON.parse(fs.readFileSync(path.join(extracted,'nimbus.config.json'),'utf8')):null;
    if(portable.localToken&&restoredConfig){
      const credentials=path.join(data,'credentials');fs.mkdirSync(credentials,{recursive:true});
      const encrypted=await protectCredential(portable.localToken);
      fs.writeFileSync(path.join(credentials,'local.token'),Buffer.from(encrypted.replace(/^dpapi:/,''),'base64'),{mode:0o600});
      restoredConfig.local.tokenDpapiFile=path.join(path.resolve(destination),'data','credentials','local.token');
    }
    fs.mkdirSync(destination,{recursive:true});fs.cpSync(data,path.join(destination,'data'),{recursive:true,errorOnExist:true});
    if(restoredConfig)fs.writeFileSync(path.join(destination,'nimbus.config.json'),JSON.stringify(restoredConfig,null,2)+'\n');
    return{ok:true,destination,nativeCodexSignInRequired:true};
  } finally {disposeStage(stage);}
}
