import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function inspectImage(file) {
  const bytes=fs.readFileSync(file);
  if(bytes.length>10*1024*1024)throw new Error('Image exceeds the 10 MiB vision limit');
  const mimeType=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png'
    :bytes[0]===255&&bytes[1]===216?'image/jpeg'
    :/^GIF8[79]a/.test(bytes.subarray(0,6).toString())?'image/gif'
    :bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'image/webp':null;
  if(!mimeType)throw new Error('Unsupported image; use PNG, JPEG, GIF or WebP');
  return {image:{path:path.resolve(file),mimeType,sha256:hash(bytes)},bytes:bytes.length};
}
export function imageData(result) {
  if(!result?.image)return null;
  const current=inspectImage(result.image.path);
  if(current.image.sha256!==result.image.sha256)throw new Error('Image changed after its retained tool receipt; inspect it again');
  return `data:${current.image.mimeType};base64,${fs.readFileSync(current.image.path).toString('base64')}`;
}
export function retainedImages(messages) {
  const found=new Map();
  for(const message of messages)if(message.role==='tool'){
    try{const result=JSON.parse(message.content);if(result?.image)found.set(result.image.path,result);}catch{}
  }
  return [...found.values()].slice(-3);
}

// Structured, exact-context patches keep model edits bounded and reject stale
// source. Validate every edit before changing a single file.
export function applyEdits(edits,cwd) {
  if(!Array.isArray(edits)||!edits.length||edits.length>50)throw new Error('Provide 1 to 50 edits');
  const seen=new Set(),changes=edits.map(edit=>{
    if(typeof edit.path!=='string'||!edit.path.trim())throw new Error('Each edit needs a path');
    const file=path.resolve(cwd,edit.path),key=process.platform==='win32'?file.toLowerCase():file;
    if(seen.has(key))throw new Error('Combine edits to the same file into a single operation');seen.add(key);
    if(fs.existsSync(file)&&!fs.lstatSync(file).isFile())throw new Error('Patch target must be a regular file');
    const before=fs.existsSync(file)?fs.readFileSync(file):null;
    let after;
    if(edit.operation==='add'){
      if(before!==null)throw new Error(`File already exists: ${file}`);
      if(typeof edit.newText!=='string')throw new Error('add requires newText');after=Buffer.from(edit.newText);
    }else if(edit.operation==='update'){
      if(before===null||typeof edit.oldText!=='string'||!edit.oldText.length||typeof edit.newText!=='string')throw new Error('update needs an existing file, nonempty oldText and newText');
      const original=before.toString('utf8'),at=original.indexOf(edit.oldText);
      if(at<0||original.indexOf(edit.oldText,at+1)>=0)throw new Error(`oldText must match exactly once: ${file}`);
      after=Buffer.from(original.slice(0,at)+edit.newText+original.slice(at+edit.oldText.length));
    }else if(edit.operation==='delete'){
      if(before===null||typeof edit.oldText!=='string'||before.toString('utf8')!==edit.oldText)throw new Error('delete requires oldText matching the complete current file');after=null;
    }else throw new Error('Choose add, update or delete');
    return {file,before,after};
  });
  const written=[];
  try{
    for(const item of changes){
      const current=fs.existsSync(item.file)?fs.readFileSync(item.file):null;
      if(current===null?item.before!==null:item.before===null||!current.equals(item.before))throw new Error('Source changed while preparing patch');
      fs.mkdirSync(path.dirname(item.file),{recursive:true});
      if(item.after===null)fs.unlinkSync(item.file);else fs.writeFileSync(item.file,item.after);
      written.push(item);
    }
  }catch(error){
    for(const item of written.reverse()){
      if(item.before===null)fs.unlinkSync(item.file);else fs.writeFileSync(item.file,item.before);
    }
    throw error;
  }
  return {files:changes.map(item=>({path:item.file,operation:item.before===null?'added':item.after===null?'deleted':'updated',sha256:item.after===null?null:hash(item.after)}))};
}

export function listSkills(roots) {
  const skills=[];
  for(const root of roots){
    if(!fs.existsSync(root))continue;
    for(const entry of fs.readdirSync(root,{withFileTypes:true})){
      if(!entry.isDirectory()||entry.isSymbolicLink())continue;
      const file=path.join(root,entry.name,'SKILL.md');if(!fs.existsSync(file)||!fs.lstatSync(file).isFile())continue;
      const source=fs.readFileSync(file,'utf8');
      skills.push({name:entry.name,path:file,description:(source.match(/^description:\s*["']?(.*?)["']?\r?$/m)?.[1]||source.split(/\r?\n/).find(line=>line&&!line.startsWith('#')&&line!=='---')||'').slice(0,1000)});
    }
  }
  return {roots,skills};
}
