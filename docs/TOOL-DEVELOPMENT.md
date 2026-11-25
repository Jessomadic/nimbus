# Missing-tool development

Nimbus workers can report a genuinely missing reusable capability with `request_tool`. This starts a durable team workflow and returns progress to the original Nimbus task/chat or API request. It does not send email, messages or webhooks to an inferred destination.

## Flow

1. The worker inspects `tool_catalog` and `capabilities`. Existing disabled tools, denied actions, missing credentials/dependencies and service outages are reported as access/setup gaps rather than replacement-tool builds.
2. `request_tool` records the capability, tool name, expected effects, acceptance criteria and original run/message/API request. Equivalent active requests share one build; conflicting interfaces do not silently merge.
3. The requester saves its accepted tool-call result and checkpoint, enters `waiting_tool`, and ends its current execution coroutine. This releases its worker and permits self-update. A Builder can request a tool and later handle its own build stage without waiting on its own queue.
4. A domain adviser designs the tool. Builder implements and registers it, QA independently exercises it, and Reviewer inspects the change and evidence. Each stage starts without the worker's prior conversation history, reads the current artifact receipts, and writes a retained JSON receipt. Builds are serialized to prevent source-update races.
5. QA and Reviewer record the exact source hash. They inspect/test the fresh candidate source; the running server's tool list intentionally remains unchanged until deployment. The host checks registry/schema, exercises QA's exact single-call verification payload before deployment, runs full syntax/tests against that reviewed hash, then schedules a supervised self-update after stage tasks finish.
6. The new process must confirm the validated boot hash and registered schema. The host runs QA's representative assertions in a fresh process with isolated Nimbus data/config and without service credentials. Only a passing result permits consumer enablement and `ready`.
7. Eligible waiting tasks resume with refreshed tool definitions and their completed actions retained. The requesting worker uses the tool to finish the original task.

The subprocess is an isolation measure for state/configuration, **not an operating-system security sandbox**. New code remains host code. `host_execute` and `external_write` tools need explicit execution authorization before automatic representative probing/activation; the request reports that action-needed boundary.

## Requests and status

For example, a worker may call:

```json
{
  "title": "Inline text metrics",
  "toolName": "text_statistics",
  "capability": "Return reusable Unicode-aware metrics for an inline string.",
  "domain": "engineering",
  "effects": "read",
  "gapType": "missing_tool",
  "acceptanceCriteria": [
    "Count Unicode code points, whitespace-separated words and logical lines.",
    "Empty input returns zero counts; non-string input is rejected."
  ]
}
```

This is a `request_tool` input, not a direct source edit or a claim that the example tool is installed. `tool_request_status` reads requests connected to the current worker/task. The dashboard shows progress cards and exact stage-task links; team overview also lists recent requests.

API clients use their original run ID and request ID:

- `GET /api/runs/:id` includes `toolRequests`, status and origin correlation.
- `GET /api/runs/:id/events` includes durable `tool.development` progress events.
- `GET /api/tool-requests?runId=:id` lists correlated request summaries.
- `GET /api/tool-requests/:id` returns the retained request and stage evidence.
- `POST /api/tool-requests/:id/cancel` cancels a build without deleting its evidence or claiming source rollback.
- `POST /api/tool-requests/:id/retry` explicitly retries a blocked request from `building`, `testing` or `reviewing` with a recorded reason. Replaced stage rows/receipts are archived; earlier completed stages and user-stopped tasks are not replayed. Uncertain actions must be reconciled before retry.

Live dashboard events are notifications, not proof that a disconnected caller received them. API polling can recover the durable progress after reconnecting.

## Failure and recovery

In progress execution mode, a final assistant message does not finish a lifecycle stage until its required receipt is complete. Missing or malformed receipts keep the same checkpoint and completed tool calls available for another turn. QA and review approval must identify the current source with a top-level 64-hex `sourceHash`; review must match accepted QA. A valid rejection remains a rejection. Repeating the same incomplete evidence stops as no progress; an uncertain action, denied permission, owner stop or source hold is never cleared by this mechanism.

