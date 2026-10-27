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

Queued, designing, building, testing, reviewing, validating and deploying are distinct from ready. Failed checks, missing required agents, uncertain actions, source drift, failed deployment or failed installed-tool assertions remain blocked/review states with their exact cause. A generated file or an agent's assertion alone is insufficient.

Restart preserves accepted requests and stage-task IDs. A committed `request_tool` receipt is reconciled without creating a duplicate build. Interrupted actions/stages are held for review rather than blindly rerun. User-stopped runs are not automatically resumed. Cancellation retains source edits and artifacts; it does not undo an update that has already been scheduled. Retained unreviewed candidate changes prevent a later queued build from silently absorbing them.

Artifacts are retained under `data/tool-development/REQUEST_ID/`; source snapshots and deployment receipts remain under `data/updates/`. Credentials, active configuration, database migrations, dependency installation and external account provisioning are outside automatic tool construction.

QA's `verification.args` must be the actual parameters for one invocation, and assertion paths address the direct tool result. For a tool that accepts `{ "text": "one two three" }` and returns `{ "words": 3 }`, use `verification: { "args": { "text": "one two three" }, "assertions": [{ "path": "words", "equals": 3 }] }`. Multi-case test-harness options are not a substitute for a real callable probe. Current-stage actors do not need the new tool assigned to their own live role before deployment; activation targets the requesting consumers.
