// Budget admission only. Call before enabled-tool checks, cache lookup, journal
// insertion or execution so rejected requests and cached calls remain bounded.
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
const COLLECTION_TOOLS = new Set(['worker_result', 'tool_request_status']);

function budgetLimits(options) {
  const maxSteps = options?.maxSteps;
  if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > Math.floor((MAX_COUNTER - 1) / 4)) {
    throw new Error('maxSteps must be a positive safe integer with a representable attempt limit');
  }
  return { actionLimit: maxSteps, attemptLimit: Math.max(64, maxSteps * 4) };
}

function counter(value, maximum, fallback = 0) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(maximum, Math.max(0, number));
}

function currentBudget(state, limits) {
  const actionsUsed = counter(state?.steps, limits.actionLimit);
  const attemptsUsed = counter(state?.toolAttempts, limits.attemptLimit + 1);
  return {
    ...limits,
    actionsUsed,
    actionRemaining: Math.max(0, limits.actionLimit - actionsUsed),
    attemptsUsed,
    attemptRemaining: Math.max(0, limits.attemptLimit - attemptsUsed),
  };
}

function increment(value, maximum = MAX_COUNTER) {
  return value < maximum ? value + 1 : maximum;
}

export function chargeToolAttempt(state, name, options) {
  const limits = budgetLimits(options);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Tool budget state must be a mutable checkpoint object');

  const before = currentBudget(state, limits);
  const attemptedTool = typeof name === 'string' ? name : '(invalid tool name)';
  const isCollection = COLLECTION_TOOLS.has(attemptedTool);
  const totalAttempts = Math.max(counter(state.totalToolAttempts, MAX_COUNTER, before.attemptsUsed), before.attemptsUsed);
  const totalActions = Math.max(counter(state.totalActionSteps, MAX_COUNTER, before.actionsUsed), before.actionsUsed);

  state.steps = before.actionsUsed;
  state.toolAttempts = increment(before.attemptsUsed, limits.attemptLimit + 1);
  state.totalToolAttempts = increment(totalAttempts);
  state.totalActionSteps = totalActions;

  // A held request is observable, but it has no action slot and must not reach
  // the action journal or executor. Collection may continue at the action cap.
  if (state.toolAttempts > limits.attemptLimit || !isCollection && state.steps >= limits.actionLimit) {
    const budget = { ...currentBudget(state, limits), attemptedTool, notExecuted: true };
    throw Object.assign(new Error(`Tool budget exhausted before ${attemptedTool}. This request was not executed; checkpoint and completed evidence are retained.`), {
      pause: true,
      code: 'tool_budget_exhausted',
      budget,
    });
  }

  if (!isCollection) {
    state.steps++;
    state.totalActionSteps = increment(totalActions);
  }
  return { ...currentBudget(state, limits), attemptedTool };
}

export function toolBudgetFeedback(state, options) {
  const budget = currentBudget(state, budgetLimits(options));
  if (budget.actionsUsed < Math.ceil(budget.actionLimit * 0.75) && budget.attemptsUsed < Math.ceil(budget.attemptLimit * 0.75)) return '';
  return `Tool budget: ${budget.actionRemaining} of ${budget.actionLimit} action slots and ${budget.attemptRemaining} of ${budget.attemptLimit} tool attempts remain in this continuation. Preserve verified progress and exact evidence. Prefer a bounded continuation or an enabled-worker handoff over repeated exploration; collect accepted work with bounded worker_result or tool_request_status polling. If the remaining action slots cannot safely finish the work, retain the checkpoint and pause before another action. Status polls consume attempts even when they do not consume action slots.`;
}
