const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Display-only summaries never answer, approve, retry or reroute a question.
export function questionPresentation(item={}){
  const original=String(item.question??'');
  if(item.title||item.context||item.recommendation||item.details)return{
    title:item.title||'A question about this task',context:item.context||'',
    prompt:original,recommendation:item.recommendation||'',details:item.details||''
  };
  if(/checker/i.test(original)&&/binding/i.test(original)&&/\b(?:SHA|digest)\b/i.test(original)&&/(?:requires|expected|mismatch|corrected)/i.test(original))return{
    title:'A migration check points to the wrong file',
    context:'The check refers to a different file version than the worker was given. The prepared work is waiting to be checked.',
    prompt:'How should Nimbus correct the check and continue?',
    recommendation:'Correct the test setup and reuse the prepared work. This is an internal repair for Nimbus to resolve.',
    details:original
  };
  const technical=/\b[a-f0-9]{40,64}\b|\b(?:run_checks|completionDescriptor)\b|[a-z]:[\\/]/i.test(original);
  if(technical)return{
    title:'A technical question needs clarification',
    context:'The worker supplied technical details without a plain-language explanation. The Orchestrator needs to clarify the decision before asking you to answer.',
    prompt:'',recommendation:'',details:original
  };
  return{title:'A question about this task',context:'',prompt:original,recommendation:'',details:''};
}

export function renderQuestionCard(question){
  const q=question||{},pending=q.status==='pending',interactive=q.interactive!==false;
  const human=pending&&(q.audience||'human')==='human'&&interactive;
  const host=pending&&q.audience==='host';
  const actor=q.answerActor?.kind==='coordinator'?'Orchestrator':q.answerActor?.kind==='human'?(q.answerActor.principal==='local-admin'?'local administrator':q.answerActor.principal||'owner'):'the recorded respondent';
  const title=q.status==='answered'?'Answered by '+actor:host?'Nimbus needs an internal repair':human?'Your input is needed':pending?q.holdReason?'Waiting for coordinator attention':q.audience==='human'?'Waiting for your answer in the Orchestrator chat':'The Orchestrator is reviewing this question':'Question closed';
  const items=Array.isArray(q.questions)?q.questions:[];
  const summaries=items.map((item,index)=>{
    const p=questionPresentation(item);
    return `<section class="question-item"><h3 class="question-title">${escape(p.title)}</h3>${p.context?`<p class="question-context">${escape(p.context)}</p>`:''}${p.prompt?`<p class="question-prompt">${escape(p.prompt)}</p>`:''}${p.recommendation?`<p class="question-recommendation"><strong>Nimbus recommends</strong>${escape(p.recommendation)}</p>`:''}${p.details?`<details class="question-details"><summary>Technical details</summary><p>${escape(p.details)}</p></details>`:''}${q.status==='answered'?`<p class="question-recorded-answer"><strong>Answer:</strong> ${escape(q.answers?.[index]||'No answer recorded')}</p>`:''}</section>`;
  }).join('');
  const form=()=>items.map((item,index)=>`<label class="field question-answer">${items.length>1?`Answer ${index+1}`:'Your answer'}${item.options?.length?`<select data-question-choice="${index}" aria-label="${escape(item.question)}"><option value="">Choose an answer or type below</option>${item.options.map(option=>`<option value="${escape(option)}">${escape(option)}</option>`).join('')}</select>`:''}<textarea data-question-answer="${index}" rows="2" aria-label="${escape(item.question)}" placeholder="Type your answer"></textarea></label>`).join('')+'<button class="btn primary" data-answer-question>Submit answers</button>';
  const override=pending&&!human&&interactive&&['coordinator','host'].includes(q.audience)?'<details class="question-override"><summary>Answer yourself</summary><p class="muted">Optional. Nimbus can continue resolving this without your answer.</p>'+form()+'</details>':'';
  const provenance=q.originRunId?`<p>Question from task #${Number(q.originRunId)}${q.coordinatorRunId?` · Coordinated by task #${Number(q.coordinatorRunId)}`:''}</p>`:'';
  const coordination=q.reason||provenance?`<details class="question-details question-coordination"><summary>Coordination details</summary>${provenance}${q.reason?`<p>${escape(q.reason)}</p>`:''}</details>`:'';
  return `<div class="approval${pending?'':' decided'} question-card" data-question-id="${Number(q.questionId||q.id)}" data-question-version="${Number(q.version||1)}"><b class="question-status">${escape(title)}</b>${host?'<p class="question-autonomy">Automatic recovery requested. You do not need to answer.</p>':''}${summaries}${human?form():''}${override}${coordination}${pending&&q.transportStatus==='not_sent_disabled'?'<p class="muted question-delivery">Replies are available here. External message delivery is not connected.</p>':''}</div>`;
}
