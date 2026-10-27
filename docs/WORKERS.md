# Specialist workers

Nimbus has one Orchestrator and twenty prompt-specialized worker roles. They share the same local inference pool and subscription backend. Creating a role creates a Nimbus worker record and private workspace; it does not allocate or train a model.

| Worker | Preferred family | Default effort | Focus |
| --- | --- | --- | --- |
| Orchestrator | Sol | High | Hermes/Lumos contact, team intake, specialist assignments and verified result collection |
| Researcher | Sol | High | Primary sources, applicability, conflicting evidence |
| Builder | Sol | Medium | Implementation and verified runtime behavior |
| Reviewer | Sol | High | Independent correctness and regression review |
| Architect | Astra | High | System contracts, tradeoffs and migration plans |
| QA Engineer | Terra | Medium | Bounded acceptance flows and failure testing |
| Security Reviewer | Astra | High | Defensive authorization, secrets and trust-boundary review |
| Windows Operator | Sol | Medium | Windows diagnosis, startup and deployment validation |
| Automation Engineer | Luna | Medium | Scoped jobs, idempotency, integrations and recovery |
| Data Analyst | Sol | High | Data quality, calculations and reproducible analysis |
| Technical Writer | Astra | Medium | Manuals, documentation and authored teaching material |
| Frontend Designer | Sol | Medium | Interface design, implementation and accessibility |
| Browser Operator | Terra | Medium | Defined web flows and saved-result verification |
| Knowledge Curator | Shared local | Medium | Source organization, provenance and shared knowledge |
| Office Assistant | Luna | Medium | Drafts, scheduling and routine administration |
| GitHub | Sol | Medium | Coordinates its five specialists and verifies their results |
| GitHub Sync | Luna | Medium | Fetch, compare and fast-forward-only pull workflows |
| GitHub Commits | Sol | Medium | Focused staging, validation and local commits |
| GitHub Push | Luna | Medium | Explicit remote/refspec and remote SHA verification |
| GitHub Pull Requests | Sol | Medium | PR creation/updates, review and merge-readiness evidence |
| GitHub Actions | Sol | High | CI diagnosis, workflow maintenance and run verification |

## Parent agents and subagents

The Orchestrator is the topmost agent. Its sidebar branch contains display groups and their agents; the whole branch and each group collapse independently. It uses the read-only `team_status` tool to inspect live roster/capabilities and bounded task metadata, delegates through `ask_worker`, and collects actual child results through `worker_result`. It coordinates work within the human user's authority. Its designated Hermes/Lumos contact does not imply an active bridge connection.

Its native tool assignment is deliberately coordination-focused. For substantial work it inspects `team_status` first and assigns a bounded specialist task early; filesystem investigation, code, host operations and browser execution stay with capable specialists. The coordinator keeps planning, clarification, task/connector inventory, handoff/result collection, shared notes, missing-tool requests and self-update control. A disabled specialist tool is a reason to delegate, not to construct a permission bypass. `bin/repair-orchestrator.mjs` previews or applies this role correction to an existing coordinator with retained settings and a repair receipt.

The setup command adopts existing parentless agents beneath Orchestrator. The GitHub coordinator retains its five GitHub specialists through persistent `parent_bot_id` relationships, and other existing nested relationships remain intact. New specialists default to Orchestrator when it exists. Any specialist can be assigned another parent in **Settings → Parent agent**; cycles and missing parents are rejected, and Orchestrator itself must remain parentless. Organizational links and display groups do not restrict direct communication between agents. Deleting a parent leaves its workers independent rather than deleting their history.

The coordinator delegates using `ask_worker`, retains each task ID, and collects `worker_result` before claiming success. Each delegated task has its own checkpoint, tool journal, model route and `parent_run` link. It starts with its supplied assignment/context and private working notes, without borrowing or replacing the specialist's unrelated human conversation. Resumed delegated tasks retain their own checkpoint. Task ancestry prevents circular delegation and limits handoff depth to four. Organizational parent links describe the roster; enabled tools and approval rules remain the execution permissions.

Incoming API, Hermes and Lumos jobs likewise use their own supplied context and checkpoints. A new request does not import an earlier request's completed assignments as its checkpoint, and it does not replace an agent's human conversation. Ordinary human chat retains its conversational continuity. Integration callers keep the accepted request/run IDs for status, idempotent retrieval and explicit checkpoint resume.

## Sidebar organization

Display groups organize navigation independently of the worker delegation graph. Drag an agent onto another group's heading or between its agents to move it. A displayed parent moves with its visible subagents, while children displayed elsewhere stay in their existing groups. The move changes only display placement and sidebar order; parent links, tools, instructions, private notes, task evidence and conversations are retained. A single agent can also move through **Settings → Display group**.

Drag a group heading near the top or bottom edge of another heading to reorder it among those siblings. Drop in the middle of a heading to nest the group, including its existing subgroups. The **Move group to top level** target appears during group dragging. Empty groups are also shown as drop targets while dragging. Cycles and moving the root Orchestrator are rejected. Group chats are displayable/reorderable as a category; moving an agent into that category does not change chat membership and is refused.

Mouse users can press and drag. Touch users hold briefly before dragging; an immediate swipe continues to scroll. Group headings support **Alt + Up/Down** for sibling order, **Alt + Right** to nest beneath the previous sibling, and **Alt + Left** to move out one level. Escape and touch cancellation discard a move. Search results cannot be dragged.

