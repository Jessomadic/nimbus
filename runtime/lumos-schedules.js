// Deterministic Lumos schedules (Hermes "no_agent" cron jobs): run a script, send
// its stdout to the owner, no model call. Ported behavior from Hermes
// cron/scheduler.py _run_no_agent_job and cron/scheduler_script.py:
// - cwd is the Lumos home (scripts resolve their data next to it);
// - HERMES_CRON_EXECUTION_ID is a fresh 32-hex id per fire;
// - empty stdout, or a final {"wakeAgent": false} line, sends nothing;
// - a non-zero exit sends a short failure notice.
// Each fire is claimed once per job and minute and is never run twice.
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {cronMatches,isValidCron} from './cron.js';

export const SCHEDULE_SCHEMA=`CREATE TABLE IF NOT EXISTS lumos_schedules(id TEXT PRIMARY KEY,name TEXT NOT NULL,cron TEXT NOT NULL,script TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,source TEXT);
CREATE TABLE IF NOT EXISTS lumos_schedule_runs(fire_key TEXT PRIMARY KEY,job TEXT NOT NULL,scheduled_at INTEGER NOT NULL,state TEXT NOT NULL,exit_code INTEGER,output_sha TEXT,error TEXT,updated_at INTEGER NOT NULL);`;
const minuteKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
export function wakes(output){
  const lines=String(output||'').split(/\r?\n/).filter(l=>l.trim());
  if(!lines.length)return false;
  try{const gate=JSON.parse(lines.at(-1).trim());return !(gate&&typeof gate==='object'&&gate.wakeAgent===false);}catch{return true;}
}

export function createLumosSchedules({db,getConfig,send,clock=()=>new Date(),spawnProcess=spawn,log=console,catchUpMinutes=20}){
  db.exec(SCHEDULE_SCHEMA);
  const q=sql=>db.prepare(sql);
  const cfg=()=>getConfig().lumos;
  let timer=null,running=null,lastTickAt=null;
  function upsert(job){
    if(!isValidCron(job.cron))throw new Error('Invalid cron expression for '+job.name);
    if(!/^[\w.-]+\.py$/.test(job.script))throw new Error('Schedule scripts must be .py files in the Lumos scripts folder');
    q('INSERT INTO lumos_schedules(id,name,cron,script,enabled,source) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,cron=excluded.cron,script=excluded.script,source=excluded.source')
      .run(job.id,job.name,job.cron,job.script,job.enabled?1:0,job.source||null);
  }
  const list=()=>q('SELECT * FROM lumos_schedules ORDER BY id').all().map(j=>({...j,enabled:!!j.enabled,lastRun:q('SELECT * FROM lumos_schedule_runs WHERE job=? ORDER BY scheduled_at DESC LIMIT 1').get(j.id)||null}));
  const setEnabled=(id,enabled)=>q('UPDATE lumos_schedules SET enabled=? WHERE id=?').run(enabled?1:0,id).changes===1;
  function runScript(job){
    const l=cfg(),scripts=path.join(l.homeDir,'scripts'),file=path.join(scripts,job.script);
    if(path.dirname(file)!==scripts||!fs.existsSync(file))return Promise.resolve({code:-1,stdout:'',stderr:'Script not found: '+job.script});
    const env={...process.env,HERMES_CRON_EXECUTION_ID:randomBytes(16).toString('hex'),PYTHONIOENCODING:'utf-8'};
    return new Promise(resolve=>{
      const child=spawnProcess(l.python||'python',[file],{cwd:l.homeDir,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';
      child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr=(stderr+d).slice(-4000);});
      const timer=setTimeout(()=>{try{child.kill();}catch{}},120000);
      child.on('error',error=>{clearTimeout(timer);resolve({code:-1,stdout,stderr:error.message});});
      child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.trim(),stderr:stderr.trim()});});
    });
  }
  async function fire(job,at){
    const key=job.id+'@'+minuteKey(at),ts=Math.floor(at.getTime()/1000),t=Math.floor(Date.now()/1000);
    if(q("INSERT OR IGNORE INTO lumos_schedule_runs(fire_key,job,scheduled_at,state,updated_at) VALUES(?,?,?,'running',?)").run(key,job.id,ts,t).changes!==1)return;
    const r=await runScript(job);
    const ok=r.code===0;
    const text=ok?(wakes(r.stdout)?r.stdout:''):`⚠ Scheduled check '${job.name}' failed\n\n${(r.stderr||r.stdout||'exit '+r.code).slice(0,1500)}`;
    q("UPDATE lumos_schedule_runs SET state=?,exit_code=?,output_sha=?,error=?,updated_at=? WHERE fire_key=?").run(text?'sending':'silent',r.code,createHash('sha256').update(r.stdout||'').digest('hex'),ok?null:(r.stderr||'').slice(0,500),Math.floor(Date.now()/1000),key);
    if(!text)return;
    // The send uses a tempGuid derived from the fire key, so the bridge never
    // delivers the same scheduled message twice.
    try{await send(text,'nimbus-sched-'+createHash('sha256').update(key).digest('hex').slice(0,40));q("UPDATE lumos_schedule_runs SET state='sent',updated_at=? WHERE fire_key=?").run(Math.floor(Date.now()/1000),key);}
    catch(error){q("UPDATE lumos_schedule_runs SET state='uncertain',error=?,updated_at=? WHERE fire_key=?").run(String(error.message).slice(0,500),Math.floor(Date.now()/1000),key);log.error('Lumos schedule send:',error.message);}
  }
  function tick(){
    if(running)return running;
    // Clear the busy marker in .finally, never inside the async body: a pass with
    // no await (Lumos disabled, nothing due) would finish before running was even
    // assigned, leaving it set for good and silently stopping every later fire.
    running=runTick().finally(()=>{running=null;});
    return running;
  }
  async function runTick(){
      try{
        // A fire claimed before a crash is uncertain; it is never re-run.
        q("UPDATE lumos_schedule_runs SET state='uncertain',error='interrupted',updated_at=? WHERE state IN ('running','sending') AND updated_at<?").run(Math.floor(Date.now()/1000),Math.floor(Date.now()/1000)-300);
        const l=cfg();if(!l.enabled||!l.schedulesEnabled||!l.homeDir)return;
        const current=clock();current.setSeconds(0,0);
        for(const job of q('SELECT * FROM lumos_schedules WHERE enabled=1').all()){
          // Catch up a missed minute only within a short window (the scripts
          // themselves refuse to run outside their time windows).
          for(let back=catchUpMinutes;back>=0;back--){
            const at=new Date(current.getTime()-back*60000);
            if(cronMatches(job.cron,at)&&at.getTime()>=Date.now()-catchUpMinutes*60000){await fire(job,at);break;}
          }
        }
      }catch(error){log.error('Lumos schedules:',error.message);}
      lastTickAt=new Date().toISOString();
  }
  return {
    upsert,list,setEnabled,tick,lastTickAt:()=>lastTickAt,
    start(){timer??=setInterval(()=>{tick();},30000);timer.unref?.();tick();},
    async stop(){if(timer){clearInterval(timer);timer=null;}await running;},
  };
}
