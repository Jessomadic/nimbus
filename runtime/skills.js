import fs from 'node:fs';
import {helperReadiness} from './helper-readiness.js';
import path from 'node:path';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function skillIdentity(name){
 if(typeof name!=='string'||/[\u0000-\u001f\u007f]/.test(name))throw new Error('Invalid skill identity');
 const identity=name.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
 if(!identity||identity.length>200)throw new Error('Invalid skill identity');
 return identity;
}
const ignored=new Set(['node_modules','.git','.hub','.locks','__pycache__']);
export function skillTree(root,{maxDepth=12,maxFiles=10000,maxBytes=64*1024*1024,complete=false}={}) {
  for(const [key,value] of Object.entries({maxDepth,maxFiles,maxBytes}))if(!Number.isSafeInteger(value)||value<0)throw new RangeError('Invalid '+key);
  const files=[],warnings=[];let bytes=0;
  try{root=plainPath(root);}catch(error){return {files,warnings:[{path:root,reason:error.message}],bytes};}
  function walk(dir,depth) {
    if(depth>maxDepth)throw new Error('Skill depth limit exceeded');
    if(fs.lstatSync(dir).isSymbolicLink()){warnings.push({path:dir,reason:'symlink excluded'});return;}
    for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      const p=path.join(dir,e.name);
      if(e.isSymbolicLink()){warnings.push({path:p,reason:'symlink excluded'});continue;}
      if(e.isDirectory()){if(complete||!ignored.has(e.name))walk(p,depth+1);continue;}
      if(!e.isFile())continue;
      const s=fs.statSync(p);bytes+=s.size;
      if(files.length>=maxFiles||bytes>maxBytes)throw new Error('Skill inventory limit exceeded');
      files.push({path:p,relative:path.relative(root,p),bytes:s.size,sha256:sha(fs.readFileSync(p))});
    }
  }
  if(fs.existsSync(root))walk(root,0);
  return {files,warnings,bytes};
}
// Restricted frontmatter subset: preserve original metadata verbatim and flag
// unsupported YAML instead of interpreting executable tags/aliases.
export function skillMetadata(source) {
  const match=source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const metadata={},warnings=[];
  if(match){
    const lines=match[1].split(/\r?\n/);
    for(let i=0;i<lines.length;i++){
      const m=lines[i].match(/^([\w-]+):\s*(.*)$/);if(!m)continue;
      let v=m[2];
      if(/^[>|]/.test(v)){
        const header=v.match(/^([>|])(?:([1-9])([-+]?)|([-+])([1-9]?)|())\s*(?:#.*)?$/);
        const a=[];while(i+1<lines.length&&(!lines[i+1].trim()||/^\s+/.test(lines[i+1])))a.push(lines[++i]);
        if(!header){warnings.push('Unsupported YAML block scalar indicator');continue;}
        const indent=Number(header[2]||header[5])||a.find(s=>s.trim())?.match(/^ */)[0].length||1;
        if(a.some(s=>s.trim()&&(s.match(/^ */)[0].length<indent))){warnings.push('Invalid YAML block scalar indentation');continue;}
        const parts=a.map(s=>s.trim()?s.slice(indent):'');
        v='';
        for(let j=0;j<parts.length;j++){
          v+=parts[j];
          // Blank runs fold only between ordinary paragraphs, never before
          // more-indented content whose preceding line break must survive.
          const ordinary=s=>s!==''&&!/^[ \t]/.test(s);
          const nextText=parts.slice(j+1).find(s=>s!=='');
          v+=header[1]==='>'&&j+1<parts.length&&ordinary(parts[j])?(ordinary(parts[j+1])?' ':parts[j+1]===''&&ordinary(nextText||'')?'':'\n'):'\n';
        }
        const chomp=header[3]||header[4];
        if(chomp==='-')v=v.replace(/\n+$/,'');
        else if(chomp!=='+')v=v.replace(/\n+$/,'')+(parts.some(s=>s!=='')?'\n':'');
      }
      else if(/^["']/.test(v))v=v.slice(1,-1);
      if(['name','description','license','compatibility'].includes(m[1]))metadata[m[1]]=v;
    }
    if(/^[ \t]+\S+:|[&*!]/m.test(match[1]))warnings.push('Nested/advanced YAML retained in rawMetadata; dependency verification required');
  }
  return {metadata,warnings};
}
export function discoverSkills(roots,{query='',limit=200,...bounds}={}) {
  if(typeof query!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new RangeError('Invalid skills query/limit');
  const skills=[],warnings=[],seen=new Set();
  for(const root of roots){
    const tree=skillTree(root,bounds);warnings.push(...tree.warnings);
    for(const file of tree.files.filter(f=>path.basename(f.path)==='SKILL.md')){
      const source=fs.readFileSync(file.path,'utf8'),parsed=skillMetadata(source);
      const name=parsed.metadata.name||path.basename(path.dirname(file.path)),identity=skillIdentity(name);
      if(seen.has(identity)){warnings.push({path:file.path,reason:'duplicate identity: '+name});continue;}seen.add(identity);
      const blockers=[];
      if(/darwin|macOS|osascript|AppleScript/i.test(source)&&process.platform!=='darwin')blockers.push('Apple/macOS references require platform review');
      if(/hermes|HERMES_HOME|skill_view|skill_manage/i.test(source))blockers.push('Hermes runtime references require adapter review; do not execute unchanged');
      const resources=tree.files.filter(f=>f.path.startsWith(path.dirname(file.path)+path.sep));
      const references={platforms:[],binaries:[],tools:[]};
      for(const resource of resources.filter(f=>f.bytes<1048576&&/\.(md|txt|py|js|sh|ps1|json|ya?ml)$/i.test(f.path))){
        const text=fs.readFileSync(resource.path,'utf8');
        for(const m of text.matchAll(/(?:^|\n)\s*(os|platforms?|bins|binaries|tools|toolsets)\s*:\s*([^\n]+)/gi)){
          const key=/os|platform/i.test(m[1])?'platforms':/bin/i.test(m[1])?'binaries':'tools';
          references[key].push(...m[2].replace(/[\[\]"']/g,'').split(/[, ]+/).filter(Boolean));
        }
        if(/hermes|HERMES_HOME|skill_view|skill_manage/i.test(text))blockers.push('Hermes dependency blocked: no verified Nimbus adapter; never execute original instructions unchanged');
      }
      for(const key of Object.keys(references))references[key]=[...new Set(references[key])];
      if(parsed.warnings.length)blockers.push('Advanced metadata retained verbatim; manual dependency review required');
      if(Object.values(references).some(a=>a.length))blockers.push('Referenced platform/binary/tool dependencies unverified');
      const scopedReadiness=helperReadiness(name,file.path);
      skills.push({scopedReadiness,broadReadiness:blockers.length?'blocked':'unverified',references,mapping:'No automatic substitution; verify Nimbus catalogue and owner scope',name,path:file.path,description:(parsed.metadata.description||'').slice(0,1500),...parsed,sha256:file.sha256,resources:resources.map(f=>({relative:path.relative(path.dirname(file.path),f.path),sha256:f.sha256,bytes:f.bytes})),blockers:[...new Set(blockers)],readiness:scopedReadiness?.state==='ready_scoped'?'ready_scoped':blockers.length?'blocked':'unverified',guidance:scopedReadiness?.state==='ready_scoped'?'Text-only dependency integrity verified for exact package variant. Read scopedReadiness.variant and selected SKILL.md. Broad blockers retained; task/tool permission, host installation and ordinary-worker proof are separate. No execution authority or installation approval.':'Read SKILL.md and relative resources with read_file; verify tools, dependencies and owner constraints before execution.'});
    }
  }
  const tokens=query.toLowerCase().split(/\W+/).filter(Boolean);
  const selected=skills.map(s=>({...s,score:tokens.reduce((n,t)=>n+(s.name+' '+s.description).toLowerCase().includes(t),0)})).filter(s=>!tokens.length||s.score).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  return {roots,skills:selected.slice(0,limit),total:skills.length,truncated:selected.length>limit,warnings};
}
function plainPath(input){
 if(typeof input!=='string'||!input.trim())throw new Error('Nonempty path required');
 const resolved=path.resolve(input);
 for(let p=resolved;;){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw new Error('Symlink ancestor excluded');const up=path.dirname(p);if(up===p)break;p=up;}
 return resolved;
}
function contains(a,b){const r=path.relative(a,b);return !r||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));}
export function inspectSkillImport(root){
 root=plainPath(root);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'IMPORT-PROVENANCE.json'),'utf8')),issues=[];
 if(!Array.isArray(manifest.files))throw new Error('Invalid provenance');
 const expected=new Map();
 for(const f of manifest.files){
  if(typeof f.relative!=='string'||path.isAbsolute(f.relative)||f.relative.split(/[\\/]/).includes('..')||expected.has(f.relative))throw new Error('Unsafe provenance path');
  expected.set(f.relative,f.sha256);
 }
 const tree=skillTree(root,{complete:true});
 for(const f of tree.files){if(f.relative==='IMPORT-PROVENANCE.json')continue;if(expected.get(f.relative)!==f.sha256)issues.push(f.relative+': modified/untracked');expected.delete(f.relative);}
 issues.push(...[...expected.keys()].map(p=>p+': missing'),...tree.warnings.map(w=>w.reason));
 return {valid:!issues.length,issues,manifest};
}
export function importSkills(source,destination,{previous}={}){
 source=plainPath(source);destination=plainPath(destination);
 if(contains(source,destination)||contains(destination,source))throw new Error('Source/destination overlap');
 if(previous){
  previous=plainPath(previous);
  if(contains(previous,destination)||contains(destination,previous))throw new Error('Previous/destination overlap');
  if(!inspectSkillImport(previous).valid)throw new Error('Previous import modified; preserve and review');
 }
  if(fs.existsSync(destination))throw new Error('Destination exists; inspect provenance and choose a new versioned destination');
  const inventory=skillTree(source),parent=path.dirname(destination);
  if(inventory.warnings.length)throw new Error('Excluded symlinks require review');
  const identities=new Set();
  for(const f of inventory.files.filter(f=>path.basename(f.path)==='SKILL.md')){
   const name=skillIdentity(skillMetadata(fs.readFileSync(f.path,'utf8')).metadata.name||path.basename(path.dirname(f.path)));
   if(!name||identities.has(name))throw new Error('Duplicate/invalid identity: '+name);identities.add(name);
  }
  if(!identities.size)throw new Error('No skill packages');
  if(inventory.files.some(f=>f.relative.toLowerCase()==='import-provenance.json'))throw new Error('Reserved provenance filename');
  const packages=inventory.files.filter(f=>path.basename(f.path)==='SKILL.md').map(f=>path.dirname(f.path)+path.sep);
  inventory.files=inventory.files.filter(f=>packages.some(p=>f.path.startsWith(p)));
  if(inventory.files.some(f=>/(^|[\\/])(?:\.env(?:\..*)?|credentials?\.(?:json|yaml)|.*\.(?:pem|key))$/i.test(f.relative)))throw new Error('Potential credential file requires explicit import review');
  fs.mkdirSync(parent,{recursive:true});
  const stage=fs.mkdtempSync(path.join(parent,'.skill-stage-'));
  try{
    for(const file of inventory.files){
      plainPath(file.path);
      const bytes=fs.readFileSync(file.path);
      if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(bytes.toString('utf8')))throw new Error('Private key content requires review');
      if(sha(bytes)!==file.sha256)throw new Error('Source changed during import');
      const target=path.join(stage,file.relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});
    }
    const manifest={schemaVersion:1,previous:previous?{path:previous,manifestSha256:sha(fs.readFileSync(path.join(previous,'IMPORT-PROVENANCE.json')))}:null,source,createdAt:new Date().toISOString(),files:inventory.files.map(({path:p,...rest})=>rest),warnings:inventory.warnings};
    fs.writeFileSync(path.join(stage,'IMPORT-PROVENANCE.json'),JSON.stringify(manifest,null,2));
    plainPath(parent);if(fs.existsSync(destination))throw new Error('Destination appeared during import');
    fs.renameSync(stage,destination);return manifest;
  }catch(error){fs.rmSync(stage,{recursive:true,force:true});throw error;}
}
