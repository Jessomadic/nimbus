import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {verifyOwned,verifyPins} from './required-completion.js';
const hash=b=>createHash('sha256').update(b).digest('hex');
function capture(c){
 verifyOwned(c);verifyPins([...c.inputPins,...c.sourcePins]);
 return c.outputs.map(p=>{
 const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||!s.size||s.size>256000)throw Error('Fresh output must be regular nonempty <=256000 bytes');
 return [p,hash(fs.readFileSync(p))];
 });
}
// Called only inside the host journal execute branch, never on cached/replayed rows.
// Absence/instability fails closed; this is functional evidence, not an OS sandbox.
export async function observeFreshCheck({db,runId,callId,name,args,signal,execute}){
 if(name!=='run_checks')return execute();
 const row=db.prepare('SELECT binding FROM required_completion_bindings WHERE run=?').get(runId);
 if(!row)return execute();
 const binding=JSON.parse(row.binding),c=binding.contract;
 if(c.version!==2||!c.checks.some(k=>isDeepStrictEqual(k.args,args)))return execute();
 const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
 if(binding.runId!==runId||binding.parentRun!==run.parent_run)throw Error('Fresh check identity mismatch');
 const before=capture(c);
 signal?.throwIfAborted();
 const result=await execute();
 // Remove any similarly named field from the handler: only this host observation counts.
 const clean={...result};delete clean.freshOutputObservation;
 if(!result?.pass||result.exitCode!==0||result.timedOut||!result.command?.executable)return clean;
 signal?.throwIfAborted();
 const after=capture(c);
 if(!isDeepStrictEqual(before,after))throw Error('Outputs changed during acceptance checker; inspect before retry');
 return {...clean,freshOutputObservation:{runId,parentRun:binding.parentRun,callId,contractHash:hash(JSON.stringify(c)),files:after}};
}
