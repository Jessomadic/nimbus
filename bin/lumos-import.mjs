#!/usr/bin/env node
// Copies Lumos's state out of the Hermes home into a new Nimbus-owned generation:
//   data/lumos/home/gen-<UTC>/   (+ data/lumos/home/current.json pointer)
// Run it while the Hermes gateway is stopped (Switch-LumosBackend.ps1 does this)
// so the databases are consistent. The Hermes originals are only read; their
// hashes are recorded before and verified again after the copy.
//
//   node bin/lumos-import.mjs [--hermes-home <dir>] [--agents <AGENTS.md>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync,backup} from 'node:sqlite';
import {DATA_DIR} from '../runtime/data-dir.js';

const argv=process.argv.slice(2),opt=f=>{const i=argv.indexOf(f);return i>=0?argv[i+1]:null;};
const hermes=path.resolve(opt('--hermes-home')||'F:/Projects/Lumos/HermesPilot/home');
const agentsFile=path.resolve(opt('--agents')||path.join(path.dirname(hermes),'AGENTS.md'));
const dry=argv.includes('--dry-run');
const root=path.join(DATA_DIR,'lumos','home');
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
const gen=path.join(root,'gen-'+stamp);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const FILES=['SOUL.md','memories/MEMORY.md','memories/USER.md','topic-sessions.json','service-manual-policy.json','cron/jobs.json'];
const DBS=['memory_store.db','state.db','data/tracker_outcomes.sqlite3'];
const TREES=['skills','scripts','data/weather_runs'];
const EXTRA=['data/tracker_feedback.json'];

function walk(dir){const out=[];if(!fs.existsSync(dir))return out;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){if(['__pycache__','.hub'].includes(e.name))continue;out.push(...walk(p));}else if(e.isFile())out.push(p);}return out;}
const plan=[];
for(const rel of [...FILES,...EXTRA])if(fs.existsSync(path.join(hermes,rel)))plan.push({rel,kind:'file'});
for(const rel of DBS)if(fs.existsSync(path.join(hermes,rel)))plan.push({rel,kind:'sqlite'});
for(const tree of TREES)for(const file of walk(path.join(hermes,tree)))plan.push({rel:path.relative(hermes,file).replaceAll('\\','/'),kind:'file'});

// The Lumos persona for Nimbus: SOUL.md without the Hermes identity line, plus
// the owner rules from AGENTS.md that still apply. Hermes-only routing, source
// and gateway notes are left out.
export function renderPersona(soul,agents){
  const body=soul.replace(/^You are Hermes Agent, built by Nous Research\.\s*/,'');
  const keep=[];
  for(const para of String(agents||'').split(/\n\s*\n/)){
    if(/^(Service-manual workload exception|Owner execution policy|Keep OpenBubbles\/Apple activation unchanged|Task conversation routing)/.test(para.trim()))keep.push(para.trim().replace(/\n/g,' '));
  }
  return `You are Lumos, Jesse's personal assistant over iMessage, running on Nimbus. Nimbus supplies your tools, memory and model routing; you are the same Lumos across every model.

${body.trim()}

## Nimbus notes
- Your final answer is sent to Jesse as iMessage bubbles automatically (one bubble per paragraph). Use openbubbles_operation only for files (kind "attachments" with files:[{path}]), reactions, typing, edits, unsends or effects.
- Do not ask questions through other channels; ask in your reply.
- Long work can be handed to Nimbus workers with ask_worker; keep Jesse informed in your reply.
- Your long-term memory tools are memory, fact_store and fact_feedback (the lumos-memory connector). Save durable facts and preferences there.
- Your Hermes skills are listed by the skills tool; skills-review.json in your Lumos home classifies each one. "ready": follow it. "adapt" or "review": follow its guidance with Nimbus tools after checking that the tools or commands it names exist here, translating Hermes tool names (terminal→shell, skill_view→read_file, web_extract→browser, vision→view_image); never run its scripts unchanged when they assume Hermes paths or tools. "unavailable": needs a Mac; do not use it.

## Owner rules kept from the Hermes integration contract
${keep.map(p=>'- '+p).join('\n')}
`;
}

if(dry){console.log(JSON.stringify({hermes,destination:gen,items:plan.length,sqlite:plan.filter(p=>p.kind==='sqlite').map(p=>p.rel)},null,2));process.exit(0);}
if(!fs.existsSync(path.join(hermes,'SOUL.md')))throw new Error('Not a Hermes home: '+hermes);
const before=Object.fromEntries(plan.map(p=>[p.rel,sha(path.join(hermes,p.rel))]));
fs.mkdirSync(gen,{recursive:true});
const manifest={createdAt:new Date().toISOString(),source:hermes,generation:path.basename(gen),files:[]};
for(const item of plan){
  const src=path.join(hermes,item.rel),dest=path.join(gen,item.rel);
  fs.mkdirSync(path.dirname(dest),{recursive:true});
  if(item.kind==='sqlite'){
    // A SQLite online backup is consistent even with WAL files present.
    const source=new DatabaseSync(src,{readOnly:true});
    try{await backup(source,dest);}finally{source.close();}
  }else fs.copyFileSync(src,dest,fs.constants.COPYFILE_EXCL);
  manifest.files.push({path:item.rel,kind:item.kind,sourceSha256:before[item.rel],copySha256:sha(dest)});
}
const after=Object.entries(before).filter(([rel,h])=>sha(path.join(hermes,rel))!==h).map(([rel])=>rel);
manifest.sourceUnchanged=after.length===0;manifest.changedDuringCopy=after;
fs.mkdirSync(path.join(gen,'persona'),{recursive:true});
fs.writeFileSync(path.join(gen,'persona','LUMOS.md'),renderPersona(fs.readFileSync(path.join(hermes,'SOUL.md'),'utf8'),fs.existsSync(agentsFile)?fs.readFileSync(agentsFile,'utf8'):''));
// Original memory text, kept for the divergence report after a rollback.
fs.mkdirSync(path.join(gen,'baseline'),{recursive:true});
for(const f of ['MEMORY.md','USER.md'])if(fs.existsSync(path.join(gen,'memories',f)))fs.copyFileSync(path.join(gen,'memories',f),path.join(gen,'baseline',f));
// Deterministic (no_agent) cron jobs become Nimbus Lumos schedules, disabled until the switch.
let jobs=[];try{const raw=JSON.parse(fs.readFileSync(path.join(gen,'cron','jobs.json'),'utf8'));jobs=(Array.isArray(raw)?raw:raw.jobs||Object.values(raw)).filter(j=>j.no_agent&&j.script&&j.schedule?.kind==='cron').map(j=>({id:'hermes-'+j.id,name:j.name,cron:j.schedule.expr,script:path.basename(j.script),enabled:false,source:'hermes:'+j.id}));}catch{}
fs.writeFileSync(path.join(gen,'schedules.json'),JSON.stringify(jobs,null,2));
manifest.schedules=jobs.map(j=>j.id);
fs.writeFileSync(path.join(gen,'manifest.json'),JSON.stringify(manifest,null,2));
fs.writeFileSync(path.join(root,'current.json.part'),JSON.stringify({generation:path.basename(gen),path:gen,at:manifest.createdAt},null,2));
fs.renameSync(path.join(root,'current.json.part'),path.join(root,'current.json'));
console.log(JSON.stringify({generation:gen,files:manifest.files.length,sourceUnchanged:manifest.sourceUnchanged,changedDuringCopy:after,schedules:manifest.schedules},null,2));
if(!manifest.sourceUnchanged)process.exitCode=2;
