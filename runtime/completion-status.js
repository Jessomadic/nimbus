import {redact} from '../redact.js';

// Read-only diagnostic projection. Recorded state is not new file verification,
// completion authority, or permission to resume a held/stopped task.
export function completionStatus(run,state,{bindingPresent=false,outputCaptureRecorded=false}={}){
 const required=run.completion_required===1,scope=run.delegation_scope||'legacy';
 const evidence=state?.delegatedEvidence;
 if(!required&&scope==='legacy'&&!evidence)return null;
 const feedback=typeof evidence?.feedback==='string'?redact(evidence.feedback):null;
 const code=typeof evidence?.code==='string'&&/^[a-z0-9_-]{1,80}$/.test(evidence.code)?evidence.code:null;
 return {required,scope,bindingPresent:!!bindingPresent,outputCaptureRecorded:!!outputCaptureRecorded,
  heldForNoProgress:state?.noProgress===true,decisionCode:code,feedback:feedback?.slice(0,4000)??null,feedbackTruncated:!!feedback&&feedback.length>4000};
}
