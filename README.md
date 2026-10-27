# Nimbus for Windows

A team of independent AI workers with a shared local inference pool and OpenAI subscription execution through the Codex CLI. Workers have their own instructions, working memory, task histories, artifacts and browser groups. They share model capacity, rather than loading a model for every worker.

This replaces the original execution backend. Nimbus runs independently. **Lumos integration is deliberately disconnected.**

Workers can edit Nimbus itself through a [validated self-update workflow](docs/CAPABILITIES.md#self-updates): source snapshot, exact edits, syntax/tests, supervised restart and a new-process receipt. They also have patching, terminal sessions, task plans, user questions, image input and local skill discovery. **Full Codex parity remains a target, not a completed claim**; see the [capability coverage and remaining integrations](docs/CAPABILITIES.md).

The current registry contains **67 native tools, including 48 specialist tools**, for orchestration, engineering/Git, research/evidence, data/documents/browser audits, and host automation. The [specialist tool directory](docs/TOOLS.md) describes these workflows. Every built-in agent receives tools matched to its role. Use `tool_catalog` inside a worker to inspect its actual enabled tools and connected MCP capabilities.

When a reusable capability is genuinely absent, workers can use the [missing-tool development workflow](docs/TOOL-DEVELOPMENT.md). Nimbus reports the gap at the original request, parks that task, assigns design/build/QA/review work, validates and applies the update, and resumes the task only after installed-tool verification. Access/setup failures are reported separately.

The team includes an Orchestrator and twenty [specialist roles](docs/WORKERS.md), including a GitHub coordinator with five registered subagents. Each has a comprehensive shared system brief, focused workflow and editable model preference. The local router adapts that preference to the task; availability failures can fall back between local and OpenAI execution. Cloud inference uses temporary Codex sessions so Nimbus tasks stay in Nimbus's own history.

The sidebar starts with the Orchestrator. Its disclosure control collapses the whole team branch; inside it are the collapsible Engineering, Quality & Security, Research & Knowledge, Operations, and GitHub display groups, followed by agents. The Orchestrator chat opens separately from its disclosure control. Change a specialist's **Display group** in its settings to organize navigation. Display groups do not restrict communication or tool permissions; existing GitHub subagents retain their hierarchy. Collapse preferences stay in your browser, and collapsed branches retain activity and attention indicators.

This installation exposes remote iPhone access through a Cloudflare Tunnel at [nimbus.jessecopas.com](https://nimbus.jessecopas.com). A new installation needs its own tunnel or reverse proxy. See [remote access](docs/REMOTE-ACCESS.md) for home-screen installation, live updates, authentication and network verification.

## Changes from the base project

Version **0.2.0** builds on base commit [`c373399`](https://github.com/Jessomadic/nimbus/commit/c373399). Development changes are published in separate `feat`, `fix` and documentation commits so each area can be reviewed in Git history.

| Feature area | What changed |
| --- | --- |
| Windows deployment | PowerShell setup, hidden supervisor, graceful stop, optional sign-in startup and protected local credentials replace the Linux/Claude deployment path. See [migration](docs/WINDOWS-MIGRATION.md). |
| Model execution | Shared, resource-guarded LM Studio capacity and Codex subscription execution use task-based routing, explicit model selection and recorded availability fallback. |
| Worker team | An Orchestrator and twenty specialist roles have persistent instructions, independent task checkpoints, delegation and task-result collection. [Worker guide](docs/WORKERS.md). |
| Native tools | Host file/patch tools, resumable terminal sessions, images, plans, user questions, isolated browser groups and engineering, research, content and operations tools. [Tool directory](docs/TOOLS.md). |
| Connectors | Independently configured MCP services expose their discovered tools through the same host approval and journal boundary. |
| Self-maintenance | Source snapshots, exact-hash validation, supervised update/restore and staged development of missing tools. [Capabilities](docs/CAPABILITIES.md), [tool development](docs/TOOL-DEVELOPMENT.md). |
| Dashboard and mobile | Runtime/task evidence, browser previews, collapsible worker groups, passkey management and installable web-app assets. [Remote access](docs/REMOTE-ACCESS.md). |
| Authentication and recovery | Username/password plus required owner passkeys, encrypted portable backups and Windows access controls. [Passkeys](docs/PASSKEYS.md), [security](docs/SECURITY.md). |

Bug-fix commits cover valid JSON redaction, bounded tool attempts and model-input previews, session revocation and live-stream authorization, duplicate scheduled work, startup-script parsing, read-only health-probe failure handling, provider action isolation, and task-history/checkpoint recovery. Regression tests cover these boundaries; fresh automated results and historical live checks are recorded in [verification](docs/VERIFICATION.md).

External connectors, desktop control, generated media, the Hermes/Lumos bridge and Windows Server deployment each have separate setup or verification requirements. The [capability inventory](docs/CAPABILITIES.md) records the remaining gaps.

## Start on this PC

```powershell
.\Setup-Nimbus.ps1
.\Start-Nimbus.ps1
```

Open `http://127.0.0.1:8787` for a fresh local installation, or the configured HTTPS address for remote access. This installation's owner login is **Jessomadic + the existing password + a required passkey**; passkey enrollment requires the configured canonical HTTPS origin. Follow [passkey setup](docs/PASSKEYS.md) for first enrollment, additional keys and owner recovery. To display the generated dashboard password locally:

```powershell
node bin/ui-password.mjs
```

Alternatively, in shared-password mode, `node --env-file-if-exists=.env bin/nimbus.mjs OPEN` issues a one-time local sign-in link. It expires after one minute and is accepted once. Email-account mode requires signing in with an account password. Setup and startup restrict Windows file access to the checkout owner, SYSTEM and administrators; see [security details](docs/SECURITY.md).

`Start-Nimbus.ps1` starts the hidden Windows supervisor. Logs live under `data/`. `Stop-Nimbus.ps1` drains and stops the runtime through its authenticated local endpoint. Optional sign-in startup is installed by `Install-NimbusStartup.ps1`; it uses the current Windows account and does not require administrator rights.

## Requirements

- Windows with Node.js 22.13 or newer and npm.
- Codex CLI available on PATH, or an absolute `cloud.codexBin` in `nimbus.config.json`.
- A ChatGPT subscription login for cloud workers: run `codex login` as the Windows account that runs Nimbus. Nimbus verifies the native account type and does not switch to API-key billing.
- LM Studio and its `lms` CLI for local inference. Start its loopback API server on port 1234. The managed Nimbus pool uses port 12438.
- A local model capable of structured tool calls. The default cold-load model is `google/gemma-4-e4b`.
- An NVIDIA GPU with readable `nvidia-smi` memory measurements for the default resource guard.

No hypervisor is required. Windows Server 2025 is the migration target; see [migration](docs/WINDOWS-MIGRATION.md). This checkout has been exercised on the current Windows PC; Server 2025 needs its own deployment checks. Separate VM desktops are outside this version; Hyper-V can be added later if needed.

## Model routing and shared capacity

The local model selects `local`, `luna`, `terra`, `sol`, or `astra` for automatic tasks, with an effort level and a recorded reason. The initial tier guidance is configurable code in `runtime/router.js`; it is not a measured claim that every tier is better for a particular task. Worker settings can explicitly override the tier.

Cloud family names resolve to exact model IDs advertised by the signed-in Codex account. A catalogue entry is not an entitlement guarantee: a successful turn verifies access. Explicit IDs configured under `cloud.models` are honored, and failures are recorded. The actual model and fallback reason appear in each task's timeline.

The default local pool is **one inference request at a time** across all workers, including the router. It reuses a loaded approved/tool-capable model. When the pool is empty, Nimbus loads its one configured model with a five-minute idle TTL. It never creates one resident model per worker, unloads another application's model, or bypasses the 90% RAM/VRAM ceiling. A cold load also checks conservative projected RAM and VRAM use.

When OpenAI is unavailable or exhausted, tasks use local capacity. When local admission/loading/inference is unavailable, including insufficient RAM or VRAM, Nimbus falls back to the OpenAI subscription. If the local router itself cannot run, the host uses the worker's preferred cloud family, or `routing.cloudFallbackTier` (Luna by default) for Local/no preference. This availability decision is labeled separately from a model-authored routing decision and its cause is recorded. Explicit Local selections also allow this availability fallback. If neither backend can proceed, the task pauses with its checkpoint; uncertain tool actions always remain held for review.

Changing a local/cloud route preserves canonical task history and completed tool results. An action whose outcome is uncertain is held for review. Restarted active tasks are interrupted, not automatically replayed. Queued tasks survive restart.

## Tools and browser groups

Both local and cloud routes use Nimbus's own shell, files, shared notes, worker handoffs, browser and configured MCP tool layer. Cloud inference runs through Codex app-server with native side-effect tools disabled and a read-only native sandbox; Nimbus executes and journals the permitted dynamic tools.

Each worker owns a Playwright browser context: tabs, cookies, local storage and sign-ins are isolated from other workers while sharing a browser process. Requests address a tab within that worker's group. A foreign tab ID is rejected. Browser actions do not use the desktop pointer. The team overview shows group tabs and previews. These are Nimbus browser groups, not tab groups inside your personal Chrome profile.

Workers retain private `MEMORY.md` files and provider-independent instructions in `AGENTS.md`. The `shared_note` tool accesses the explicit `data/shared/` knowledge area. Shell and file tools are powerful host tools, not filesystem sandboxes. Scope workers through their enabled tools, instructions and approval rules.

MCP connectors are configured independently in the Marketplace or `mcpServers` in the local config. They do not inherit another app's connector login. Saved connector credentials and browser storage are protected with Windows DPAPI for the running account. Existing user model credentials can be referenced without copying plaintext into configuration.

## Configuration

Copy `nimbus.config.example.json` to `nimbus.config.json` if setup has not already created it. Active config, `.env`, logs and `data/` are ignored by Git.

Important fields:

- `cloud.models`: family-to-model mappings; `auto` resolves against the native Codex catalogue.
- `local.baseUrl`, `local.model`, `local.approvedModels`, `local.reuseLoaded`.
- `local.managed`: the standalone pool's LM Studio executable, upstream URL, model key, GPU ratio and conservative load forecasts. Set `enabled: false` to use an independently managed compatible endpoint instead.
- `local.tokenDpapiFile`: an existing Windows-DPAPI-protected UTF-8 local-server token; alternatively use the environment variable named by `local.tokenEnv`.
- `workers.maxConcurrent`, `cloud.maxConcurrent`, `workers.maxSteps` and task timeout.
- `browser.headless`, group limit and per-worker tab limit. Browser mode changes require restarting Nimbus.

The managed local service binds only to loopback. The dashboard also defaults to loopback. Set a deliberate host binding and configure TLS/reverse proxy before network access. HTTPS is optional; an externally supplied TLS proxy is appropriate for server deployment.

## Task API

Local scripts use `data/admin.token` through `bin/nimbus.mjs`. The admin token is accepted only from loopback and is not sent to models or connectors.

```powershell
node --env-file-if-exists=.env bin/nimbus.mjs GET /api/runtime
node --env-file-if-exists=.env bin/nimbus.mjs GET /api/tasks
node --env-file-if-exists=.env bin/nimbus.mjs POST /api/tasks '{"worker":"Builder","task":"Create and verify a small artifact","requestId":"my-unique-request"}'
node --env-file-if-exists=.env bin/nimbus.mjs GET /api/runs/1/events
```

`POST /api/tasks` accepts a worker ID/name, task, context, file paths and an idempotency key (`requestId`). Omitting both worker selectors routes to the unique Orchestrator. Each incoming API/Hermes/Lumos job starts with its own supplied context and checkpoint, without importing another job's or human chat's model conversation. Use the same request ID to retrieve the accepted job, or resume that job's own checkpoint. Reusing a key with different data conflicts. Task status, events, resume and cancellation are separate endpoints.

`GET /api/orchestrator` discovers the designated coordinator and its contact contract. `POST /api/orchestrator/tasks` always targets that coordinator, so Hermes/Lumos does not need to store a mutable worker ID or name. Submit `task`, `context`, `files`, `requestId` and `source` (`hermes`, `lumos` or `api`); retain the returned run ID and poll its status/events. Preserve the owning Hermes task correlation in the idempotency key/context, and return results to that task. Keep authentication credentials on the host, outside model prompts. These endpoints prepare the contact; a running Hermes/Lumos adapter and end-to-end delivery remain separately unconfigured and must not be reported as connected.

For an existing installation, preview `node --env-file-if-exists=.env bin/setup-orchestrator.mjs`, then use `--apply` to install the unique coordinator and adopt parentless workers while preserving existing nested relationships and settings. New specialist templates default to the coordinator when it exists; explicit parent choices are retained. Direct cross-agent handoffs remain available.

The coordinator assigns substantial investigation/implementation to specialists rather than spending its tool budget doing their host work. Existing installations can preview `bin/repair-orchestrator.mjs` and apply it with `--apply`; the repair changes only the coordinator's tool assignment and profile instructions. Task details expose actual child tasks and budget counters. Status collection has a separate bounded attempt allowance, and full tool evidence remains retained even when model input uses a partial preview. See [worker recovery](docs/WORKERS.md#tool-budgets-and-recovery) for an audited instruction refresh when resuming an older paused checkpoint.

## Backups and migration

`node --env-file-if-exists=.env bin/backup.mjs` creates an authenticated encrypted `.nbak` archive using AES-256-GCM, a consistent SQLite snapshot, artifacts, configuration and portable connector/browser credentials. Backups are retained under `data/backups/` (last fourteen), with an optional additional local or UNC copy destination.

Export the recovery key to a separate private location before moving machines:

```powershell
node --env-file-if-exists=.env bin/backup.mjs --export-key D:\Private\nimbus-recovery-key.txt
node bin/backup.mjs --restore D:\Backups\nimbus-example.nbak D:\Nimbus-Restore D:\Private\nimbus-recovery-key.txt
```

Restore requires an empty destination. The entire archive is authenticated before extraction. Credentials are protected again for the destination Windows account; native Codex subscription sign-in must be performed on the destination. Do not keep the recovery key alongside a shared backup.

## Verification

Install the locked dependencies with `npm ci` when checking out the project on another machine. Setup also installs dependencies and the browser. Run automated checks before starting verification that uses real models:

```powershell
npm test
npm run doctor
npm run verify:live
# Optional: verify the other cloud families and a cancelled real host action.
node --no-warnings --env-file-if-exists=.env bin/verify-models.mjs
# With the main server stopped (the managed pool port must be free):
node --no-warnings bin/verify-restart.mjs
```

Automated tests use independent temporary state. Live verification requires a running Nimbus server and performs real model/tool tasks in dedicated verification workers, retaining a receipt under `data/verification/`. It consumes normal subscription/local inference capacity. Inspect the receipt rather than treating configuration or a model catalogue as execution proof.

The optional cancellation check deliberately leaves its worker task held for review, with the observed command marker retained. This demonstrates that cancellation cannot silently replay an uncertain action.

## Attribution

This Windows port builds on [Jessomadic/nimbus](https://github.com/Jessomadic/nimbus), whose original documentation credits [Brandon-Rios/nimbus](https://github.com/Brandon-Rios/nimbus). The original Git history and interface identity are preserved.
