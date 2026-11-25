import {createHash} from 'node:crypto';
import {encodeRedacted} from '../redact.js';
export const revision=(tool,run)=>createHash('sha256').update(JSON.stringify([tool,run])).digest('hex');
export function reviewAction({db,q,authority,id,request}){
 if(!authority?.authenticated||!authority.principal)throw Object.assign(Error('Authentication required'),{statusCode:401});
 if(!authority.sameOrigin)throw Object.assign(Error('Same origin required'),{statusCode:403});
 if(!request||typeof request!=='object')throw Object.assign(Error('Review required'),{statusCode:400});
 if(!authority.sourceOwner||authority.sourceOwner!==request.sourceOwner)throw Object.assign(Error('Source owner mismatch'),{statusCode:403});
 if(!['unknown','observed_failure','observed_success'].includes(request.disposition)||typeof request.observedResult!=='string'||request.observedResult.trim().length<3||request.observedResult.length>4096)throw Object.assign(Error('Structured bounded review required'),{statusCode:400});
 if(!request||typeof request!=='object')throw Object.assign(Error('Review required'),{statusCode:400});
 db.exec('BEGIN IMMEDIATE');
 try{
 const tool=q('SELECT * FROM tool_calls WHERE id=?').get(id);
 const run=tool&&q('SELECT * FROM runs WHERE id=?').get(tool.run_id);
 if(!tool||!run||tool.id!==request.callId||!['running','uncertain'].includes(tool.state)||!['needs_review','interrupted','stopped'].includes(run.status)||revision(tool,run)!==request.revision)throw Object.assign(Error('Review conflict'),{statusCode:409});
 if(q("SELECT id FROM task_events WHERE run_id=? AND type='action.review.disposition' AND json_extract(body,'$.id')=? LIMIT 1").get(run.id,id))throw Object.assign(Error('Already reviewed'),{statusCode:409});
 // Administrative evidence is append-only. Even observed success does NOT
 // grant replay/resume or clear uncertainty. A separate actual host decision is required.
 const audit={id,principal:authority.principal,sourceOwner:authority.sourceOwner,disposition:request.disposition,observedResult:request.observedResult,original:tool,runRevision:request.revision,userVerified:false,workflowAuthorization:false};
 q('INSERT INTO task_events (run_id,type,body) VALUES (?,?,?)').run(run.id,'action.review.disposition',encodeRedacted(audit));
 db.exec('COMMIT');return {ok:true,state:tool.state,workflowAuthorization:false};
 }catch(e){db.exec('ROLLBACK');throw e;}
}
