export function traceWaitingLabel(steps) {
  const waiting = steps.filter(step => step.state === 'waiting');
  if (!waiting.length) return null;
  const reason = step => step.waitReason || (step.tool === 'request_user_input' ? 'input' : step.tool === 'worker_result' ? 'delegated' : 'approval');
  if (waiting.some(step => reason(step) === 'approval')) return 'Waiting for your approval';
  if (waiting.some(step => reason(step) === 'input')) return 'Waiting for your answer';
  if (waiting.some(step => reason(step) === 'recovery')) return 'Waiting for automatic recovery';
  if (waiting.some(step => reason(step) === 'coordination')) return 'The Orchestrator is resolving a question';
  if (waiting.some(step => reason(step) === 'delegated')) return 'Waiting for delegated work';
  return 'Waiting for work to finish';
}