An authenticated owner can associate an inactive retained request with an armed project leader using `POST /api/tool-requests/:id/adopt` (`leaderRunId`, `project`, `reason`). This preserves historical origins and stage evidence and records the new association. `GET /api/tool-requests/:id/ownership` reads it. The leader's assigned `project_recovery` tool can inspect or retry only its adopted requests. Its `continue_incomplete` action also requires the exact `stageRunId` and current `expectedSourceHash`; it resumes a finished stage only after checking the retained checkpoint, predecessor receipts, source state and action journal. The equivalent owner route is `POST /api/tool-requests/:id/continue-incomplete`. Neither path grants permissions or turns an incomplete report into approval.

Chat progress is grouped by request ID into one current-status card. Earlier updates remain available in its expandable history; opening and closing the history is preserved during live updates. Separate requests keep separate cards, and the full stage/task evidence stays linked through View progress.

Recoverable failures are routed automatically. An exhausted Builder checkpoint receives up to three bounded continuations, preserving completed tool calls and archiving each incomplete receipt. An implementation rejection from QA or Reviewer sends its concrete findings to Builder for repair, then runs fresh QA and review; at most two automatic repair cycles run per request. Configure these limits with toolDevelopment.maxAutomaticContinuations and toolDevelopment.maxAutomaticRepairs (0 disables that automatic path). User-stopped tasks and rejected approvals are never revived or bypassed.

A Builder that saves an incomplete budget receipt with one action remaining also qualifies for continuation: reserving the final receipt action must not strand a build at 31/32. Both the host counters and the matching receipt are required. Task details include requests associated with stage and investigation tasks, so a finished worker cannot hide a blocked build behind its `done` status.

Blocked requests are scanned in bounded rotating pages. A request held solely by an earlier candidate is requeued after that candidate is deployed and verified, provided its original waiting checkpoint still matches and has no unresolved action. All source holds are checked again before a new build starts; stopped or unrelated tasks are never revived.

The host also checks execution ownership each lifecycle tick. An active-looking database row without an owning queue entry is recorded as interrupted, or needs review when action outcomes or user input remain unresolved. This check uses actual host ownership rather than age, retains all checkpoints and tool journals, and never declares orphan work successful. Queued/active owned work, parked tool requests and user-stopped work are preserved.

Unknown side effects and permission/setup gaps are assigned to a separate Reviewer or Security Reviewer for evidence collection. The host restricts investigations to observation and writing their assigned report. An investigation cannot retry the original action, edit source/configuration or grant access. The report records observations and the precise next step; unresolved authority or unverifiable external outcomes remain explicit review states.

Queued, designing, building, testing, reviewing, validating and deploying are distinct from ready. Failed checks, missing required agents, uncertain actions, source drift, failed deployment or failed installed-tool assertions remain blocked/review states with their exact cause. A generated file or an agent's assertion alone is insufficient.

Restart preserves accepted requests and stage-task IDs. A committed `request_tool` receipt is reconciled without creating a duplicate build. Interrupted actions/stages are held for review rather than blindly rerun. User-stopped runs are not automatically resumed. Cancellation retains source edits and artifacts; it does not undo an update that has already been scheduled. Retained unreviewed candidate changes prevent a later queued build from silently absorbing them.

Artifacts are retained under `data/tool-development/REQUEST_ID/`; source snapshots and deployment receipts remain under `data/updates/`. Credentials, active configuration, database migrations, dependency installation and external account provisioning are outside automatic tool construction.

QA's `verification.args` must be the actual parameters for one invocation, and assertion paths address the direct tool result. For a tool that accepts `{ "text": "one two three" }` and returns `{ "words": 3 }`, use `verification: { "args": { "text": "one two three" }, "assertions": [{ "path": "words", "equals": 3 }] }`. Multi-case test-harness options are not a substitute for a real callable probe. Current-stage actors do not need the new tool assigned to their own live role before deployment; activation targets the requesting consumers.