Group order and nesting are persisted through the authenticated sidebar API in the `sidebar_layout` setting. Agent moves update display metadata and `side_order` in one SQLite transaction; stale group/agent origins are rejected, and a failed multi-agent update rolls back entirely. Collapse preferences remain browser-local. Badges on collapsed parent groups aggregate nested activity, approvals and unread threads.

## Tool budgets and recovery

`workers.maxSteps` bounds action calls in each continuation. Collection/status tools (`worker_result`, `tool_request_status`) use a separate finite attempt allowance instead of consuming action slots; disabled-tool requests and cached calls remain attempt-bounded. The model receives a remaining-budget notice near exhaustion. A held call records its name and non-execution in `tool.budget_exhausted`; the host does not start it. Parent collection releases model/worker capacity and waits up to one minute per call.

Tool journals and checkpoints retain complete results. Local and Codex inference receive explicit partial previews for oversized tool outputs, so a preview is not proof of complete inspection. A fatal host pause, cancellation or uncertain action stops later queued calls.

Normal checkpoint resume preserves its existing instructions. After an authorized role repair, `POST /api/runs/:id/resume` may receive `refreshInstructions:true`, a nonempty `reason`, and an optional bounded `continuation`. This saves the exact old checkpoint under `data/checkpoints/RUN_ID/`, records instruction hashes and recovery evidence, loads the current standing brief, and resets the continuation counters while retaining committed tool outcomes. Stopped tasks and unresolved uncertain actions remain held. Task details show current budget counters and actual delegated child tasks.

GitHub workers use the already configured GitHub connector when present. The live read-only connector check identified **Jessomadic** as the connected account. The native Codex adapter exposes MCP tools under non-reserved aliases while retaining their canonical `mcp__github__...` names for execution, approvals and audit records. Additional token permissions may be needed for a specific operation; creating the agent does not grant extra GitHub permissions.

Synchronization, committing, pushing, PR operations and Actions execution are separate authorization boundaries. The coordinator serializes mutations of the same checkout/index. The live delegation check performed read-only Git inspection; it did not commit, push, create PRs or change workflows on a real repository.

These are starting preferences, not benchmarked guarantees for every task. The current [OpenAI model selection guidance](https://developers.openai.com/api/docs/guides/model-selection) informs the families; actual exact versions depend on the subscription account catalogue and successful access. Nimbus does not silently upgrade model generations or enable paid API billing.

## Preferences and overrides

In a worker's settings:

- **Role model preference** is supplied to the local router with the role, task and effort preference. Typical specialist work starts there; simpler work can stay local and harder work can escalate.
- **Model override → Automatic** enables that routing. Select Local, Luna, Terra, Sol or Astra to explicitly choose a family for the worker's subsequent tasks.
- OpenAI unavailability falls back to local capacity; local resource/loading/inference failure falls back to the subscription. If the local router cannot run, the host uses the worker's cloud-family preference, or `routing.cloudFallbackTier` (Luna by default) when that preference is Local/blank. This is recorded as an availability fallback, not a model-authored classification. Even an explicit Local selection can use that escape route. The task pauses only when the permitted backends cannot proceed or another review/budget boundary requires it.
- Changing either setting does not load a separate resident model. Existing context/checkpoints continue to use their retained standing-instruction snapshot until a new task starts; the routing decision is recorded on each attempt.

## Prompt composition

`runtime/prompts.js` contains the versioned shared behavior. `runtime/roles.js` contains each role's mission, workflow, evidence standards, boundaries, handoff guidance and acceptance criteria. Saved custom specialist instructions are editable in worker settings.

The shared brief covers task authority and clarification; evidence and source quality; Windows conventions; enabled tools; untrusted content; changes and rollback; browser ownership; honest visual-inspection limits; shared model capacity; uncertain outcomes; private memory and shared knowledge; bounded delegation; verification; and truthful completion reporting.

Each task receives the saved worker brief plus private memory through the same local/cloud execution path. Codex receives additional host execution instructions. New tasks rebuild `data/bots/<id>/AGENTS.md` from current settings and team membership; that generated file is a snapshot, so edit specialist instructions in the dashboard rather than editing the generated file directly.

Tool permissions are enforced by Nimbus, not by a role's name. Existing workers keep their enabled tools and connectors during an upgrade. New Researcher and Browser Operator workers use browser/file/note/handoff tools; Knowledge Curator uses file/note/handoff tools. Other templates include host shell access for their workflows. Third-party connectors remain separately assigned and authenticated. Shell/file access is not a filesystem sandbox.

## Upgrade an existing installation

Create a backup, finish active tasks, then run:

```powershell
node --no-warnings --env-file-if-exists=.env bin/upgrade-team.mjs
node --no-warnings --env-file-if-exists=.env bin/upgrade-team.mjs --apply
```

The first command previews changes. The apply command upgrades the starter roles, adds missing specialists and refreshes all team rosters. It preserves worker IDs, chats, private memory, connector assignments, explicit model overrides, enabled tools and non-starter instructions. A before/after receipt is saved under `data/verification/`. Running it again reuses matching profile identities rather than creating duplicates.

## Codex session isolation

Nimbus cloud inference requests `ephemeral: true` and refuses to run if the native Codex server does not confirm temporary mode. Nimbus persists its own tasks and checkpoints; inference sessions should not become separate tasks in the Codex app sidebar. Earlier port-verification sessions were persistent; the twelve positively identified test threads have been archived through the app, without deleting their recoverable history.
