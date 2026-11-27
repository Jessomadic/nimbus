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
import {fileURLToPath} from 'node:url';

const argv=process.argv.slice(2),opt=f=>{const i=argv.indexOf(f);return i>=0?argv[i+1]:null;};
const hermes=path.resolve(opt('--hermes-home')||'F:/Projects/Lumos/HermesPilot/home');
const agentsFile=path.resolve(opt('--agents')||path.join(path.dirname(hermes),'AGENTS.md'));
const dry=argv.includes('--dry-run');
const root=path.join(DATA_DIR,'lumos','home');
const stamp=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d+Z$/,'Z');
const gen=path.join(root,'gen-'+stamp);
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const FILES=['SOUL.md','memories/MEMORY.md','memories/USER.md','topic-sessions.json','service-manual-policy.json','cron/jobs.json'];
const DBS=['memory_store.db','state.db'];
// Everything under data/ (trackers, run records, feedback) comes along. SQLite files
// there are copied with an online backup; their -wal/-shm files are not copied.
const TREES=['skills','scripts','data'];
const sqliteData=rel=>rel.startsWith('data/')&&/\.(sqlite3?|db)$/i.test(rel);

function walk(dir){const out=[];if(!fs.existsSync(dir))return out;for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isSymbolicLink())continue;if(e.isDirectory()){if(['__pycache__','.hub'].includes(e.name))continue;out.push(...walk(p));}else if(e.isFile())out.push(p);}return out;}
// The Lumos persona for Nimbus: SOUL.md without the Hermes identity line, plus
// the owner rules from AGENTS.md that still apply. Hermes-only routing, source
// and gateway notes are left out.
export function renderPersona(soul,agents,home){
  const body=soul.replace(/^You are Hermes Agent, built by Nous Research\.\s*/,'');
  const keep=[];
  for(const para of String(agents||'').split(/\n\s*\n/)){
    if(/^(Service-manual workload exception|Owner execution policy|Keep OpenBubbles\/Apple activation unchanged|Task conversation routing)/.test(para.trim()))keep.push(para.trim().replace(/\n/g,' '));
  }
  return `You are Lumos, Jesse's personal assistant over iMessage, running on Nimbus. Nimbus supplies your tools, memory and model routing; you are the same Lumos across every model.

${body.trim()}

## Nimbus notes
${home?`- ${homeNote(home)}\n`:''}- Your final answer is sent to Jesse as iMessage bubbles automatically (one bubble per paragraph). Use openbubbles_operation only for files (kind "attachments" with files:[{path}]), reactions, typing, edits, unsends or effects.
- Do not ask questions through other channels; ask in your reply.
- Voice memos and audio arrive as files: transcribe them with transcribe_local_audio (rich-tools) before answering. Images: inspect them with view_image.
- Reminders and follow-up checks: use lumos_reminder (kind "message" for a reminder text, kind "task" for a check you should run later and report).
- Web: research_search and research_fetch replace web_search and web_extract; code_search replaces search_files.
- Desktop control (Hermes computer_use) is the lumos-computer connector: list_windows / get_window_state / zoom to look, then click, type_text, press_key, hotkey, scroll or drag. Prefer the browser tool for websites. Look again after acting to confirm the effect.
- Voice: lumos_speak sends a spoken reply as audio when a local voice server is configured; otherwise answer in text.
- Service-manual work runs on Claude Opus (owner decision 2026-11-25; Astra is not on the current plan). Follow the field-service-manuals skill for sources, crops, blue markup and PDF output with Nimbus tools. Use design_render (Nimbus's Claude Design loop) for visual work: blue circles, boxes, arrows and labels on a photo (baseImage + marks), clean redrawn step illustrations and diagrams as SVG, label cards and full manual pages as HTML rendered to PNG or PDF; look at each render and revise until it is right. Photorealistic generative recreation (gpt-image-2) is not available: redraw as a clean vector illustration with design_render, or use original photos, PDF vectors or video frames.
- design_render is also for any other visual Jesse asks for (flyers, cards, charts, mockups, slides): design it, check the render, then send the PNG or PDF with openbubbles_operation.
- You may create or improve your own skills by editing files under the skills folder in your Lumos home with write_file or apply_patch, as skill_manage did in Hermes. Keep each skill's SKILL.md frontmatter.
- Hand off instead of doing everything yourself: for long, multi-step or specialist work (research reports, building or fixing software, Windows or server work, documents, web workflows, anything that would keep Jesse waiting), call lumos_handoff with a complete task. The Nimbus Orchestrator and its specialist workers do it while you reply to Jesse at once that it is underway. When it finishes you are started again in the same conversation with its report: relay the outcome. Quick questions and single-tool actions you still do yourself.
- Your long-term memory tools are memory, fact_store and fact_feedback (the lumos-memory connector). Save durable facts and preferences there.
- Your Hermes skills are listed by the skills tool. skills-review.json in your Lumos home has an audited verdict and notes for each one (2026-11-25): "ready": follow it, applying its notes. "needs-setup": tell Jesse what is missing (listed there) instead of improvising around it. "unavailable" or "hermes-internal": do not use it. Translate Hermes tool names with its toolMap (terminal→shell, skill_view→read_file, patch→apply_patch, vision→view_image, web_extract→research_fetch, cronjob→lumos_reminder, image_generate→design_render, delegate_task→lumos_handoff).
- Python: run skill scripts with F:/Nimbus/data/lumos/venv/Scripts/python.exe (PDF, Word, PowerPoint, Excel, transcript and code-count packages), or with the interpreter a skill's own run.py picks. Never call python3 on this PC (it is a Windows Store stub). Skill scripts are on Windows: run bash-only snippets through Git Bash or rewrite them for PowerShell.

## Owner rules kept from the Hermes integration contract
${keep.map(p=>'- '+p).join('\n')}
`;
}

