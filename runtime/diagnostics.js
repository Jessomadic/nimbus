import {redact} from '../redact.js';
import {stripVTControlCharacters} from 'node:util';
export const limits=Object.freeze({stdout:16384,stderr:8192});
export const failureDiagnosticLimit=8192;

// Scan independently of retained line length. A discarded ANSI-styled PEM
// header must never leave its body looking like ordinary failure text.
function secretDetector(unsafe){
 let mode='text',probe='',sequence=0,stopped=false;
 const stop=reason=>{stopped=true;unsafe(reason);};
 return text=>{
  if(stopped)return;
  for(const char of text){
   const code=char.codePointAt(0);
   if(mode!=='text'&&++sequence>256){stop('unclassified_terminal_sequence');return;}
   if(mode==='escape'){
    if(char==='[')mode='csi';
    // Terminal strings are not normalized consistently by downstream log
    // sanitizers. Never skip a payload that might contain a secret header.
    else if([']','P','X','^','_'].includes(char)){stop('unclassified_terminal_sequence');return;}
    else if(code>=0x30&&code<=0x7e)mode='text';
    else if(!(code>=0x20&&code<=0x2f)){stop('unclassified_terminal_sequence');return;}
    continue;
   }
   if(mode==='csi'){
    if(code>=0x40&&code<=0x7e)mode='text';
    else if(!(code>=0x20&&code<=0x3f)){stop('unclassified_terminal_sequence');return;}
    continue;
   }
   sequence=0;
   if(char==='\x1b'){mode='escape';continue;}
   if(code===0x9b){mode='csi';continue;}
   if([0x90,0x98,0x9d,0x9e,0x9f].includes(code)){stop('unclassified_terminal_sequence');return;}
   probe=(probe+char.toLowerCase()).slice(-10);
   if(probe==='-----begin'){stop('multiline_secret_marker');return;}
  }
 };
}

// Keep bounded failure blocks independently of the prefix and rolling tail.
// In a long TAP run, the failing assertion can otherwise disappear between them.
// Only complete lines enter the buffer; oversized lines and partial credentials
// are discarded, not truncated into apparently safe fragments.
export function createFailureDiagnostics({onSecret=()=>{}}={}){
 let pending='',dropping=false,raw='',bytes=0,active=false,lines=0,count=0,truncated=false,suppressed=false,specSummary=false,specBlock=false;
 const suppress=reason=>{suppressed=true;pending='';raw='';bytes=0;active=false;truncated=true;onSecret(reason);};
 const detect=secretDetector(suppress);
 const append=line=>{
  const size=Buffer.byteLength(line);
  if(bytes+size>failureDiagnosticLimit){truncated=true;active=false;return;}
  raw+=line;bytes+=size;
 };
 const accept=line=>{
  const clean=stripVTControlCharacters(line);
  if(/-----BEGIN(?:\s|$)/i.test(clean)){suppress('multiline_secret_marker');return;}
  // Node's spec reporter (the default on Node 26 even when piped) repeats every
  // failure under a closing "✖ failing tests:" summary; count each failure once.
  if(/^\s*✖ failing tests:\s*$/.test(clean)){specSummary=true;active=false;return;}
  const specStart=!specSummary&&/^\s*✖ \S/.test(clean);
  // In a spec block the error line is that failure's cause, not a new failure.
  const errorStart=!specSummary&&!(active&&specBlock)&&/^\s*(?:[\w.]*Error(?:\s*\[[^\]]+\])?:)/.test(clean);
  const start=specStart||/^\s*not ok(?:\s+\d+)?(?:\s+-\s+|\s*$)/.test(clean)||errorStart;
  if(start){count++;active=true;lines=0;specBlock=specStart;}
  else if(active&&/^\s*(?:ok\b|# Subtest:|1\.\.\d+|# (?:tests|suites|pass|fail|duration_ms)\b|[✔ℹ▶] )/.test(clean)){active=false;}
  if(!active)return;
  if(lines++>=48){truncated=true;active=false;return;}
  append(clean);
  if(/^\s*\.\.\.\s*$/.test(clean))active=false;
 };
 return {
  write(text){
   detect(text);if(suppressed)return;
   for(let offset=0;offset<text.length;){
    const newline=text.indexOf('\n',offset),end=newline<0?text.length:newline+1;
    if(!dropping){
     const fragment=text.slice(offset,end);
     if(Buffer.byteLength(pending)+Buffer.byteLength(fragment)>4096){pending='';dropping=true;truncated=true;}
     else pending+=fragment;
    }
    if(newline>=0){
     if(dropping){if(active)append('[Oversized diagnostic line omitted.]\n');}
     else accept(pending);
     pending='';dropping=false;
    }
    offset=end;
   }
  },
  clear(){pending='';raw='';bytes=0;active=false;dropping=false;},
  snapshot(){
   // raw is already byte bounded. Redaction can expand it; apply the final
   // budget only at complete redacted lines and report any resulting loss.
   const safe=boundedText(raw,Number.MAX_SAFE_INTEGER),all=Buffer.from(safe);
   const clipped=all.length>failureDiagnosticLimit;
   const prefix=clipped?all.subarray(0,failureDiagnosticLimit).toString('utf8'):safe;
   const text=clipped?prefix.slice(0,prefix.lastIndexOf('\n')+1):prefix;
   return {text,count,truncated:truncated||clipped||Boolean(pending&&active)};
  }
 };
}
export function boundedText(value,limit){
 // Redact before clipping. Discard final partial line: credentials split at
 // the capture boundary must never be persisted as a misleading safe prefix.
 const text=stripVTControlCharacters(String(value||''));const end=text.lastIndexOf('\n');
 const safe=redact((end<0?'':text.slice(0,end+1)).replace(/https?:\/\/[^\s/@]+@/gi,'https://[REDACTED]@').replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]'));
 let b=Buffer.from(safe);if(b.length>limit)b=b.subarray(0,limit);
 let out=b.toString('utf8');while(Buffer.byteLength(out)>limit)out=out.slice(0,-1);
 return out;
}
// Tail buffers may begin in the middle of a secret-bearing line. Discard that
// entire leading fragment before redaction, as well as an unfinished last line.
export function boundedTail(value,limit,{clipped=false}={}){
 let text=stripVTControlCharacters(String(value||''));
 if(clipped){const first=text.indexOf('\n');if(first<0)return '';text=text.slice(first+1);}
 const end=text.lastIndexOf('\n');if(end<0)return '';
 const safe=redact(text.slice(0,end+1).replace(/https?:\/\/[^\s/@]+@/gi,'https://[REDACTED]@').replace(/Bearer\s+[^\s]+/gi,'Bearer [REDACTED]'));
 const bytes=Buffer.from(safe);if(bytes.length<=limit)return safe;
 // Keep the newest complete lines. Dropping the first cut line also removes
 // any UTF-8 sequence split by the byte boundary; no fragments are persisted.
 const tail=bytes.subarray(-limit).toString('utf8'),first=tail.indexOf('\n');
 return first<0?'':tail.slice(first+1);
}
export function evidence(facts,out,err,seen){
 return Object.freeze({...facts,stdout:boundedText(out,limits.stdout),stderr:boundedText(err,limits.stderr),
 stdoutBytesSeen:seen.out,stderrBytesSeen:seen.err,stdoutTruncated:seen.out>Buffer.byteLength(boundedText(out,limits.stdout)),stderrTruncated:seen.err>Buffer.byteLength(boundedText(err,limits.stderr))});
}
