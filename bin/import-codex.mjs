#!/usr/bin/env node
// Imports Codex instructions, memories and user skills so every Nimbus worker,
// Claude or OpenAI, can use them. Dry run by default; --apply writes.
//
//   node bin/import-codex.mjs [--apply] [--codex-home <dir>] [--include-system-skills]
//
// Destinations (inside NIMBUS_DATA, default ./data):
//   shared/codex/AGENTS.md, MEMORY.md, memory_summary.md, raw_memories.md,
//   rollout_summaries/*, notes/*      -> readable with the shared_note tool
//   skills/<name>/                    -> listed by the skills tool
// Text is passed through Nimbus redaction before it is written. An existing file
// with different content is never overwritten; it is reported as a conflict.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {redact} from '../redact.js';

const argv=process.argv.slice(2),has=f=>argv.includes(f),opt=f=>{const i=argv.indexOf(f);return i>=0?argv[i+1]:null;};
const apply=has('--apply'),includeSystem=has('--include-system-skills');
const home=path.resolve(opt('--codex-home')||process.env.CODEX_HOME||path.join(os.homedir(),'.codex'));
const data=path.resolve(process.env.NIMBUS_DATA||'./data');
const shared=path.join(data,'shared','codex'),skillsRoot=path.join(data,'skills');
const TEXT=/\.(md|txt|json|ya?ml|toml|py|js|mjs|ps1|sh)$/i;
const plan=[];

function add(src,dest,kind){plan.push({src,dest,kind});}
function addTree(srcRoot,destRoot,kind){
  if(!fs.existsSync(srcRoot))return;
  const walk=(dir)=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isSymbolicLink())continue;
    if(e.isDirectory())walk(p);else if(e.isFile())add(p,path.join(destRoot,path.relative(srcRoot,p)),kind);
  }};walk(srcRoot);
}
if(!fs.existsSync(home)){console.error(`Codex home not found: ${home}`);process.exit(1);}
const mem=path.join(home,'memories');
if(fs.existsSync(path.join(home,'AGENTS.md')))add(path.join(home,'AGENTS.md'),path.join(shared,'AGENTS.md'),'instructions');
for(const f of ['MEMORY.md','memory_summary.md','raw_memories.md'])if(fs.existsSync(path.join(mem,f)))add(path.join(mem,f),path.join(shared,f),'memory');
addTree(path.join(mem,'rollout_summaries'),path.join(shared,'rollout_summaries'),'memory');
addTree(path.join(mem,'extensions','ad_hoc'),path.join(shared,'notes'),'memory');
const userSkills=path.join(mem,'skills');
if(fs.existsSync(userSkills))for(const e of fs.readdirSync(userSkills,{withFileTypes:true}))if(e.isDirectory())addTree(path.join(userSkills,e.name),path.join(skillsRoot,e.name),'skill');
const skipped=[];
for(const root of [path.join(home,'skills','.system'),path.join(home,'skills')])if(fs.existsSync(root))for(const e of fs.readdirSync(root,{withFileTypes:true})){
  if(!e.isDirectory()||e.name.startsWith('.'))continue;
  const system=root.endsWith('.system');
  if(system&&!includeSystem){skipped.push('skills/.system/'+e.name+' (Codex built-in; pass --include-system-skills to import)');continue;}
  addTree(path.join(root,e.name),path.join(skillsRoot,(system?'codex-':'')+e.name),'skill');
}

const result={imported:0,unchanged:0,conflicts:[],redacted:0};
for(const item of plan){
  const raw=fs.readFileSync(item.src);
  let bytes=raw;
  if(TEXT.test(item.src)){const text=raw.toString('utf8'),clean=redact(text);if(clean!==text)result.redacted++;bytes=Buffer.from(clean,'utf8');}
  if(fs.existsSync(item.dest)){
    if(Buffer.compare(fs.readFileSync(item.dest),bytes)===0){result.unchanged++;continue;}
    result.conflicts.push(path.relative(data,item.dest));continue;
  }
  if(apply){fs.mkdirSync(path.dirname(item.dest),{recursive:true});fs.writeFileSync(item.dest,bytes,{flag:'wx'});}
  result.imported++;
}
const counts=plan.reduce((a,p)=>(a[p.kind]=(a[p.kind]||0)+1,a),{});
console.log(JSON.stringify({mode:apply?'apply':'dry-run',codexHome:home,nimbusData:data,files:counts,
  [apply?'written':'wouldWrite']:result.imported,unchanged:result.unchanged,filesWithRedactions:result.redacted,conflicts:result.conflicts,skipped},null,2));
if(!apply)console.log('Dry run only. Re-run with --apply to write.');