export function homeNote(home){
  return `Your Lumos home is ${home}. Your data (trackers, run records, feedback), scripts, memories and skills live there, and the scheduled checks run from there. Remembered facts and skills may still name F:\\Projects\\Lumos\\HermesPilot\\home or Documents\\HermesPilot\\home: that is the retired Hermes copy, which Nimbus never reads. Use the same relative path under your Lumos home, and never read or change the Hermes copy.`;
}
export function ensureIntegrationsLink(root,target){
  const link=path.join(root,'integrations');
  if(!fs.existsSync(target))return {linked:false,reason:'missing '+target};
  try{const st=fs.lstatSync(link);if(st.isSymbolicLink()&&path.resolve(fs.readlinkSync(link))===path.resolve(target))return {linked:true,existing:true};throw new Error(link+' exists and is not the expected link');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  fs.mkdirSync(root,{recursive:true});fs.symlinkSync(target,link,'junction');return {linked:true};
}
// Run only as a command, never when another module imports these helpers.
const isMain=process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(isMain){
const plan=[];
for(const rel of FILES)if(fs.existsSync(path.join(hermes,rel)))plan.push({rel,kind:'file'});
for(const rel of DBS)if(fs.existsSync(path.join(hermes,rel)))plan.push({rel,kind:'sqlite'});
for(const tree of TREES)for(const file of walk(path.join(hermes,tree))){
  const rel=path.relative(hermes,file).replaceAll('\\','/');
  if(/-(wal|shm)$/i.test(rel))continue;
  plan.push({rel,kind:sqliteData(rel)?'sqlite':'file'});
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
fs.writeFileSync(path.join(gen,'persona','LUMOS.md'),renderPersona(fs.readFileSync(path.join(hermes,'SOUL.md'),'utf8'),fs.existsSync(agentsFile)?fs.readFileSync(agentsFile,'utf8'):'',gen));
// Original memory text, kept for the divergence report after a rollback.
fs.mkdirSync(path.join(gen,'baseline'),{recursive:true});
for(const f of ['MEMORY.md','USER.md'])if(fs.existsSync(path.join(gen,'memories',f)))fs.copyFileSync(path.join(gen,'memories',f),path.join(gen,'baseline',f));
// Deterministic (no_agent) cron jobs become Nimbus Lumos schedules, disabled until the switch.
let jobs=[];try{const raw=JSON.parse(fs.readFileSync(path.join(gen,'cron','jobs.json'),'utf8'));jobs=(Array.isArray(raw)?raw:raw.jobs||Object.values(raw)).filter(j=>j.no_agent&&j.script&&j.schedule?.kind==='cron').map(j=>({id:'hermes-'+j.id,name:j.name,cron:j.schedule.expr,script:path.basename(j.script),enabled:false,source:'hermes:'+j.id}));}catch{}
fs.writeFileSync(path.join(gen,'schedules.json'),JSON.stringify(jobs,null,2));
manifest.schedules=jobs.map(j=>j.id);
fs.writeFileSync(path.join(gen,'manifest.json'),JSON.stringify(manifest,null,2));
// Skill scripts (field-service-manuals, comprehensive-file-analysis, ...) find
// their private runtime at <two levels above the Lumos home>/integrations, which is
// HermesPilot/integrations under Hermes. Give the Nimbus home root the same link.
ensureIntegrationsLink(root,path.join(path.dirname(hermes),'integrations'));
// The audited skill review travels with every generation. It lists the owner's own
// skills, so it lives in the private data folder (data/lumos/skills-review.json), not in git.
const review=path.join(DATA_DIR,'lumos','skills-review.json');
if(fs.existsSync(review))fs.copyFileSync(review,path.join(gen,'skills-review.json'));
fs.writeFileSync(path.join(root,'current.json.part'),JSON.stringify({generation:path.basename(gen),path:gen,at:manifest.createdAt},null,2));
fs.renameSync(path.join(root,'current.json.part'),path.join(root,'current.json'));
console.log(JSON.stringify({generation:gen,files:manifest.files.length,sourceUnchanged:manifest.sourceUnchanged,changedDuringCopy:after,schedules:manifest.schedules},null,2));
if(!manifest.sourceUnchanged)process.exitCode=2;
}
