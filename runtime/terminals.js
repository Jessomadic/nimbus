import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { launch } from './process.js';

export class Terminals {
  constructor(dataDir) { this.dir=path.join(dataDir,'terminals');this.sessions=new Map(); }
  active() { return [...this.sessions.values()].filter(session=>session.child).map(session=>({...session.state})); }
  file(id) { if(!/^[a-f0-9-]{36}$/.test(String(id)))throw new Error('Invalid terminal sessionId');return path.join(this.dir,id+'.json'); }
  save(session) { fs.mkdirSync(this.dir,{recursive:true});fs.writeFileSync(this.file(session.id),JSON.stringify(session.state)); }
  owned(owner,id) {
    let session=this.sessions.get(id);
    if(!session){
      const state=JSON.parse(fs.readFileSync(this.file(id),'utf8'));
      if(state.status==='running')state.status='unknown_after_restart';
      session={id,state};
    }
    if(String(session.state.owner)!==String(owner))throw new Error('Terminal session belongs to another worker');
    return session;
  }
  stop(session,status='stopped') {
    if(!session.child||session.state.status!=='running')return;
    session.state.status=status;this.save(session);
    if(process.platform==='win32')launch('taskkill.exe',['/PID',String(session.child.pid),'/T','/F'],{stdio:'ignore'}).on('error',()=>session.child.kill());
    else session.child.kill('SIGTERM');
  }
  async execute(owner,args,{cwd,signal}={}) {
    if(typeof args.command!=='string'||!args.command.trim())throw new Error('exec_command requires command');
    if([...this.sessions.values()].filter(s=>s.child&&s.state.status==='running').length>=16)throw new Error('Terminal session limit reached');
    signal?.throwIfAborted();
    const id=randomUUID();fs.mkdirSync(this.dir,{recursive:true});
    const out=fs.openSync(path.join(this.dir,id+'.log'),'a');
    const child=launch(process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-NonInteractive','-Command',args.command]:['-c',args.command],{cwd,stdio:['pipe',out,out]});
    const session={id,child,state:{id,owner:String(owner),pid:child.pid,cwd,status:'running',startedAt:new Date().toISOString()}};
    this.sessions.set(id,session);this.save(session);
    const abort=()=>this.stop(session,'interrupted');signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>this.stop(session,'timed_out'),Math.min(3600,Math.max(1,Number(args.timeoutSeconds)||600))*1000);
    child.stdin.on('error',()=>{});
    child.on('error',error=>{session.state.error=error.message;session.state.status='failed';this.save(session);});
    session.closed=new Promise(resolve=>child.once('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',abort);fs.closeSync(out);
      if(session.state.status==='running')session.state.status=code===0?'done':'failed';
      session.state.exitCode=code;session.state.endedAt=new Date().toISOString();this.save(session);session.child=null;resolve();
    }));
    await this.wait(session,args.yieldMs??1000);
    return this.read(owner,{sessionId:id});
  }
  async wait(session,ms) {
    if(!session.closed)return;
    let timer;await Promise.race([session.closed,new Promise(resolve=>{timer=setTimeout(resolve,Math.min(10000,Math.max(0,Number(ms)||0)));})]);clearTimeout(timer);
  }
  read(owner,{sessionId,offset=0,maxBytes=16000}) {
    const session=this.owned(owner,sessionId),log=path.join(this.dir,sessionId+'.log');
    const size=fs.statSync(log).size,start=Math.min(size,Math.max(0,Number(offset)||0)),count=Math.min(64000,Math.max(1,Number(maxBytes)||16000),size-start);
    const fd=fs.openSync(log,'r'),bytes=Buffer.alloc(count);try{fs.readSync(fd,bytes,0,count,start);}finally{fs.closeSync(fd);}
    return {...session.state,sessionId,output:bytes.toString('utf8'),nextOffset:start+count,hasMore:start+count<size,
      ...(session.state.status==='unknown_after_restart'?{note:'The process outcome is unknown after restart. Inspect retained logs and effects; do not relaunch automatically.'}:{})};
  }
  async write(owner,args) {
    const session=this.owned(owner,args.sessionId);
    if(args.chars!==undefined){
      if(!session.child||session.state.status!=='running')throw new Error('Terminal is no longer running');
      await new Promise((resolve,reject)=>session.child.stdin.write(String(args.chars),error=>error?reject(error):resolve()));
    }
    if(args.terminate)this.stop(session);
    await this.wait(session,args.yieldMs??1000);return this.read(owner,args);
  }
  async close() {
    const active=[...this.sessions.values()].filter(s=>s.child);
    for(const session of active)this.stop(session,'interrupted');
    await Promise.allSettled(active.map(s=>s.closed));
  }
}
