import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {evidence,limits,boundedTail,createFailureDiagnostics} from './diagnostics.js';
export function launch(command,args=[],options={}){
 // Node inherits PS7's module paths when Nimbus starts from a PS7 host. Legacy
 // Windows PowerShell cannot load those modules. Let it build its native path,
 // while retaining an explicit caller-provided environment unchanged.
 if(process.platform==='win32'&&/^powershell(?:\.exe)?$/i.test(String(command).split(/[\\/]/).at(-1))&&options.env==null){
  const env={...process.env};
  for(const key of Object.keys(env))if(key.toUpperCase()==='PSMODULEPATH')delete env[key];
  options={...options,env};
 }
 return spawn(command,args,{windowsHide:true,...options});
}
export async function capture(command,args=[],{timeout=15000,signal,input,closeGraceMs=2000,diagnosticTail=false,resultEvidence=false,...options}={}){
 signal?.throwIfAborted();
 const facts={schema:'nimbus.process-evidence.v1',pid:null,startedAt:new Date().toISOString(),closedAt:null,exitCode:null,signal:null,timedOut:false,aborted:false,killRequested:false,killExitCode:null,killSignal:null,killError:null,descendantsTerminated:null};
 const prefixDecoders={out:new StringDecoder('utf8'),err:new StringDecoder('utf8')},prefixBytes={out:0,err:0};const seen={out:0,err:0};let out='',err='',child,timer,grace;
 const successLimit=2000000,successDecoder=new StringDecoder('utf8');let successOut='';
 const tails=diagnosticTail===true?Object.fromEntries(['out','err'].map(kind=>[kind,{text:'',clipped:false,decoder:new StringDecoder('utf8')}])):null;
 // A raw rolling suffix cannot reconstruct a multiline secret after its header
 // has been evicted. Remember a PEM start across chunks and discard BOTH optional
 // tails for the rest of this capture. Existing prefix redaction is unchanged.
 const secretProbe={out:'',err:''};let suppressDiagnosticTails=false,suppressionReason=null;
 const suppress=(reason='multiline_secret_marker')=>{suppressDiagnosticTails=true;suppressionReason??=reason;for(const tail of Object.values(tails||{}))tail.text='';for(const block of Object.values(failures||{}))block.clear();};
 const failures=tails?Object.fromEntries(['out','err'].map(kind=>[kind,createFailureDiagnostics({onSecret:suppress})])):null;
 const failureEvidence=(extra={})=>{
 const base=evidence({...facts,...extra},out,err,seen);if(!tails)return base;
 const omitted='Diagnostic tail omitted after a secret marker or unclassified terminal sequence.\n';
 const stdoutTail=suppressDiagnosticTails?omitted:boundedTail(tails.out.text,limits.stdout,tails.out),stderrTail=suppressDiagnosticTails?omitted:boundedTail(tails.err.text,limits.stderr,tails.err);
 const outFailure=failures.out.snapshot(),errFailure=failures.err.snapshot();
 return Object.freeze({...base,stdoutTail,stderrTail,stdoutFailures:suppressDiagnosticTails?'':outFailure.text,stderrFailures:suppressDiagnosticTails?'':errFailure.text,failureBlocks:{stdout:outFailure.count,stderr:errFailure.count,truncated:suppressDiagnosticTails||outFailure.truncated||errFailure.truncated},stdoutTailTruncated:suppressDiagnosticTails||seen.out>Buffer.byteLength(stdoutTail),stderrTailTruncated:suppressDiagnosticTails||seen.err>Buffer.byteLength(stderrTail),...(suppressDiagnosticTails?{diagnosticTailSuppressed:suppressionReason}:{})});
 };
 return await new Promise((resolve,reject)=>{
 let settled=false;
 const done=(error)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(grace);signal?.removeEventListener('abort',abort);
 if(error){const e=failureEvidence();
 // Only already-redacted, bounded complete diagnostic lines may appear in the
 // compatibility error label. Raw capture buffers remain outside the message.
 const label=(e.stderrFailures||e.stdoutFailures)?(e.stderrFailures||e.stdoutFailures).trim().slice(0,1200):(e.stderrTail||e.stdoutTail||e.stderr||e.stdout).trim().slice(-1200);
 reject(Object.assign(new Error(error+(label?': '+label:'')),{uncertain: facts.timedOut || facts.aborted || (facts.pid !== null && (facts.closedAt === null || facts.exitCode === null)), evidence:e,stdout:e.stdout,stderr:e.stderr,exitCode:e.exitCode,...(tails?{stdoutTail:e.stdoutTail,stderrTail:e.stderrTail}:{})}));}
 else if(seen.out>successLimit){const e=failureEvidence({captureOverflow:true,outputComplete:false});reject(Object.assign(new Error('Successful process output exceeded capture limit; output incomplete'),{evidence:e,exitCode:e.exitCode,stdout:e.stdout,stderr:e.stderr,...(tails?{stdoutTail:e.stdoutTail,stderrTail:e.stderrTail}:{})}));}
 else {const stdout=successOut+successDecoder.end(),e=failureEvidence({outputComplete:true});resolve(resultEvidence?{stdout,stderr:e.stderr,exitCode:e.exitCode,evidence:e,timedOut:e.timedOut}:stdout);}};
 const stop=()=>{facts.killRequested=true;
 try{if(process.platform==='win32'&&child.pid){const killer=launch('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'});
 killer.on('error',e=>{facts.killError=e.code||'kill launch error';});killer.on('close',(c,s)=>{facts.killExitCode=c;facts.killSignal=s;});
 }else child.kill();}catch(e){facts.killError=e.code||'kill error';}
 grace=setTimeout(()=>{child.stdout?.destroy();child.stderr?.destroy();child.unref();done('Process timed out or cancelled; close unknown');},closeGraceMs);};
 const abort=()=>{facts.aborted=true;stop();};
 try{child=launch(command,args,{stdio:['pipe','pipe','pipe'],...options});facts.pid=child.pid??null;}catch(e){done('Process spawn failed');return;}
 const collect=(kind,c)=>{if(kind==='out'&&seen.out<successLimit)successOut+=successDecoder.write(c.subarray(0,Math.max(0,successLimit-seen.out)));seen[kind]+=c.length;const cap=limits[kind==='out'?'stdout':'stderr']+4096;
 if(tails){const tail=tails[kind],text=tail.decoder.write(c),probe=secretProbe[kind]+text;
 if(/-----BEGIN(?:\s|$)/i.test(probe))suppress();
 secretProbe[kind]=probe.slice(-10);
 if(!suppressDiagnosticTails){failures[kind].write(text);if(!suppressDiagnosticTails){tail.text+=text;if(Buffer.byteLength(tail.text)>cap){tail.text=Buffer.from(tail.text).subarray(-cap).toString('utf8');tail.clipped=true;}}}}
 const prefix=c.subarray(0,Math.max(0,cap-prefixBytes[kind]));prefixBytes[kind]+=prefix.length;const decoded=prefixDecoders[kind].write(prefix);
 if(kind==='out')out+=decoded;else err+=decoded;};
 child.stdout.on('data',c=>collect('out',c));child.stderr.on('data',c=>collect('err',c));
 child.on('error',()=>done('Process spawn failed'));
 child.on('close',(code,s)=>{facts.closedAt=new Date().toISOString();facts.exitCode=code;facts.signal=s;
 done(facts.timedOut?'Process timed out':facts.aborted?'Process cancelled':code!==0?'Process failed ('+code+')':null);});
 child.stdin.on('error',()=>{});child.stdin.end(input);
 timer=setTimeout(()=>{facts.timedOut=true;stop();},timeout);
 signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
