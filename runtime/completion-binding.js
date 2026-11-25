import {compileRequiredCompletion} from './required-completion.js';
import {inspectDelegatedCompletion} from './delegated-completion.js';
import {ensureDelegationScopeSchema} from './delegation-scope.js';
const fail=message=>{throw Object.assign(Error(message),{pause:true,code:'completion_setup_hold'});};
export function ensureCompletionSchema(db){
 ensureDelegationScopeSchema(db);
 if(!db.prepare('PRAGMA table_info(runs)').all().some(c=>c.name==='completion_required'))db.exec('ALTER TABLE runs ADD COLUMN completion_required INTEGER NOT NULL DEFAULT 0');
 db.exec(`CREATE TABLE IF NOT EXISTS completion_output_captures(run INTEGER PRIMARY KEY REFERENCES runs(id),evidence TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS completion_capture_no_update BEFORE UPDATE ON completion_output_captures BEGIN SELECT RAISE(ABORT,'immutable completion capture'); END;
 CREATE TRIGGER IF NOT EXISTS completion_capture_no_delete BEFORE DELETE ON completion_output_captures BEGIN SELECT RAISE(ABORT,'immutable completion capture'); END;
 CREATE TABLE IF NOT EXISTS required_completion_bindings(run INTEGER PRIMARY KEY REFERENCES runs(id),binding TEXT NOT NULL);
 CREATE TRIGGER IF NOT EXISTS completion_binding_no_update BEFORE UPDATE ON required_completion_bindings BEGIN SELECT RAISE(ABORT,'immutable completion binding'); END;
 CREATE TRIGGER IF NOT EXISTS completion_binding_no_delete BEFORE DELETE ON required_completion_bindings BEGIN SELECT RAISE(ABORT,'immutable completion binding'); END;
 CREATE TRIGGER IF NOT EXISTS completion_required_no_update BEFORE UPDATE OF completion_required ON runs WHEN OLD.completion_required != NEW.completion_required BEGIN SELECT RAISE(ABORT,'immutable completion requirement'); END;`);
}
export function bindCompletion(db,id,parentRun,contract){
 db.prepare('INSERT INTO required_completion_bindings(run,binding) VALUES (?,?)').run(id,JSON.stringify({runId:id,parentRun,contract}));
}
export function hydrateCompletion(db,runId,state){
 const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
 if(!run)fail('Run absent');
 const row=db.prepare('SELECT binding FROM required_completion_bindings WHERE run=?').get(runId);
 if(run.delegation_scope==='conversation'&&run.completion_required)fail('Conversation cannot carry execution completion authority');
 if(run.delegation_scope==='execution'&&!run.completion_required)fail('Execution scope requires its immutable completion binding');
 if(!run.completion_required){if(row)fail('Unexpected binding on legacy run');delete state.requiredCompletion;delete state.delegatedCompletion;return state;}
 if(!row)fail('Required binding missing; no replay');
 let binding;try{binding=JSON.parse(row.binding);}catch{fail('Required binding malformed');}
 if(binding.runId!==run.id||binding.parentRun!==run.parent_run)fail('Immutable parent/run identity mismatch');
 state.requiredCompletion=true;state.delegatedCompletion=binding;
 return state;
}
export function validateDispatch(db,parentRun,descriptor,ownedRoot){
 const parent=db.prepare('SELECT * FROM runs WHERE id=?').get(parentRun);
 if(!parent||!['running','routing'].includes(parent.status))fail('Execution dispatch needs its active authenticated parent');
 return compileRequiredCompletion('execution',descriptor,ownedRoot);
}
export function finalizeCompletion(db,runId,state,signal){
 db.exec('SAVEPOINT completion_finish');
 try{
 const run=db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
 hydrateCompletion(db,runId,state);
 if(run.completion_required){
 if(!['running','routing'].includes(run.status)||signal?.aborted)fail('Terminal completion conflict or stop');
 const denied=db.prepare("SELECT id FROM approvals WHERE run_id=? AND status IN ('denied','rejected') LIMIT 1").get(runId);
 if(denied)fail('Refusal retained; no replay');
 const result=inspectDelegatedCompletion({binding:state.delegatedCompletion,requiredCompletion:true,run,signal,rows:db.prepare('SELECT * FROM tool_calls WHERE run_id=? ORDER BY rowid').all(runId)});
 if(!result.complete)fail(result.feedback);
 if(state.delegatedCompletion.contract.version===2)db.prepare('INSERT INTO completion_output_captures(run,evidence) VALUES (?,?)').run(runId,JSON.stringify({runId,parentRun:run.parent_run,receipts:result.receipts,files:result.files}));
 }
 const changed=db.prepare("UPDATE runs SET status='done',last_error=NULL,ended_at=unixepoch() WHERE id=? AND status IN ('running','routing')").run(runId).changes;
 if(changed!==1)fail('Terminal SQL compare-and-set conflict');
 db.exec('RELEASE completion_finish');
 }catch(e){db.exec('ROLLBACK TO completion_finish');db.exec('RELEASE completion_finish');throw e;}
}
