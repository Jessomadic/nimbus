import {implementationFindings} from './implementation-findings.js';
// Only host budget counters and matching stage receipts authorize continuation.
// A Builder may reserve its final action to save a partial receipt and return.
// A rejected approval or uncertain action is never a reason to replay a stage.
export function stageRecovery({phase,run,receipt,budget,uncertain}) {
  let checkpoint;try{checkpoint=JSON.parse(run?.checkpoint||'{}');}catch{return null;}
  if (uncertain || checkpoint?.noProgress || !run || !['done','paused'].includes(run.status)) return null;
  const valid = receipt && receipt.phase === phase && receipt.approved === false && typeof receipt.summary === 'string' && receipt.summary.trim();
  if (valid && ['permission','setup','uncertain','external_input'].includes(receipt.failureKind)) return null;
  if (phase === 'building' && (budget?.exhausted || budget?.actionRemaining === 1 || budget?.legacyExhausted)) {
    const hardPause = run.status === 'paused' && /^Tool budget exhausted before /.test(run.last_error || '');
    const partial = valid && Array.isArray(receipt.remainingWork) && receipt.remainingWork.length > 0 && receipt.remainingWork.every(item => typeof item === 'string' && item.trim()) &&
      (receipt.reasonCode === 'tool_budget_exhausted' || /(?:action|tool) budget exhausted/i.test(receipt.summary));
    if (((budget?.exhausted || budget?.legacyExhausted) && (hardPause || partial)) || (run.status === 'done' && partial)) return {kind:'continuation',phase,reason:'The Builder reached its action budget or reserved its final receipt action. Completed work and its checkpoint are retained.'};
  }
  const findings = implementationFindings(receipt?.findings);
  if (valid && ['building','testing','reviewing'].includes(phase) && receipt.failureKind === 'implementation' && findings?.length > 0) {
    return {kind:'repair',phase,reason:receipt.summary,findings:findings.slice(0,20)};
  }
  return null;
}
